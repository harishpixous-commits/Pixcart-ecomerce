using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Saved searches (mirror of services/saved_searches.py). Off unless switched on in Admin → Growth. A signed-in shopper follows a
/// search; a job tells them in the app when a product approved since the last check matches every word in its title or brand and is within the
/// price limit. At most one note per search every min_hours_between_alerts, carrying the count of new matches.</summary>
public static class SavedSearches
{
    public static List<string> Terms(string q) => Regex.Matches((q ?? "").ToLowerInvariant(), @"\w+").Select(m => m.Value).Where(t => t.Length >= 2).Take(6).ToList();

    static async Task<JsonObject> CfgAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        return (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["saved_searches"]!;
    }

    static JsonObject Out(Guid id, string q, long? max, DateTime created, DateTime? notified) => new()
    {
        ["id"] = id.ToString(), ["query"] = q, ["max_price_paise"] = max, ["created_at"] = created.ToString("o"), ["last_notified_at"] = notified?.ToString("o"),
    };

    public static async Task<JsonObject> ListAsync(IMySqlDapperHelper db, Guid userId)
    {
        var cfg = await CfgAsync(db);
        var rows = await db.QueryAsync<(Guid Id, string Q, long? Max, DateTime Created, DateTime? Notified)>(
            "SELECT id AS Id, query AS Q, max_price_paise AS Max, created_at AS Created, last_notified_at AS Notified FROM saved_searches WHERE user_id = @userId ORDER BY created_at DESC", new { userId });
        return new JsonObject { ["enabled"] = cfg.Bool("enabled"), ["max_per_user"] = cfg.Int("max_per_user"), ["items"] = new JsonArray(rows.Select(r => (JsonNode)Out(r.Id, r.Q, r.Max, r.Created, r.Notified)).ToArray()) };
    }

    public static async Task<JsonObject> AddAsync(IMySqlDapperHelper db, Guid userId, string query, long? maxPaise)
    {
        var cfg = await CfgAsync(db);
        if (!cfg.Bool("enabled")) throw new AppException("Saved searches are switched off", "saved_searches_off", 400);
        query = string.Join(' ', (query ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (Terms(query).Count == 0) throw new AppException("Type at least one word to follow", "invalid_query", 400);
        if (maxPaise is < 100) throw new AppException("The price limit must be at least 1 rupee", "invalid_price", 400);
        if (query.Length > 120) query = query[..120];
        await using var tx = await db.BeginAsync();
        await tx.QueryFirstOrDefaultAsync<Guid>("SELECT id FROM users WHERE id = @userId FOR UPDATE", new { userId });
        var mine = (await tx.QueryAsync<(Guid Id, string Q, long? Max, DateTime Created, DateTime? Notified)>(
            "SELECT id AS Id, query AS Q, max_price_paise AS Max, created_at AS Created, last_notified_at AS Notified FROM saved_searches WHERE user_id = @userId", new { userId })).ToList();
        var same = mine.FirstOrDefault(r => string.Equals(r.Q, query, StringComparison.OrdinalIgnoreCase) && r.Max == maxPaise);
        if (same.Id != Guid.Empty) { await tx.CommitAsync(); return Out(same.Id, same.Q, same.Max, same.Created, same.Notified); }
        var limit = cfg.Int("max_per_user");
        if (mine.Count >= limit) throw new AppException($"You can follow up to {limit} searches", "too_many_searches", 400);
        var id = Guid.NewGuid(); var now = DateTime.UtcNow;
        await tx.ExecuteAsync("INSERT INTO saved_searches (id, user_id, query, max_price_paise, created_at, last_checked_at) VALUES (@id, @userId, @query, @maxPaise, @now, @now)", new { id, userId, query, maxPaise, now });
        await tx.CommitAsync();
        return Out(id, query, maxPaise, now, null);
    }

    public static Task RemoveAsync(IMySqlDapperHelper db, Guid userId, Guid id) =>
        db.ExecuteAsync("DELETE FROM saved_searches WHERE id = @id AND user_id = @userId", new { id, userId });

    public static async Task<int> SendMatchesAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify, int batch = 300)
    {
        var cfg = await CfgAsync(db);
        if (!cfg.Bool("enabled")) return 0;
        var now = DateTime.UtcNow; var quiet = now.AddHours(-cfg.Int("min_hours_between_alerts"));
        var rows = (await db.QueryAsync<(Guid Id, Guid UserId, string Q, long? Max, DateTime Checked)>(
            "SELECT id AS Id, user_id AS UserId, query AS Q, max_price_paise AS Max, last_checked_at AS Checked FROM saved_searches WHERE last_notified_at IS NULL OR last_notified_at <= @quiet ORDER BY last_checked_at LIMIT @batch", new { quiet, batch })).ToList();
        var sent = 0;
        foreach (var r in rows)
        {
            var sql = "SELECT title FROM products WHERE status = 'approved' AND (publish_at IS NULL OR publish_at <= UTC_TIMESTAMP(6)) AND price_from > 0 AND approved_at > @since AND seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)";
            var p = new Dictionary<string, object> { ["since"] = r.Checked };
            var i = 0;
            foreach (var t in Terms(r.Q)) { sql += $" AND (LOWER(title) LIKE @t{i} OR LOWER(brand) LIKE @t{i})"; p[$"t{i}"] = "%" + t.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%"; i++; }
            if (r.Max is not null) { sql += " AND price_from <= @max"; p["max"] = r.Max.Value; }
            var found = (await db.QueryAsync<string>(sql + " ORDER BY approved_at DESC LIMIT 50", p)).ToList();
            await db.ExecuteAsync("UPDATE saved_searches SET last_checked_at = @now WHERE id = @id", new { now, id = r.Id });
            if (found.Count == 0) continue;
            await notify.NotifyUserAsync(r.UserId, "saved_search_match", new Dictionary<string, string>
            {
                ["query"] = r.Q, ["count"] = found.Count.ToString(), ["item"] = found[0], ["more"] = found.Count > 1 ? $" and {found.Count - 1} more" : "",
            }, "/search?q=" + Uri.EscapeDataString(r.Q).Replace("%20", "+"));
            await db.ExecuteAsync("UPDATE saved_searches SET last_notified_at = @now WHERE id = @id", new { now, id = r.Id });
            sent++;
        }
        return sent;
    }
}
