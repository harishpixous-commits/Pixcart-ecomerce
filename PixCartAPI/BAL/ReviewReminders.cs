using System.Text.Json.Nodes;
using BAL.Interface;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Review reminders (mirror of services/review_reminders.py). Off unless switched on in Admin → Growth. One in-app note per delivered
/// package, after_days after delivery, when the shopper has reviewed nothing in it yet. Packages delivered more than max_age_days ago are skipped.</summary>
public static class ReviewReminders
{
    public static async Task<int> SendDueAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify, int batch = 200)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["review_reminders"]!;
        if (!cfg.Bool("enabled")) return 0;
        var now = DateTime.UtcNow; var due = now.AddDays(-cfg.Int("after_days")); var oldest = now.AddDays(-cfg.Int("max_age_days"));
        var rows = (await db.QueryAsync<(Guid Id, Guid OrderId, Guid UserId)>(
            "SELECT s.id AS Id, s.order_id AS OrderId, o.user_id AS UserId FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE s.status = 'delivered' AND s.review_reminded_at IS NULL AND s.delivered_at <= @due AND s.delivered_at >= @oldest ORDER BY s.delivered_at LIMIT @batch",
            new { due, oldest, batch })).ToList();
        var sent = 0;
        foreach (var r in rows)
        {
            await db.ExecuteAsync("UPDATE sub_orders SET review_reminded_at = @now WHERE id = @id", new { now, id = r.Id }); // once, whether or not a note goes out
            var item = await db.QueryFirstOrDefaultAsync<string>(
                "SELECT i.title FROM order_items i WHERE i.sub_order_id = @id AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.user_id = @userId AND v.product_id = i.product_id) ORDER BY i.title LIMIT 1", new { id = r.Id, userId = r.UserId });
            if (item is null) continue;
            await notify.NotifyUserAsync(r.UserId, "review_reminder", new Dictionary<string, string> { ["item"] = item }, $"/orders/{r.OrderId}");
            sent++;
        }
        return sent;
    }
}
