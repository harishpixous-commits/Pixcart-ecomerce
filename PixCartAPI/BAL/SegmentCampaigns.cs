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
    public static async Task<JsonObject> SendAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify, UserModel admin, string segment, string title, string message, string link, bool dryRun)
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
        var today = await db.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM segment_campaigns WHERE created_at >= @since", new { since = now.AddHours(-24) });
        var perDay = int.Parse(cfg["max_per_day"]!.ToString());
        if (today >= perDay) throw new AppException($"Limit reached: {perDay} campaigns in 24 hours", "campaign_limit", 400);
        var id = Guid.NewGuid();
        await db.ExecuteAsync("INSERT INTO segment_campaigns (id, segment, title, message, link, recipients, created_by, created_at) VALUES (@id, @segment, @title, @message, @link, @n, @by, @now)",
            new { id, segment, title, message, link, n = ids.Count, by = admin.Id, now });
        foreach (var uid in ids) await notify.NotifyUserAsync(uid, "marketing_message", new Dictionary<string, string> { ["title"] = title, ["message"] = message }, link);
        await db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'campaign.send', 'segment', @segment, @d, UTC_TIMESTAMP(6), @aid)",
            new { by = admin.Id, segment, d = $"{(title.Length > 60 ? title[..60] : title)} x{ids.Count}", aid = Guid.NewGuid() });
        o["id"] = id.ToString();
        return o;
    }

    public static async Task<JsonObject> RecentAsync(IMySqlDapperHelper db)
    {
        var rows = await db.QueryAsync<(Guid Id, string Segment, string Title, string Message, string Link, int Recipients, DateTime At)>(
            "SELECT id AS Id, segment AS Segment, title AS Title, message AS Message, link AS Link, recipients AS Recipients, created_at AS At FROM segment_campaigns ORDER BY created_at DESC LIMIT 50");
        return new JsonObject { ["items"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject { ["id"] = r.Id.ToString(), ["segment"] = r.Segment, ["title"] = r.Title, ["message"] = r.Message, ["link"] = r.Link, ["recipients"] = r.Recipients, ["at"] = DateTime.SpecifyKind(r.At, DateTimeKind.Utc).ToString("o") }).ToArray()) };
    }
}
