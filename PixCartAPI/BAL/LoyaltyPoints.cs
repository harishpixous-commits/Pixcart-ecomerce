using BAL.Interface;
using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Loyalty points (mirror of services/loyalty.py). Points are earned once per delivered package: points_per_100 for
/// every full 100 rupees of goods (items total). Off unless staff switch loyalty on in Admin → Growth.</summary>
public static class LoyaltyPoints
{
    public static string Tier(JsonObject cfg, long lifetime) =>
        cfg.Int("tier_gold_points") > 0 && lifetime >= cfg.Int("tier_gold_points") ? "gold"
        : cfg.Int("tier_silver_points") > 0 && lifetime >= cfg.Int("tier_silver_points") ? "silver" : "member";

    /// <summary>Credits the points for a delivered package inside the caller's transaction. Returns the points credited.</summary>
    public static async Task<int> EarnAsync(IUnitOfWork uow, Guid subId, string subNumber, long itemsTotal, Guid userId)
    {
        var saved = JsonHelper.Object(await uow.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), saved)["loyalty"]!;
        if (!cfg.Bool("enabled") || cfg.Int("points_per_100") == 0) return 0;
        var points = (int)(itemsTotal / 10000 * cfg.Int("points_per_100"));
        if (points <= 0) return 0;
        var done = await uow.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM loyalty_ledger WHERE sub_order_id = @subId AND kind = 'earn'", new { subId });
        if (done > 0) return 0;
        await uow.ExecuteAsync(
            "INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @userId, @subId, 'earn', @points, @note, @now)",
            new { id = Guid.NewGuid(), userId, subId, points, note = "Delivered package " + subNumber, now = DateTime.UtcNow });
        return points;
    }
}
