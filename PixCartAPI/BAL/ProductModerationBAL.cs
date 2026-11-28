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
        ["net_unit"] = d.NetUnit, ["min_qty"] = d.MinQty, ["ships_on"] = d.ShipsOn, ["generic_name"] = d.GenericName, ["model_number"] = d.ModelNumber,
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
            ["status"] = "approved", ["title"] = p.Title, ["message"] = "It is live on the store now.",
        }, $"/seller/products/{p.Id}");
        p.Status = "approved";
        p.ApprovedAt = DateTimeFunctions.UtcNow();
        p.RejectionReason = "";
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
