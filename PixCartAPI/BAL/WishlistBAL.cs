using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <inheritdoc cref="IWishlistBAL"/>
public class WishlistBAL(WishlistDAL dal, SettingsDAL settings) : IWishlistBAL
{
    public const int MaxItems = 200;

    public async Task<object> ListAsync(UserModel user)
    {
        var rows = (await dal.ProductsAsync(user.Id)).ToList();
        return new { items = await ProductCardsAsync(rows), ids = rows.Select(p => p.Id.ToString()).ToList() };
    }

    public async Task AddAsync(UserModel user, Guid productId)
    {
        var product = await dal.GetProductAsync(productId) ?? throw new NotFoundException("Product");
        if (await dal.GetAsync(user.Id, productId) is not null) return;
        if (await dal.CountAsync(user.Id) >= MaxItems) throw new AppException("Your wishlist is full (200 items)", "wishlist_full");
        await dal.InsertAsync(new WishlistItemModel { UserId = user.Id, ProductId = productId, CreatedAt = DateTimeFunctions.UtcNow(), PriceAtAdd = product.PriceFrom });
    }

    public Task RemoveAsync(UserModel user, Guid productId) => dal.DeleteAsync(user.Id, productId);

    // ---------------------------------------------------------------- product cards (the reference catalog.product_cards)

    private static readonly Dictionary<string, string> DealKinds = new()
    {
        ["lightning"] = "Lightning deal", ["deal_of_day"] = "Deal of the Day", ["limited"] = "Limited time deal",
    };

    private static int DiscountPct(long price, long mrp) => mrp <= 0 || price >= mrp ? 0 : (int)((mrp - price) * 100 / mrp);

    /// <summary>"7", "40+", "300+", "2K+": rounded-down counts shoppers know.</summary>
    private static string Bucket(long n) => n >= 1000 ? $"{n / 1000}K+" : n >= 100 ? $"{n / 100 * 100}+" : n >= 10 ? $"{n / 10 * 10}+" : n.ToString();

    /// <summary>Unit sale price, e.g. ₹420 per 100 g for ₹210 / 50 g (product_info.unit_price).</summary>
    private static Dictionary<string, object?>? UnitPrice(long pricePaise, decimal? qty, string unit)
    {
        if (qty is not { } q || q <= 0 || unit.Length == 0 || pricePaise <= 0) return null;
        (decimal Base, string Per)? x = unit switch
        {
            "g" => q >= 1000 ? (1000m, "kg") : (100m, "100 g"),
            "ml" => q >= 1000 ? (1000m, "l") : (100m, "100 ml"),
            "kg" or "l" or "m" => (1m, unit),
            "pcs" => (1m, "piece"),
            "pair" => (1m, "pair"),
            _ => null,
        };
        if (x is null) return null;
        return new Dictionary<string, object?> { ["paise"] = (long)Math.Round(pricePaise * x.Value.Base / q, MidpointRounding.ToEven), ["per"] = x.Value.Per };
    }

    private async Task<bool> MarketBool(string key, bool fallback) =>
        await SiteSettingsReader.MarketplaceAsync(settings, key, JsonValue.Create(fallback)) is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;

