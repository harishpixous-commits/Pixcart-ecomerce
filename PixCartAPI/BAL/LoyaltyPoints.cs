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

    /// <summary>Extra points a tier earns on top of the normal rate. 0 for members and while unset.</summary>
    public static int BonusPercent(JsonObject cfg, string tier) => tier == "gold" ? cfg.Int("gold_bonus_percent") : tier == "silver" ? cfg.Int("silver_bonus_percent") : 0;

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
        var lifetime = await uow.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE user_id = @userId AND points > 0", new { userId });
        var bonus = BonusPercent(cfg, Tier(cfg, lifetime));
        points = (int)((long)points * (100 + bonus) / 100);
        await uow.ExecuteAsync(
            "INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @userId, @subId, 'earn', @points, @note, @now)",
            new { id = Guid.NewGuid(), userId, subId, points, note = "Delivered package " + subNumber + (bonus > 0 ? $" (+{bonus}% tier bonus)" : ""), now = DateTime.UtcNow });
        return points;
    }

    /// <summary>Takes back the share of a package's earned points that matches what has been returned (call after returned_total is
    /// updated). Safe to repeat: only the not-yet-reversed part is taken. Never takes the balance below zero. Returns the points taken.</summary>
    public static async Task<int> ReverseForReturnAsync(IUnitOfWork uow, Guid subId, string subNumber, long itemsTotal, long returnedTotal, Guid userId)
    {
        var earned = await uow.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE sub_order_id = @subId AND kind = 'earn'", new { subId });
        if (earned == 0 || itemsTotal == 0) return 0;
        var target = earned * Math.Min(returnedTotal, itemsTotal) / itemsTotal;
        var prefix = "Returned items, package " + subNumber;
        var done = await uow.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(-points),0) FROM loyalty_ledger WHERE user_id = @userId AND kind = 'reverse' AND note LIKE @like", new { userId, like = prefix + "%" });
        var balance = await uow.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE user_id = @userId", new { userId });
        var take = Math.Min(target - done, balance);
        if (take <= 0) return 0;
        await uow.ExecuteAsync("INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @userId, NULL, 'reverse', @points, @note, @now)",
            new { id = Guid.NewGuid(), userId, points = (int)-take, note = prefix, now = DateTime.UtcNow });
        return (int)take;
    }

    public const int RedeemDays = 30;
    public const string CodePrefix = "LP";

    private static async Task<JsonObject> LoyaltyCfgAsync(IUnitOfWork uow)
    {
        var saved = JsonHelper.Object(await uow.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        return (JsonObject)DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), saved)["loyalty"]!;
    }

    /// <summary>Turns points into a single-use platform-funded flat coupon, applied at checkout like any coupon (mirror of loyalty.redeem).
    /// The cart must be at least discount / max_redeem_percent. Unused after 30 days: the points come back.</summary>
    public static async Task<JsonObject> RedeemAsync(IUnitOfWork uow, Guid userId, int points)
    {
        var cfg = await LoyaltyCfgAsync(uow);
        if (!cfg.Bool("enabled")) throw new AppException("Loyalty points are not available right now.", "loyalty_off");
        if (points < cfg.Int("min_redeem_points")) throw new AppException($"Redeem at least {cfg.Int("min_redeem_points")} points at a time.", "below_minimum");
        await RestoreExpiredAsync(uow, userId);
        var balance = await uow.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE user_id = @userId FOR UPDATE", new { userId });
        if (points > balance) throw new AppException("You do not have that many points.", "balance_too_low");
        var discount = (long)points * cfg.Int("point_value_paise");
        var minOrder = (discount * 100 + cfg.Int("max_redeem_percent") - 1) / cfg.Int("max_redeem_percent");
        var now = DateTime.UtcNow;
        var code = CodePrefix + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(4));
        await uow.ExecuteAsync(
            "INSERT INTO coupons (id, code, description, kind, value, min_order_paise, ends_at, usage_limit, per_user_limit, used_count, funded_by, first_order_only, is_active, show_on_checkout, only_user_id) " +
            "VALUES (@id, @code, 'Loyalty points', 'flat', @discount, @minOrder, @ends, 1, 1, 0, 'platform', 0, 1, 0, @userId)",
            new { id = Guid.NewGuid(), userId, code, discount, minOrder, ends = now.AddDays(RedeemDays) });
        await uow.ExecuteAsync("INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @userId, NULL, 'redeem', @points, @note, @now)",
            new { id = Guid.NewGuid(), userId, points = -points, note = "Redeemed for coupon " + code, now });
        return new JsonObject { ["code"] = code, ["discount_paise"] = discount, ["min_order_paise"] = minOrder, ["valid_days"] = RedeemDays, ["balance"] = balance - points };
    }

    /// <summary>Gives back the points of a redeemed coupon that ran out unused (once per coupon).</summary>
    public static async Task<int> RestoreExpiredAsync(IUnitOfWork uow, Guid userId)
    {
        var now = DateTime.UtcNow; var back = 0;
        var rows = await uow.QueryAsync<(int Points, string Note)>("SELECT points AS Points, note AS Note FROM loyalty_ledger WHERE user_id = @userId AND kind = 'redeem'", new { userId });
        foreach (var (pts, note) in rows.ToList())
        {
            var code = note[(note.LastIndexOf(' ') + 1)..];
            if (!code.StartsWith(CodePrefix)) continue;
            var marker = $"Coupon {code} expired unused";
            if (await uow.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM loyalty_ledger WHERE user_id = @userId AND kind = 'reverse' AND note = @marker", new { userId, marker }) > 0) continue;
            var live = await uow.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM coupons WHERE code = @code AND used_count = 0 AND ends_at IS NOT NULL AND ends_at <= @now", new { code, now });
            if (live == 0) continue;
            await uow.ExecuteAsync("INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @userId, NULL, 'reverse', @points, @marker, @now)",
                new { id = Guid.NewGuid(), userId, points = -pts, marker, now });
            back += -pts;
        }
        return back;
    }
}
