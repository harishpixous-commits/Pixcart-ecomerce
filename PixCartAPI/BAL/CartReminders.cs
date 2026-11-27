using BAL.Interface;
using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Abandoned-cart reminders (mirror of services/cart_reminders.py). A cart is abandoned when its newest change is older
/// than first_reminder_hours, it is worth at least min_cart_paise and the customer has not ordered since. Stage 1 goes after
/// first_reminder_hours, stage 2 after second_reminder_hours, a further stage after another second_reminder_hours each, up to
/// max_reminders. Only customers who opted in to marketing messages get one. Changing the cart starts the stages again.
/// Off unless staff switch it on in Admin → Growth.</summary>
public static class CartReminders
{
    public const int Batch = 200;
    public static int DueHours(JsonObject cfg, int stage) => stage == 1 ? cfg.Int("first_reminder_hours") : cfg.Int("second_reminder_hours") * (stage - 1);

    public static async Task<int> SendDueAsync(IMySqlDapperHelper db, ICatalogNotifyBAL notify)
    {
        var saved = JsonHelper.Object(await db.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), saved)["abandoned_cart"]!;
        if (!cfg.Bool("enabled")) return 0;
        var now = DateTime.UtcNow;
        var carts = (await db.QueryAsync<(Guid UserId, DateTime Last)>(
            "SELECT user_id AS UserId, MAX(updated_at) AS Last FROM cart_items GROUP BY user_id HAVING MAX(updated_at) <= @cutoff LIMIT " + Batch,
            new { cutoff = now.AddHours(-cfg.Int("first_reminder_hours")) })).ToList();
        var sent = 0;
        foreach (var (userId, last) in carts)
        {
            var ok = await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM users WHERE id = @userId AND deleted_at IS NULL AND is_active = 1 AND marketing_opt_in = 1", new { userId });
            if (ok == 0) continue;
            if (await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM orders WHERE user_id = @userId AND created_at >= @last", new { userId, last }) > 0) continue;
            var done = await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM cart_reminders WHERE user_id = @userId AND sent_at >= @last", new { userId, last });
            var stage = done + 1;
            if (stage > cfg.Int("max_reminders") || now < last.AddHours(DueHours(cfg, stage))) continue;
            var lines = (await db.QueryAsync<(int Qty, long Price, string Title)>(
                "SELECT c.qty AS Qty, v.price_paise AS Price, p.title AS Title FROM cart_items c JOIN variants v ON v.id = c.variant_id JOIN products p ON p.id = v.product_id " +
                "WHERE c.user_id = @userId AND v.is_active = 1 AND p.status = 'approved' ORDER BY c.created_at", new { userId })).ToList();
            var total = lines.Sum(l => l.Qty * l.Price);
            if (lines.Count == 0 || total < cfg.Int("min_cart_paise")) continue;
            await db.ExecuteAsync("INSERT INTO cart_reminders (id, user_id, stage, cart_paise, sent_at) VALUES (@id, @userId, @stage, @total, @now)",
                new { id = Guid.NewGuid(), userId, stage, total = (int)total, now });
            var coupon = (cfg["offer_coupon"]?.GetValue<string>() ?? "").Trim();
            await notify.NotifyUserAsync(userId, "abandoned_cart", new Dictionary<string, string>
            {
                ["item"] = lines[0].Title, ["more"] = lines.Count > 1 ? $" and {lines.Count - 1} more" : "",
                ["amount"] = "₹" + (total / 100m).ToString("N2", System.Globalization.CultureInfo.InvariantCulture),
                ["offer"] = coupon.Length > 0 ? $" Use code {coupon} at checkout." : "",
            }, "/cart");
            sent++;
        }
        return sent;
    }

    private sealed record LogRow(Guid Id, string Name, string? Phone, string? Email, int Stage, int CartPaise, DateTime SentAt, long Ordered);

    /// <summary>What staff see: the latest reminders sent and whether the customer ordered after each one.</summary>
    public static async Task<JsonObject> RecentAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), saved)["abandoned_cart"]!;
        var sent30 = await db.QueryFirstOrDefaultAsync<long>("SELECT COUNT(*) FROM cart_reminders WHERE sent_at >= @since", new { since = DateTime.UtcNow.AddDays(-30) });
        var rows = (await db.QueryAsync<LogRow>(
            "SELECT r.id AS Id, u.name AS Name, u.phone AS Phone, u.email AS Email, r.stage AS Stage, r.cart_paise AS CartPaise, r.sent_at AS SentAt, " +
            "EXISTS(SELECT 1 FROM orders o WHERE o.user_id = r.user_id AND o.created_at >= r.sent_at) AS Ordered " +
            "FROM cart_reminders r JOIN users u ON u.id = r.user_id ORDER BY r.sent_at DESC LIMIT 100")).ToList();
        return new JsonObject
        {
            ["enabled"] = cfg.Bool("enabled"), ["sent_30d"] = sent30, ["ordered_after"] = rows.Count(r => r.Ordered != 0),
            ["items"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject
            {
                ["id"] = r.Id.ToString(), ["customer"] = r.Name, ["contact"] = r.Phone ?? r.Email, ["stage"] = r.Stage, ["cart_paise"] = r.CartPaise,
                ["sent_at"] = r.SentAt.ToString("o"), ["ordered_after"] = r.Ordered != 0,
            }).ToArray()),
        };
    }
}
