using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Platform coupon administration (reference: routers/admin_extras.py coupons endpoints and
/// routers/seller_extras.py coupon_admin_out/_check_coupon_values).
/// </summary>
public class CouponAdminBAL(IAccessBAL access, IMySqlDapperHelper db) : ICouponAdminBAL
{
    private static async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, string code, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'coupon', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, eid = code, detail, id = Guid.NewGuid() });

    /// <summary>Reference: _check_coupon_values.</summary>
    internal static void CheckValues(string kind, int value)
    {
        if (kind == "percent" && value is < 100 or > 9000)
            throw new AppException("A percentage coupon must be between 1% and 90%", "invalid_value");
    }

    /// <summary>Reference: coupon_admin_out.</summary>
    public static JsonObject AdminOut(CouponModel c) => new()
    {
        ["id"] = c.Id.ToString(), ["code"] = c.Code, ["description"] = c.Description, ["kind"] = c.Kind,
        ["value"] = c.Value, ["max_discount_paise"] = c.MaxDiscountPaise, ["min_order_paise"] = c.MinOrderPaise,
        ["starts_at"] = c.StartsAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
        ["ends_at"] = c.EndsAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
        ["usage_limit"] = c.UsageLimit, ["per_user_limit"] = c.PerUserLimit, ["used_count"] = c.UsedCount,
        ["funded_by"] = c.FundedBy, ["seller_id"] = c.SellerId?.ToString(), ["category_id"] = c.CategoryId?.ToString(),
        ["first_order_only"] = c.FirstOrderOnly, ["is_active"] = c.IsActive, ["show_on_checkout"] = c.ShowOnCheckout,
    };

    public async Task<JsonObject> CreateAsync(UserModel admin, string code, string description, string kind, int value,
        long? maxDiscountPaise, long minOrderPaise, DateTime? startsAt, DateTime? endsAt, int? usageLimit,
        int perUserLimit, bool isActive, Guid? categoryId, bool firstOrderOnly, bool showOnCheckout)
    {
        await access.RequireAsync(admin, "marketing");
        CheckValues(kind, value);
        code = code.ToUpperInvariant();
        await using var uow = await db.BeginAsync();
        if (await uow.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM coupons WHERE UPPER(code) = @code", new { code }) > 0)
            throw new ConflictException("This code is already used", "code_taken");
        var c = new CouponModel
        {
            Code = code, Description = description, Kind = kind, Value = value, MaxDiscountPaise = maxDiscountPaise,
            MinOrderPaise = minOrderPaise, StartsAt = startsAt, EndsAt = endsAt, UsageLimit = usageLimit,
            PerUserLimit = perUserLimit, UsedCount = 0, FundedBy = "platform", CategoryId = categoryId,
            FirstOrderOnly = firstOrderOnly, IsActive = isActive, ShowOnCheckout = showOnCheckout,
            Id = Guid.NewGuid(), CreatedAt = DateTimeFunctions.UtcNow(), UpdatedAt = DateTimeFunctions.UtcNow(),
        };
        await uow.ExecuteAsync(
            "INSERT INTO coupons (code, description, kind, value, max_discount_paise, min_order_paise, starts_at, ends_at, " +
            "usage_limit, per_user_limit, used_count, funded_by, seller_id, category_id, first_order_only, is_active, " +
            "show_on_checkout, id, created_at, updated_at) VALUES (@Code, @Description, @Kind, @Value, @MaxDiscountPaise, " +
            "@MinOrderPaise, @StartsAt, @EndsAt, @UsageLimit, @PerUserLimit, @UsedCount, @FundedBy, @SellerId, @CategoryId, " +
            "@FirstOrderOnly, @IsActive, @ShowOnCheckout, @Id, @CreatedAt, @UpdatedAt)", c);
        await AuditAsync(uow, admin, "coupon.create", c.Code);
        await uow.CommitAsync();
        return AdminOut(c);
    }

    public async Task<JsonObject> UpdateAsync(UserModel admin, Guid couponId, string description, string kind, int value,
        long? maxDiscountPaise, long minOrderPaise, DateTime? startsAt, DateTime? endsAt, int? usageLimit,
        int perUserLimit, bool isActive, Guid? categoryId, bool firstOrderOnly, bool showOnCheckout)
    {
        await access.RequireAsync(admin, "marketing");
        CheckValues(kind, value);
        await using var uow = await db.BeginAsync();
        var c = await uow.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id = @couponId FOR UPDATE", new { couponId })
            ?? throw new NotFoundException("Coupon");
        // Reference: update_coupon — code never changes; a seller-funded coupon keeps its own category.
        await uow.ExecuteAsync(
            "UPDATE coupons SET description = @description, kind = @kind, value = @value, max_discount_paise = @maxDiscountPaise, " +
            "min_order_paise = @minOrderPaise, starts_at = @startsAt, ends_at = @endsAt, usage_limit = @usageLimit, " +
            "per_user_limit = @perUserLimit, is_active = @isActive, first_order_only = @firstOrderOnly, " +
            "show_on_checkout = @showOnCheckout, updated_at = UTC_TIMESTAMP(6)" +
            (c.FundedBy == "seller" ? "" : ", category_id = @categoryId") + " WHERE id = @couponId",
            new
            {
                description, kind, value, maxDiscountPaise, minOrderPaise, startsAt, endsAt, usageLimit, perUserLimit,
                isActive, firstOrderOnly, showOnCheckout, categoryId, couponId,
            });
        await AuditAsync(uow, admin, "coupon.update", c.Code);
        var fresh = await uow.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id = @couponId", new { couponId }) ?? c;
        await uow.CommitAsync();
        return AdminOut(fresh);
    }

    /// <summary>Switch a coupon on or off (reference: assistant/actions.py set_coupon_active's inline update).</summary>
    public async Task<JsonObject> SetActiveAsync(UserModel admin, Guid couponId, bool active)
    {
        await access.RequireAsync(admin, "marketing");
        await using var uow = await db.BeginAsync();
        var c = await uow.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id = @couponId FOR UPDATE", new { couponId })
            ?? throw new NotFoundException("Coupon");
        await uow.ExecuteAsync("UPDATE coupons SET is_active = @active, updated_at = UTC_TIMESTAMP(6) WHERE id = @couponId",
            new { active, couponId });
        await AuditAsync(uow, admin, "coupon.update", c.Code, $"active={active} (assistant)");
        await uow.CommitAsync();
        return new JsonObject { ["code"] = c.Code, ["is_active"] = active };
    }
}
