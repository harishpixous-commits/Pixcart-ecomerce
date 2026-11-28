using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Coupons and their redemptions (reference: the coupon queries of services/coupons.py).</summary>
public class CouponDAL(IMySqlDapperHelper db)
{
    /// <summary>The coupon with this code, case-insensitive.</summary>
    public Task<CouponModel?> ByCodeAsync(string code) =>
        db.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE UPPER(code) = @code", new { code });

    /// <summary>The saved Growth settings JSON (platform_settings.growth), or null when nothing was saved.</summary>
    public Task<string?> GrowthJsonAsync() =>
        db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'");

    /// <summary>Active platform coupons marked automatic.</summary>
    public Task<IEnumerable<CouponModel>> AutomaticAsync() =>
        db.QueryAsync<CouponModel>("SELECT * FROM coupons WHERE is_automatic = 1 AND is_active = 1 AND funded_by = 'platform' AND only_user_id IS NULL LIMIT 50");

    /// <summary>Redemptions in use by this shopper (not released).</summary>
    public async Task<long> RedemptionsAsync(Guid couponId, Guid userId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = @couponId AND user_id = @userId AND released = 0",
            new { couponId, userId });

    /// <summary>The shopper's placed orders (for first-order-only coupons).</summary>
    public async Task<long> PlacedOrdersAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM orders WHERE user_id = @userId AND status = 'placed'", new { userId });

    /// <summary>Active coupons shown at checkout, newest first, at most 10.</summary>
    public Task<IEnumerable<CouponModel>> ForCheckoutAsync() =>
        db.QueryAsync<CouponModel>(
            """
            SELECT * FROM coupons
            WHERE is_active = 1 AND show_on_checkout = 1
              AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP(6))
              AND (ends_at IS NULL OR ends_at >= UTC_TIMESTAMP(6))
            ORDER BY created_at DESC LIMIT 10
            """);
}
