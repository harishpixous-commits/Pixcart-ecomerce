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
        if (kind == "bundle" && value is < 1 or > 90)
            throw new AppException("A bundle takes between 1% and 90% off", "invalid_value", 400);
        if (kind == "bxgy" && value is < 1 or > 100)
            throw new AppException("A buy X get Y offer takes between 1% and 100% off the extra items", "invalid_value", 400);
    }

    /// <summary>Product link names typed by staff to a JSON list of product ids. An unknown name is an error.</summary>
    internal static async Task<string> ProductIdsJsonAsync(IMySqlDapperHelper db, IEnumerable<string>? slugs)
    {
        var clean = (slugs ?? []).Select(s => s.Trim().ToLowerInvariant()).Select(s => s.Contains('/') ? s[(s.LastIndexOf('/') + 1)..] : s).Where(s => s.Length > 0).Distinct().ToList();
        if (clean.Count == 0) return "[]";
        var rows = (await db.QueryAsync<(Guid Id, string Slug)>("SELECT id AS Id, slug AS Slug FROM products WHERE LOWER(slug) IN @clean", new { clean })).ToDictionary(r => r.Slug.ToLowerInvariant(), r => r.Id);
        var missing = clean.Where(s => !rows.ContainsKey(s)).ToList();
        if (missing.Count > 0) throw new AppException($"No product with the link name: {string.Join(", ", missing)}", "product_not_found", 400);
        return System.Text.Json.JsonSerializer.Serialize(clean.Select(s => rows[s].ToString()));
    }

    /// <summary>Adds product_ids and the product link names to an admin coupon row.</summary>
    internal static async Task<JsonObject> WithSlugsAsync(IMySqlDapperHelper db, JsonObject o, CouponModel c)
    {
        var ids = JsonHelper.Array(c.ProductIds).Select(x => x!.GetValue<string>()).ToList();
        var slugs = ids.Count == 0 ? new Dictionary<string, string>() : (await db.QueryAsync<(Guid Id, string Slug)>("SELECT id AS Id, slug AS Slug FROM products WHERE id IN @ids", new { ids = ids.Select(Guid.Parse).ToList() })).ToDictionary(r => r.Id.ToString(), r => r.Slug);
        o["product_ids"] = new JsonArray(ids.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray());
        o["product_slugs"] = new JsonArray(ids.Where(slugs.ContainsKey).Select(i => (JsonNode)JsonValue.Create(slugs[i])!).ToArray());
        return o;
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
        ["first_order_only"] = c.FirstOrderOnly, ["is_active"] = c.IsActive, ["show_on_checkout"] = c.ShowOnCheckout, ["is_automatic"] = c.IsAutomatic, ["buy_qty"] = c.BuyQty, ["get_qty"] = c.GetQty,
    };

    public async Task<JsonObject> CreateAsync(UserModel admin, string code, string description, string kind, int value,
        long? maxDiscountPaise, long minOrderPaise, DateTime? startsAt, DateTime? endsAt, int? usageLimit,
        int perUserLimit, bool isActive, Guid? categoryId, bool firstOrderOnly, bool showOnCheckout, bool isAutomatic = false, int buyQty = 0, int getQty = 0, List<string>? productSlugs = null)
    {
        await access.RequireAsync(admin, "marketing");
        CheckValues(kind, value);
        if (kind == "bxgy" && (buyQty < 1 || getQty < 1)) throw new AppException("A buy X get Y offer needs at least 1 item to buy and 1 to get", "invalid_value", 400);
        if (kind == "bundle" && (productSlugs ?? []).Select(s => s.Trim().ToLowerInvariant()).Where(s => s.Length > 0).Distinct().Count() is < 2 or > 10) throw new AppException("A bundle needs between 2 and 10 products", "invalid_value", 400);
        if (kind != "bxgy") buyQty = getQty = 0;
        var productIds = await ProductIdsJsonAsync(db, productSlugs);
        code = code.ToUpperInvariant();
        await using var uow = await db.BeginAsync();
        if (await uow.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM coupons WHERE UPPER(code) = @code", new { code }) > 0)
            throw new ConflictException("This code is already used", "code_taken");
        var c = new CouponModel
        {
            Code = code, Description = description, Kind = kind, Value = value, MaxDiscountPaise = maxDiscountPaise,
            MinOrderPaise = minOrderPaise, StartsAt = startsAt, EndsAt = endsAt, UsageLimit = usageLimit,
            PerUserLimit = perUserLimit, UsedCount = 0, FundedBy = "platform", CategoryId = categoryId,
            FirstOrderOnly = firstOrderOnly, IsActive = isActive, ShowOnCheckout = showOnCheckout, IsAutomatic = isAutomatic, BuyQty = buyQty, GetQty = getQty, ProductIds = productIds,
            Id = Guid.NewGuid(), CreatedAt = DateTimeFunctions.UtcNow(), UpdatedAt = DateTimeFunctions.UtcNow(),
        };
        await uow.ExecuteAsync(
            "INSERT INTO coupons (code, description, kind, value, max_discount_paise, min_order_paise, starts_at, ends_at, " +
            "usage_limit, per_user_limit, used_count, funded_by, seller_id, category_id, first_order_only, is_active, " +
            "show_on_checkout, is_automatic, buy_qty, get_qty, product_ids, id, created_at, updated_at) VALUES (@Code, @Description, @Kind, @Value, @MaxDiscountPaise, " +
            "@MinOrderPaise, @StartsAt, @EndsAt, @UsageLimit, @PerUserLimit, @UsedCount, @FundedBy, @SellerId, @CategoryId, " +
            "@FirstOrderOnly, @IsActive, @ShowOnCheckout, @IsAutomatic, @BuyQty, @GetQty, CAST(@ProductIds AS JSON), @Id, @CreatedAt, @UpdatedAt)", c);
        await AuditAsync(uow, admin, "coupon.create", c.Code);
        await uow.CommitAsync();
        return await WithSlugsAsync(db, AdminOut(c), c);
    }

    public async Task<JsonObject> UpdateAsync(UserModel admin, Guid couponId, string description, string kind, int value,
        long? maxDiscountPaise, long minOrderPaise, DateTime? startsAt, DateTime? endsAt, int? usageLimit,
        int perUserLimit, bool isActive, Guid? categoryId, bool firstOrderOnly, bool showOnCheckout, bool isAutomatic = false, int buyQty = 0, int getQty = 0, List<string>? productSlugs = null)
    {
        await access.RequireAsync(admin, "marketing");
        CheckValues(kind, value);
        if (kind == "bxgy" && (buyQty < 1 || getQty < 1)) throw new AppException("A buy X get Y offer needs at least 1 item to buy and 1 to get", "invalid_value", 400);
        if (kind == "bundle" && (productSlugs ?? []).Select(s => s.Trim().ToLowerInvariant()).Where(s => s.Length > 0).Distinct().Count() is < 2 or > 10) throw new AppException("A bundle needs between 2 and 10 products", "invalid_value", 400);
        if (kind != "bxgy") buyQty = getQty = 0;
        var productIds = await ProductIdsJsonAsync(db, productSlugs);
        await using var uow = await db.BeginAsync();
        var c = await uow.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id = @couponId FOR UPDATE", new { couponId })
            ?? throw new NotFoundException("Coupon");
        // Reference: update_coupon — code never changes; a seller-funded coupon keeps its own category.
        await uow.ExecuteAsync(
            "UPDATE coupons SET description = @description, kind = @kind, value = @value, max_discount_paise = @maxDiscountPaise, " +
            "min_order_paise = @minOrderPaise, starts_at = @startsAt, ends_at = @endsAt, usage_limit = @usageLimit, " +
            "per_user_limit = @perUserLimit, is_active = @isActive, first_order_only = @firstOrderOnly, " +
            "show_on_checkout = @showOnCheckout, is_automatic = @isAutomatic, buy_qty = @buyQty, get_qty = @getQty, updated_at = UTC_TIMESTAMP(6)" +
            (c.FundedBy == "seller" ? "" : ", category_id = @categoryId, product_ids = CAST(@productIds AS JSON)") + " WHERE id = @couponId",
            new
            {
                description, kind, value, maxDiscountPaise, minOrderPaise, startsAt, endsAt, usageLimit, perUserLimit,
                isActive, firstOrderOnly, showOnCheckout, isAutomatic, buyQty, getQty, categoryId, productIds, couponId,
            });
        await AuditAsync(uow, admin, "coupon.update", c.Code);
        var fresh = await uow.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id = @couponId", new { couponId }) ?? c;
        await uow.CommitAsync();
        return await WithSlugsAsync(db, AdminOut(fresh), fresh);
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