    /// <summary>
    /// Cards for listings: price, rating, the running deal, unit price, "bought in the past month" and the version to add
    /// straight to the cart. The catalogue module owns the shared version of this (with sponsored and delivery extras).
    /// </summary>
    private async Task<List<Dictionary<string, object?>>> ProductCardsAsync(List<ProductModel> products)
    {
        if (products.Count == 0) return [];
        var ids = products.Select(p => p.Id).ToList();
        var images = (await dal.ImagesAsync(ids)).GroupBy(i => i.ProductId).ToDictionary(g => g.Key, g => g.First().Url);
        var sellers = (await dal.SellersAsync(products.Select(p => p.SellerId).Distinct())).ToDictionary(s => s.Id);
        var deals = new Dictionary<Guid, DealModel>();
        if (await MarketBool("feature_deals", true))
            foreach (var d in await dal.ActiveDealsAsync(ids)) deals.TryAdd(d.ProductId, d);
        var variants = (await dal.ActiveVariantsAsync(ids)).GroupBy(v => v.ProductId).ToDictionary(g => g.Key, g => g.ToList());
        var bought = await MarketBool("pdp_bought_count", true) ? await dal.UnitsSoldSinceAsync(ids, DateTimeFunctions.UtcNow().AddDays(-30)) : [];
        var unitOn = await MarketBool("pdp_unit_price", true);
        var minNode = await SiteSettingsReader.MarketplaceAsync(settings, "pdp_bought_min", JsonValue.Create(10));
        var boughtMin = minNode is JsonValue mv && mv.TryGetValue<int>(out var m) ? m : 10;
        bool? showCountdown = null;
        var outp = new List<Dictionary<string, object?>>();
        foreach (var p in products)
        {
            var vs = variants.GetValueOrDefault(p.Id) ?? [];
            var cheapest = vs.FirstOrDefault(v => v.Stock > 0) ?? vs.FirstOrDefault();
            var unit = JsonHelper.Object(p.Details)["net_unit"] is JsonValue uv && uv.TryGetValue<string>(out var u) ? u : "";
            var units = bought.GetValueOrDefault(p.Id);
            object? deal = null;
            showCountdown ??= ((JsonObject)SettingsDAL.Merge(GrowthBAL.Defaults(), await settings.GetAsync("growth"))["flash_sales"]!).Bool("show_countdown");
            if (deals.TryGetValue(p.Id, out var d))
            {
                int? claimed = d.QtyLimit is > 0 ? (int)Math.Round(100.0 * d.SoldQty / d.QtyLimit.Value, MidpointRounding.ToEven) : null;
                deal = new Dictionary<string, object?>
                {
                    ["kind"] = d.Kind, ["label"] = DealKinds.GetValueOrDefault(d.Kind, d.Kind), ["ends_at"] = DateTimeFunctions.Iso(d.EndsAt), ["deal_price"] = d.DealPricePaise,
                    ["regular_price"] = d.RegularPricePaise, ["claimed_pct"] = claimed is null ? null : Math.Min(100, claimed.Value),
                    ["units_left"] = d.QtyLimit is > 0 ? Math.Max(0, d.QtyLimit.Value - d.SoldQty) : null, ["variant_id"] = d.VariantId.ToString(),
                    ["show_countdown"] = showCountdown,
                };
            }
            outp.Add(new Dictionary<string, object?>
            {
                ["id"] = p.Id.ToString(), ["slug"] = p.Slug, ["title"] = p.Title, ["brand"] = p.Brand, ["image"] = images.GetValueOrDefault(p.Id, ""),
                ["price"] = p.PriceFrom, ["mrp"] = p.MrpFrom, ["discount_pct"] = DiscountPct(p.PriceFrom, p.MrpFrom), ["rating_avg"] = (double)p.RatingAvg,
                ["rating_count"] = p.RatingCount, ["in_stock"] = p.InStock, ["seller_name"] = sellers.TryGetValue(p.SellerId, out var s) ? s.DisplayName : "",
                ["deal"] = deal, ["unit_price"] = cheapest is not null && unitOn ? UnitPrice(cheapest.PricePaise, cheapest.NetQty, unit) : null,
                ["bought"] = units >= boughtMin ? $"{Bucket(units)} bought in past month" : null, ["variant_count"] = vs.Count,
                ["variant_id"] = cheapest is not null && vs.Count == 1 && cheapest.Stock > 0 ? cheapest.Id.ToString() : null,
            });
        }
        return outp;
    }
}

/// <inheritdoc cref="IProductEventBAL"/>
public class ProductEventBAL(ProductEventDAL dal) : IProductEventBAL
{
    // a visitor is counted once per 30 minutes per product (per server, like the reference version's in-memory map)
    private static readonly ConcurrentDictionary<(string Ip, string Type, Guid ProductId), DateTime> Seen = new();

    public async Task RecordAsync(string ip, string type, Guid productId)
    {
        var key = (ip, type, productId);
        var now = DateTime.UtcNow;
        if (Seen.TryGetValue(key, out var at) && (now - at).TotalSeconds < 1800) return;
        Seen[key] = now;
        if (Seen.Count > 100_000) Seen.Clear();
        if (await dal.IsPublicAsync(productId))
            await dal.BumpAsync(productId, DateFunctions.TodayIst(), views: type == "view" ? 1 : 0, addToCart: type == "add_to_cart" ? 1 : 0);
    }
}
