using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Staff send one in-app message to a customer segment (mirror of services/campaigns.py). Off unless switched on in Admin → Growth.
/// Only customers who opted in to marketing get it, only in the app, at most max_recipients per send (biggest spenders first) and at
/// most max_per_day sends in 24 hours. A preview (dry_run, the default) counts the people and sends nothing. Every send is logged.</summary>
public static class SegmentCampaigns
{
    public static async Task<JsonObject> SendAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify, UserModel admin, string segment, string title, string message, string link, bool dryRun, DateTime? sendAt = null)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var all = DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved);
        var cfg = (JsonObject)all["campaigns"]!; var seg = (JsonObject)all["segments"]!;
        if (cfg["enabled"]?.GetValue<bool>() != true) throw new AppException("Campaigns are switched off. Turn them on in Admin > Growth.", "campaigns_off", 400);
        if (seg["enabled"]?.GetValue<bool>() != true) throw new AppException("Customer segments are switched off. Turn them on in Admin > Growth.", "segments_off", 400);
        if (!Segments.Labels.ContainsKey(segment)) throw new AppException("Unknown segment", "invalid_segment", 400);
        title = (title ?? "").Trim(); message = (message ?? "").Trim(); link = (link ?? "").Trim();
        if (title.Length == 0 || message.Length == 0) throw new AppException("A title and a message are needed", "invalid_message", 400);
        if (title.Length > 80 || message.Length > 300 || link.Length > 200) throw new AppException("Title, message or link is too long", "invalid_message", 400);
        if (link.Length > 0 && !(link.StartsWith('/') && !link.StartsWith("//"))) throw new AppException("The link must be a page on this store, like /offers", "invalid_link", 400);
        var max = int.Parse(cfg["max_recipients"]!.ToString());
        var now = DateTime.UtcNow;
        var p = new { newSince = now.AddDays(-int.Parse(seg["new_days"]!.ToString())), vip = long.Parse(seg["vip_spend_paise"]!.ToString()), lapsedBefore = now.AddDays(-int.Parse(seg["lapsed_days"]!.ToString())) };
        var ids = (await db.QueryAsync<Guid>(Segments.Base + $"SELECT id FROM c WHERE {Segments.Where[segment]} AND marketing_opt_in = 1 ORDER BY spent DESC, created_at DESC LIMIT 5000", p)).ToList();
        var total = ids.Count; ids = ids.Take(max).ToList();
        var o = new JsonObject { ["dry_run"] = dryRun, ["segment"] = segment, ["opted_in"] = total, ["recipients"] = ids.Count, ["capped"] = total > ids.Count };
        if (dryRun) return o;
        var today = await db.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM segment_campaigns WHERE created_at >= @since AND status <> 'cancelled'", new { since = now.AddHours(-24) });
        var perDay = int.Parse(cfg["max_per_day"]!.ToString());
        if (today >= perDay) throw new AppException($"Limit reached: {perDay} campaigns in 24 hours", "campaign_limit", 400);
        var id = Guid.NewGuid();
        if (sendAt is { } at)
        {
            // Held until the time comes; the list is worked out again then, so people who opted out meanwhile are left out.
            var when = at.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(at, DateTimeKind.Utc) : at.ToUniversalTime();
            if (when < now.AddMinutes(2) || when > now.AddDays(30)) throw new AppException("Pick a time between 2 minutes and 30 days from now", "invalid_send_at", 400);
            await db.ExecuteAsync("INSERT INTO segment_campaigns (id, segment, title, message, link, recipients, created_by, created_at, status, send_at) VALUES (@id, @segment, @title, @message, @link, 0, @by, @now, 'scheduled', @when)",
                new { id, segment, title, message, link, by = admin.Id, now, when });
            await db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'campaign.schedule', 'segment', @segment, @d, UTC_TIMESTAMP(6), @aid)",
                new { by = admin.Id, segment, d = $"{(title.Length > 60 ? title[..60] : title)} x{ids.Count}", aid = Guid.NewGuid() });
            o["id"] = id.ToString(); o["scheduled"] = true; o["send_at"] = when.ToString("o");
            return o;
        }
        await db.ExecuteAsync("INSERT INTO segment_campaigns (id, segment, title, message, link, recipients, created_by, created_at) VALUES (@id, @segment, @title, @message, @link, @n, @by, @now)",
            new { id, segment, title, message, link, n = ids.Count, by = admin.Id, now });
        foreach (var uid in ids) await notify.NotifyUserAsync(uid, "marketing_message", new Dictionary<string, string> { ["title"] = title, ["message"] = message }, link);
        await db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'campaign.send', 'segment', @segment, @d, UTC_TIMESTAMP(6), @aid)",
            new { by = admin.Id, segment, d = $"{(title.Length > 60 ? title[..60] : title)} x{ids.Count}", aid = Guid.NewGuid() });
        o["id"] = id.ToString();
        return o;
    }

    /// <summary>Job: deliver scheduled campaigns whose time has come (mirror of campaigns.send_due). Held, not lost, while campaigns or segments are off.</summary>
    public static async Task<int> SendDueAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify, int limit = 5)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var all = DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved);
        var cfg = (JsonObject)all["campaigns"]!; var seg = (JsonObject)all["segments"]!;
        if (!cfg.Bool("enabled") || !seg.Bool("enabled")) return 0;
        var now = DateTime.UtcNow;
        var due = (await db.QueryAsync<(Guid Id, string Segment, string Title, string Message, string Link)>(
            "SELECT id AS Id, segment AS Segment, title AS Title, message AS Message, link AS Link FROM segment_campaigns WHERE status = 'scheduled' AND send_at <= @now ORDER BY send_at LIMIT @limit", new { now, limit })).ToList();
        var p = new { newSince = now.AddDays(-seg.Int("new_days")), vip = long.Parse(seg["vip_spend_paise"]!.ToString()), lapsedBefore = now.AddDays(-seg.Int("lapsed_days")) };
        var done = 0;
        foreach (var r in due)
        {
            if (!Segments.Where.ContainsKey(r.Segment)) continue;
            // Claim it first so two workers never send the same campaign.
            if (await db.ExecuteAsync("UPDATE segment_campaigns SET status = 'sending' WHERE id = @id AND status = 'scheduled'", new { id = r.Id }) == 0) continue;
            var ids = (await db.QueryAsync<Guid>(Segments.Base + $"SELECT id FROM c WHERE {Segments.Where[r.Segment]} AND marketing_opt_in = 1 ORDER BY spent DESC, created_at DESC LIMIT {cfg.Int("max_recipients")}", p)).ToList();
            foreach (var uid in ids) await notify.NotifyUserAsync(uid, "marketing_message", new Dictionary<string, string> { ["title"] = r.Title, ["message"] = r.Message }, r.Link);
            await db.ExecuteAsync("UPDATE segment_campaigns SET status = 'sent', recipients = @n WHERE id = @id", new { n = ids.Count, id = r.Id });
            done++;
        }
        return done;
    }

    public static async Task<bool> CancelAsync(IMySqlDapperHelper db, UserModel admin, Guid id)
    {
        var n = await db.ExecuteAsync("UPDATE segment_campaigns SET status = 'cancelled' WHERE id = @id AND status = 'scheduled'", new { id });
        if (n == 0) return false;
        await db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'campaign.cancel', 'segment', @e, '', UTC_TIMESTAMP(6), @aid)", new { by = admin.Id, e = id.ToString(), aid = Guid.NewGuid() });
        return true;
    }

    public static async Task<JsonObject> RecentAsync(IMySqlDapperHelper db)
    {
        var rows = await db.QueryAsync<(Guid Id, string Segment, string Title, string Message, string Link, int Recipients, DateTime At, string Status, DateTime? SendAt)>(
            "SELECT id AS Id, segment AS Segment, title AS Title, message AS Message, link AS Link, recipients AS Recipients, created_at AS At, status AS Status, send_at AS SendAt FROM segment_campaigns ORDER BY created_at DESC LIMIT 50");
        return new JsonObject { ["items"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject { ["id"] = r.Id.ToString(), ["segment"] = r.Segment, ["title"] = r.Title, ["message"] = r.Message, ["link"] = r.Link, ["recipients"] = r.Recipients, ["at"] = DateTime.SpecifyKind(r.At, DateTimeKind.Utc).ToString("o"), ["status"] = r.Status, ["send_at"] = r.SendAt is { } sa ? DateTime.SpecifyKind(sa, DateTimeKind.Utc).ToString("o") : null }).ToArray()) };
    }
}
