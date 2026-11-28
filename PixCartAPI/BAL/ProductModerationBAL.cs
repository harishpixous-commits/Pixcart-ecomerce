using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Staff product moderation (reference: routers/admin.py approve_product/reject_product and
/// routers/seller_products.py product_detail/variant_out/required_for). The detail response is the reference
/// shape, including the required/missing product information the category asks for.
/// </summary>
public class ProductModerationBAL(
    ProductModerationDAL productsDal,
    CatalogDAL catalog,
    IAccessBAL access,
    ICatalogNotifyBAL notify,
    IMySqlDapperHelper db) : IProductModerationBAL
{
    private static async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, Guid productId, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'product', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, eid = productId.ToString(), detail, id = Guid.NewGuid() });

    /// <summary>Reference: product_info.ProductDetails.model_dump() — every field, in model order.</summary>
    internal static JsonObject DetailsDump(ProductInfo.Details d) => new()
    {
        ["net_unit"] = d.NetUnit, ["min_qty"] = d.MinQty, ["max_qty"] = d.MaxQty, ["ships_on"] = d.ShipsOn, ["generic_name"] = d.GenericName, ["model_number"] = d.ModelNumber,
        ["manufacturer"] = d.Manufacturer, ["packer"] = d.Packer, ["importer"] = d.Importer,
        ["customer_care"] = d.CustomerCare, ["fssai_license"] = d.FssaiLicense, ["ingredients"] = d.Ingredients,
        ["directions"] = d.Directions, ["safety_info"] = d.SafetyInfo, ["legal_disclaimer"] = d.LegalDisclaimer,
        ["shelf_life"] = d.ShelfLife, ["warranty"] = d.Warranty,
        ["in_the_box"] = new JsonArray(d.InTheBox.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
        ["length_cm"] = d.LengthCm, ["width_cm"] = d.WidthCm, ["height_cm"] = d.HeightCm,
        ["key_specs"] = new JsonArray(d.KeySpecs.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
    };

    /// <summary>Reference: seller_products.variant_out.</summary>
    internal static JsonObject VariantOut(VariantModel v) => new()
    {
        ["id"] = v.Id.ToString(),
        ["sku"] = v.Sku,
        ["options"] = JsonHelper.Node(v.Options),
        ["label"] = ProductInfo.VariantLabel(v.Options),
        ["mrp_paise"] = v.MrpPaise,
        ["price_paise"] = v.PricePaise,
        ["discount_pct"] = ProductInfo.DiscountPct(v.PricePaise, v.MrpPaise),
        ["stock"] = v.Stock,
        ["weight_grams"] = v.WeightGrams,
        ["net_qty"] = v.NetQty,
        ["is_active"] = v.IsActive,
    };

    /// <summary>Reference: seller_products.product_detail.</summary>
    public async Task<JsonObject> DetailAsync(ProductModel p)
    {
        var variants = await productsDal.VariantsAsync(p.Id);
        var imgs = (await catalog.ImagesForAsync([p.Id])).GetValueOrDefault(p.Id) ?? [];
        var vids = (await catalog.VideosForAsync([p.Id])).GetValueOrDefault(p.Id) ?? [];
        var cat = await catalog.GetCategoryAsync(p.CategoryId);
        var details = ProductInfo.DetailsOf(p.Details);
        var chain = await catalog.CategoryChainAsync(p.CategoryId);
        var required = ProductInfo.EffectiveRequired(
            chain.Select(c => (JsonHelper.Node(c.RequiredDetails) as JsonArray ?? []).Select(CatalogText.Str)));
        var missing = ProductInfo.MissingRequired(required, p.Brand, p.CountryOfOrigin, details,
            variants.Where(v => v.IsActive).Select(v => v.NetQty).ToList());
        var videosOut = new JsonArray();
        foreach (var v in vids)
            videosOut.Add(new JsonObject
            {
                ["url"] = v.Url, ["poster_url"] = v.PosterUrl, ["title"] = v.Title, ["duration_s"] = v.DurationS,
            });
        return new JsonObject
        {
            ["id"] = p.Id.ToString(),
            ["slug"] = p.Slug,
            ["status"] = p.Status,
            ["rejection_reason"] = p.RejectionReason,
            ["category_id"] = p.CategoryId.ToString(),
            ["category_name"] = cat?.Name ?? "",
            ["title"] = p.Title,
            ["brand"] = p.Brand,
            ["description"] = p.Description,
            ["highlights"] = JsonHelper.Node(p.Highlights),
            ["specs"] = JsonHelper.Node(p.Specs),
            ["hsn_code"] = p.HsnCode,
            ["gst_bps"] = p.GstBps,
            ["country_of_origin"] = p.CountryOfOrigin,
            ["size_guide"] = p.SizeGuide ?? "",
            ["tags"] = JsonHelper.Node(p.Tags) ?? new JsonArray(),
            ["seo_title"] = p.SeoTitle ?? "", ["seo_description"] = p.SeoDescription ?? "",
            ["publish_at"] = p.PublishAt is { } pubAt ? DateTime.SpecifyKind(pubAt, DateTimeKind.Utc).ToString("o") : null,
            ["return_window_days"] = p.ReturnWindowDays,
            ["images"] = new JsonArray(imgs.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
            ["videos"] = videosOut,
            ["details"] = DetailsDump(details),
            ["required_details"] = new JsonArray(required.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
            ["missing_details"] = new JsonArray(missing.Select(x => (JsonNode)JsonValue.Create(x)).ToArray()),
            ["variants"] = new JsonArray(variants.Select(v => (JsonNode)VariantOut(v)).ToArray()),
            ["price_from"] = p.PriceFrom,
            ["mrp_from"] = p.MrpFrom,
            ["in_stock"] = p.InStock,
            ["created_at"] = p.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["updated_at"] = p.UpdatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
        };
    }

    public async Task<JsonObject> ApproveAsync(UserModel admin, Guid productId)
    {
        await access.RequireAsync(admin, "catalog");
        await using var uow = await db.BeginAsync();
        var p = await productsDal.ProductForUpdateAsync(productId, uow) ?? throw new NotFoundException("Product");
        if (p.Status != "pending")
            throw new ConflictException($"A {p.Status} product cannot be approved", "invalid_status");
        await uow.ExecuteAsync(
            "UPDATE products SET status = 'approved', approved_at = UTC_TIMESTAMP(6), rejection_reason = '' WHERE id = @id",
            new { id = p.Id });
        await AuditAsync(uow, admin, "product.approve", p.Id);
        await uow.CommitAsync();
        await notify.NotifySellerAsync(p.SellerId, "listing_update", new Dictionary<string, string>
        {
            ["status"] = "approved", ["title"] = p.Title,
            ["message"] = p.PublishAt is { } goLive && goLive > DateTime.UtcNow
                ? $"It goes live on the store on {TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(goLive, DateTimeKind.Utc), TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata")).ToString("dd MMM yyyy 'at' hh:mm tt", System.Globalization.CultureInfo.InvariantCulture)} IST."
                : "It is live on the store now.",
        }, $"/seller/products/{p.Id}");
        p.Status = "approved";
        p.ApprovedAt = DateTimeFunctions.UtcNow();
        p.RejectionReason = "";
        return await DetailAsync(p);
    }

    public async Task<JsonObject> SetPublishAtAsync(UserModel admin, Guid productId, DateTimeOffset? publishAt)
    {
        await access.RequireAsync(admin, "catalog");
        if (publishAt is { } far && far > DateTimeOffset.UtcNow.AddDays(365)) throw new AppException("Pick a go-live time within the next year", "invalid_value");
        await using var uow = await db.BeginAsync();
        var p = await productsDal.ProductForUpdateAsync(productId, uow) ?? throw new NotFoundException("Product");
        if (p.Status == "archived") throw new ConflictException("Restore this product before changing it", "invalid_status");
        var when = publishAt?.UtcDateTime;
        await uow.ExecuteAsync("UPDATE products SET publish_at = @when, publish_notified_at = IF(publish_at <=> @when, publish_notified_at, NULL) WHERE id = @id", new { when, id = p.Id });
        await AuditAsync(uow, admin, "product.publish_at", p.Id, when is null ? "cleared" : when.Value.ToString("o"));
        await uow.CommitAsync();
        p.PublishAt = when;
        return await DetailAsync(p);
    }

    public async Task<JsonObject> SetUnitLimitAsync(UserModel admin, Guid productId, int maxQty)
    {
        await access.RequireAsync(admin, "catalog");
        if (maxQty is < 0 or > 100) throw new AppException("Pick a limit from 0 to 100", "invalid_value", 422);
        await using var uow = await db.BeginAsync();
        var p = await productsDal.ProductForUpdateAsync(productId, uow) ?? throw new NotFoundException("Product");
        if (p.Status == "archived") throw new ConflictException("Restore this product before changing it", "invalid_status");
        var det = ProductInfo.DetailsOf(p.Details);
        if (maxQty > 0 && det.MinQty > maxQty)
            throw new AppException($"The most per order cannot be below the minimum of {det.MinQty}", "invalid_value", 422, new Dictionary<string, string> { ["max_qty"] = "Below the minimum order quantity" });
        var raw = System.Text.Json.Nodes.JsonNode.Parse(string.IsNullOrWhiteSpace(p.Details) ? "{}" : p.Details) as JsonObject ?? new JsonObject();
        raw["max_qty"] = maxQty;
        var json = raw.ToJsonString();
        await uow.ExecuteAsync("UPDATE products SET details = @json WHERE id = @id", new { json, id = p.Id });
        await AuditAsync(uow, admin, "product.unit_limit", p.Id, maxQty.ToString());
        await uow.CommitAsync();
        p.Details = json;
        return await DetailAsync(p);
    }

    public async Task<JsonObject> RejectAsync(UserModel admin, Guid productId, string reason)
    {
        await access.RequireAsync(admin, "catalog");
        await using var uow = await db.BeginAsync();
        var p = await productsDal.ProductForUpdateAsync(productId, uow) ?? throw new NotFoundException("Product");
        if (p.Status is not ("pending" or "approved"))
            throw new ConflictException($"A {p.Status} product cannot be rejected", "invalid_status");
        var wasLive = p.Status == "approved";
        await uow.ExecuteAsync("UPDATE products SET status = 'rejected', rejection_reason = @reason WHERE id = @id",
            new { reason, id = p.Id });
        await AuditAsync(uow, admin, "product.reject", p.Id, reason);
        await uow.CommitAsync();
        await notify.NotifySellerAsync(p.SellerId, "listing_update", new Dictionary<string, string>
        {
            ["status"] = wasLive ? "taken down" : "not approved", ["title"] = p.Title,
            ["message"] = $"Reason: {reason}. Edit the listing and send it for review again.",
        }, $"/seller/products/{p.Id}");
        p.Status = "rejected";
        p.RejectionReason = reason;
        return await DetailAsync(p);
    }
}
