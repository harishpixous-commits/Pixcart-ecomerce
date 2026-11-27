using System.Text.Json.Nodes;
using BAL.Interface;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Ship reminders (mirror of services/ship_reminders.py). Off unless switched on in Admin → Growth. One in-app note to the seller per
/// package that is confirmed or packed but not shipped after_hours since confirmation. Packages confirmed more than max_age_days ago are skipped.</summary>
public static class ShipReminders
{
    public static async Task<int> SendDueAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify, int batch = 200)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["ship_reminders"]!;
        if (!cfg.Bool("enabled")) return 0;
        var now = DateTime.UtcNow; var due = now.AddHours(-cfg.Int("after_hours")); var oldest = now.AddDays(-cfg.Int("max_age_days"));
        var rows = (await db.QueryAsync<(Guid Id, Guid SellerId, string Number, DateTime ConfirmedAt)>(
            "SELECT id AS Id, seller_id AS SellerId, number AS Number, confirmed_at AS ConfirmedAt FROM sub_orders WHERE status IN ('confirmed', 'packed') AND ship_reminded_at IS NULL AND confirmed_at <= @due AND confirmed_at >= @oldest ORDER BY confirmed_at LIMIT @batch",
            new { due, oldest, batch })).ToList();
        foreach (var r in rows)
        {
            await db.ExecuteAsync("UPDATE sub_orders SET ship_reminded_at = @now WHERE id = @id", new { now, id = r.Id }); // once, whether or not a note goes out
            var hours = (int)(now - DateTime.SpecifyKind(r.ConfirmedAt, DateTimeKind.Utc)).TotalHours;
            await notify.NotifySellerAsync(r.SellerId, "seller_ship_reminder", new Dictionary<string, string> { ["order_number"] = r.Number, ["hours"] = hours.ToString() }, $"/seller/orders/{r.Id}");
        }
        return rows.Count;
    }
}
