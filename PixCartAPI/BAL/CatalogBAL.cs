using System.Globalization;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Utils;
using Utils.Interface;
using Utils.TextSearch;

namespace BAL;

/// <summary>
/// The storefront catalogue (reference: routers/catalog.py, services/catalog.py, services/product_page.py,
/// the delivery estimate in routers/customer.py).
/// </summary>
public class CatalogBAL(
    CatalogDAL catalog,
    IPlatformSettingsBAL platform,
    ISiteBAL site,
    IRazorpayBAL razorpay,
    IEnumerable<IDealSync> dealSync,
    IEnumerable<ISponsoredProducts> ads,
    IMySqlDapperHelper sellerDb) : ICatalogBAL
{
    public static readonly string[] Sorts = ["relevance", "price_asc", "price_desc", "newest", "rating", "discount", "popular"];

    public static readonly IReadOnlyDictionary<string, string> DealKinds = new Dictionary<string, string>
    {
        ["lightning"] = "Lightning deal", ["deal_of_day"] = "Deal of the Day", ["limited"] = "Limited time deal",
    };

    // ------------------------------------------------------------------------- small helpers (reference product_page.py)

    /// <summary>Rounded-down count in the style shoppers know: 7, 40+, 300+, 2K+.</summary>
    public static string Bucket(long n)
    {
        if (n >= 1000) return $"{n / 1000}K+";
        if (n >= 100) return $"{n / 100 * 100}+";
        if (n >= 10) return $"{n / 10 * 10}+";
        return n.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>"₹1,234" or "₹1,234.50".</summary>
    public static string Rupees(long paise)
    {
        var r = paise / 100m;
        return r == decimal.Truncate(r) ? "₹" + r.ToString("#,0", CultureInfo.InvariantCulture) : "₹" + r.ToString("#,0.00", CultureInfo.InvariantCulture);
    }

    public static JsonObject DealPublic(DealModel d)
    {
        int? claimed = d.QtyLimit is > 0 ? (int)Math.Round(100.0 * d.SoldQty / d.QtyLimit.Value, MidpointRounding.ToEven) : null;
        return new JsonObject
        {
            ["kind"] = d.Kind, ["label"] = DealKinds.TryGetValue(d.Kind, out var l) ? l : d.Kind, ["ends_at"] = DateTimeFunctions.Iso(d.EndsAt),
            ["deal_price"] = d.DealPricePaise, ["regular_price"] = d.RegularPricePaise,
            ["claimed_pct"] = claimed is { } c ? Math.Min(100, c) : null,
            ["units_left"] = d.QtyLimit is > 0 ? Math.Max(0, d.QtyLimit.Value - d.SoldQty) : null,
            ["variant_id"] = d.VariantId.ToString(),
        };
    }

    /// <summary>Running deal per product (the lowest deal price when several versions have one).</summary>
    private async Task<Dictionary<Guid, JsonObject>> ActiveDealsForAsync(IEnumerable<Guid> productIds)
    {
        var outp = new Dictionary<Guid, JsonObject>();
        var deals = (await catalog.ActiveDealsAsync(productIds)).ToList();
        if (deals.Count == 0) return outp;
        var show = await GrowthBAL.ShowDealCountdownAsync(sellerDb); // Admin → Growth → Flash sales: the pages hide the ticking clock when off
        foreach (var d in deals)
        {
            if (outp.ContainsKey(d.ProductId)) continue;
            var o = DealPublic(d); o["show_countdown"] = show; outp[d.ProductId] = o;
        }
        return outp;
    }

    private async Task SyncDealsAsync()
    {
        foreach (var s in dealSync) await s.SyncAsync();
    }

    // ------------------------------------------------------------------------- cards

    public async Task<List<JsonObject>> ProductCardsAsync(IReadOnlyList<ProductModel> products, IReadOnlyDictionary<Guid, string>? sponsored = null,
        IReadOnlyDictionary<Guid, string?>? deliveryBy = null)
    {
        if (products.Count == 0) return [];
        var ids = products.Select(p => p.Id).ToList();
        var imgs = await catalog.ImagesForAsync(ids);
        var sellers = (await catalog.SellersAsync(products.Select(p => p.SellerId))).ToDictionary(s => s.Id);
        var cfg = await platform.GetAsync();
        var deals = cfg.Bool("feature_deals") ? await ActiveDealsForAsync(ids) : [];
        var variants = (await catalog.ActiveVariantsAsync(ids)).GroupBy(v => v.ProductId).ToDictionary(g => g.Key, g => g.ToList());
        var bought = cfg.Bool("pdp_bought_count") ? await catalog.UnitsSoldSinceAsync(ids, DateTimeFunctions.UtcNow().AddDays(-30)) : [];
        var outp = new List<JsonObject>();
        foreach (var p in products)
        {
            var vs = variants.GetValueOrDefault(p.Id) ?? [];
            var cheapest = vs.FirstOrDefault(v => v.Stock > 0) ?? vs.FirstOrDefault();
            var unit = ProductInfo.DetailsOf(p.Details).NetUnit;
            var units = bought.GetValueOrDefault(p.Id);
            var card = new JsonObject
            {
                ["id"] = p.Id.ToString(),
                ["slug"] = p.Slug,
                ["title"] = p.Title,
                ["brand"] = p.Brand,
                ["image"] = imgs.GetValueOrDefault(p.Id)?.FirstOrDefault() ?? "",
                ["price"] = p.PriceFrom,
                ["mrp"] = p.MrpFrom,
                ["discount_pct"] = ProductInfo.DiscountPct(p.PriceFrom, p.MrpFrom),
                ["rating_avg"] = (double)p.RatingAvg,
                ["rating_count"] = p.RatingCount,
                ["in_stock"] = p.InStock,
                ["seller_name"] = sellers.TryGetValue(p.SellerId, out var s) ? s.DisplayName : "",
                ["deal"] = deals.TryGetValue(p.Id, out var d) ? d.DeepClone() : null,
                ["unit_price"] = cheapest != null && cfg.Bool("pdp_unit_price") ? ProductInfo.UnitPrice(cheapest.PricePaise, cheapest.NetQty, unit) : null,
                ["bought"] = units >= cfg.Long("pdp_bought_min") ? $"{Bucket(units)} bought in past month" : null,
                ["variant_count"] = vs.Count,
                ["variant_id"] = cheapest != null && vs.Count == 1 && cheapest.Stock > 0 ? cheapest.Id.ToString() : null,
            };
            if (sponsored != null && sponsored.TryGetValue(p.Id, out var token))
            {
                card["sponsored"] = true;
                card["href"] = $"/api/ads/click?t={token}";
            }
            if (deliveryBy != null) card["delivery_by"] = deliveryBy.GetValueOrDefault(p.SellerId);
            outp.Add(card);
        }
        return outp;
    }

    public Task<ProductModel?> GetProductAsync(Guid id) => catalog.GetProductAsync(id);

    public Task<ProductModel?> GetProductBySlugAsync(string slug, bool publicOnly = true) =>
        publicOnly ? catalog.PublicProductBySlugAsync(slug) : catalog.ProductBySlugAsync(slug);

    public async Task<List<ProductModel>> PublicProductsAsync(IReadOnlyList<Guid> ids)
    {
        var rows = (await catalog.PublicProductsByIdsAsync(ids)).ToDictionary(p => p.Id);
        return ids.Where(rows.ContainsKey).Select(i => rows[i]).ToList();
    }

    public Task RefreshProductAggregatesAsync(Guid productId, IUnitOfWork? uow = null) => catalog.RefreshAggregatesAsync(productId, uow);

    public Task<Dictionary<Guid, List<string>>> ImagesForAsync(IEnumerable<Guid> productIds) => catalog.ImagesForAsync(productIds);

    // ------------------------------------------------------------------------- categories

    public async Task<List<Guid>> CategoryDescendantIdsAsync(Guid rootId)
    {
        var children = new Dictionary<Guid, List<Guid>>();
        foreach (var (id, parent) in await catalog.ActiveCategoryEdgesAsync())
        {
            if (parent is not { } pid) continue;
            if (!children.TryGetValue(pid, out var l)) children[pid] = l = [];
            l.Add(id);
        }
        var outp = new List<Guid>();
        var stack = new List<Guid> { rootId };
        while (stack.Count > 0)
        {
            var cur = stack[^1];
            stack.RemoveAt(stack.Count - 1);
            outp.Add(cur);
            if (children.TryGetValue(cur, out var ch)) stack.AddRange(ch);
        }
        return outp;
    }

    private sealed class CatNode
    {
        public required CategoryModel Cat;
        public int Count;
        public List<string> Required = [];
        public List<CatNode> Children = [];

        public JsonObject ToJson() => new()
        {
            ["id"] = Cat.Id.ToString(), ["name"] = Cat.Name, ["slug"] = Cat.Slug, ["image_url"] = Cat.ImageUrl, ["product_count"] = Count,
            ["required_details"] = new JsonArray(Required.Select(r => (JsonNode)r).ToArray()),
            ["children"] = new JsonArray(Children.Select(c => (JsonNode)c.ToJson()).ToArray()),
        };
    }

    public async Task<JsonArray> CategoryTreeAsync()
    {
        var cats = (await catalog.ActiveCategoriesAsync()).ToList();
        var counts = await catalog.PublicCountsByCategoryAsync();
        var nodes = cats.ToDictionary(c => c.Id, c => new CatNode
        {
            Cat = c, Count = counts.GetValueOrDefault(c.Id),
            Required = (JsonHelper.Node(c.RequiredDetails) as JsonArray ?? []).Select(CatalogText.Str).ToList(),
        });
        var roots = new List<CatNode>();
        foreach (var c in cats)
        {
            if (c.ParentId is { } pid && nodes.TryGetValue(pid, out var parent)) parent.Children.Add(nodes[c.Id]);
            else roots.Add(nodes[c.Id]);
        }
        void Inherit(CatNode n, List<string> parent)
        {
            // what a listing in this category must include: its own list plus its parents'
            n.Required = parent.Concat(n.Required).Distinct().ToList();
            foreach (var ch in n.Children) Inherit(ch, n.Required);
        }
        int Total(CatNode n)
        {
            n.Count += n.Children.Sum(Total);
            return n.Count;
        }
        foreach (var r in roots) Inherit(r, []);
        foreach (var r in roots) Total(r);
        return new JsonArray(roots.Select(r => (JsonNode)r.ToJson()).ToArray());
    }

    private async Task<List<JsonObject>> RailAsync(string source, int n = 12) => await ProductCardsAsync((await catalog.RailAsync(source, n)).ToList());

    public async Task<JsonObject> HomeRailsAsync() => new()
    {
        ["categories"] = await CategoryTreeAsync(),
        ["deals"] = Arr(await RailAsync("deals")),
        ["new_arrivals"] = Arr(await RailAsync("new")),
        ["top_rated"] = Arr(await RailAsync("top_rated")),
        ["bestsellers"] = Arr(await RailAsync("bestsellers_sold")),
    };

    internal static JsonArray Arr(IEnumerable<JsonNode?> items) => new(items.ToArray());

    // ------------------------------------------------------------------------- delivery

    public async Task<Dictionary<Guid, (int Days, string Date)>> SellerDeliveryAsync(IReadOnlyCollection<Guid> sellerIds, string pin)
    {
        var outp = new Dictionary<Guid, (int Days, string Date)>();
        if (sellerIds.Count == 0) return outp;
        var cfg = await platform.GetAsync();
        var sellers = (await catalog.SellersAsync(sellerIds)).ToDictionary(s => s.Id);
        foreach (var w in await catalog.ActiveWarehousesAsync(sellerIds))
        {
            if (!sellers.TryGetValue(w.SellerId, out var s)) continue;
            var e = DeliveryEstimate.Estimate(cfg, s.DispatchDays, w.Pincode, w.StateCode, pin, cutoff: s.DispatchCutoff);
            var days = e.Int("days_min");
            if (!outp.TryGetValue(w.SellerId, out var cur) || days < cur.Days) outp[w.SellerId] = (days, e.Str("min_date"));
        }
        return outp;
    }

    public async Task<JsonObject> DeliveryEstimateAsync(Guid variantId, string pincode, Guid? userId = null)
    {
        string pin;
        try
        {
            pin = IndianStates.ValidatePincode(pincode);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_pincode");
        }
        var v = await catalog.GetVariantAsync(variantId) ?? throw new NotFoundException("Product");
        var seller = await catalog.GetSellerAsync(v.SellerId) ?? throw new NotFoundException("Product");
        var whs = (await catalog.ActiveWarehousesAsync([seller.Id])).ToList();
        if (whs.Count == 0) return new JsonObject { ["serviceable"] = false };
        var cfg = await platform.GetAsync();
        JsonObject? best = null;
        foreach (var w in whs)
        {
            var e = DeliveryEstimate.Estimate(cfg, seller.DispatchDays, w.Pincode, w.StateCode, pin, cutoff: seller.DispatchCutoff);
            if (best == null || e.Int("days_min") < best.Int("days_min")) best = e;
        }
        // The same rules as the checkout quote: the seller's own amount, the by-state amount and fee, the remote-area surcharge.
        var stateCode = DeliveryEstimate.StateForPin(pin) ?? "";
        var freeFrom = CartBAL.FreeThreshold(seller, await ShippingZones.WithStateThresholdAsync(sellerDb, cfg, stateCode), await ShippingZones.SellerFreeBoundsAsync(sellerDb));
        var fee = v.PricePaise >= freeFrom ? 0 : await ShippingZones.StateFeeAsync(sellerDb, stateCode) ?? cfg.Long("shipping_fee_paise");
        var (extra, waive) = await ShippingZones.SurchargeAsync(sellerDb, pin);
        if (extra > 0 && !(waive && fee == 0)) fee += extra;
        var memberFree = userId is not null && await LoyaltyPoints.FreeDeliveryAsync(sellerDb, userId.Value); // a signed-in member whose tier carries free delivery
        if (memberFree) fee = 0;
        var outp = new JsonObject { ["serviceable"] = true };
        foreach (var (k, val) in best!) outp[k] = val?.DeepClone();
        outp["cod_available"] = cfg.Bool("cod_enabled") && v.PricePaise <= cfg.Long("cod_max_order_paise");
        outp["order_within_min"] = cfg.Bool("pdp_delivery_countdown") ? best["order_within_min"]?.DeepClone() : null;
        // delivery is charged per seller package; free once that seller's items reach the threshold
        outp["delivery_fee_paise"] = fee;
        outp["member_free_delivery"] = memberFree;
        outp["free_delivery_from_paise"] = freeFrom;
        outp["state"] = IndianStates.Name(DeliveryEstimate.StateForPin(pin) ?? "");
        return outp;
    }

    // ------------------------------------------------------------------------- search

    /// <summary>
    /// The products in the scope that match the words, with the order keys of their relevance (prefix words in title,
    /// brand and description; a close title despite typos; the brand as a pattern), decided in memory from the cached
    /// search documents.
    /// </summary>
    private async Task<List<(Guid Id, int Key)>> TextMatchesAsync(ProductFilter scope, string text)
    {
        var queries = SearchSynonyms.Variants(text, SearchSynonyms.Parse((await platform.GetAsync()).Str("search_synonyms"))).Select(v => ProductTextQuery.For(v)).ToList();
        var outp = new List<(Guid, int)>();
        foreach (var c in await catalog.SearchCandidatesAsync(scope))
        {
            var best = -1;
            foreach (var query in queries)
                if (query.Matches(c.Entry.Document, out var relevance)) best = Math.Max(best, ProductTextQuery.OrderKey(relevance));
            if (best >= 0) outp.Add((c.Id, best));
        }
        return outp;
    }

    public async Task<(JsonObject Result, bool ServedAds)> SearchAsync(ProductSearch q, string visitor, string ip)
    {
        var cfg = await platform.GetAsync();
        var pageSize = q.PageSize ?? cfg.Int("search_page_size");
        var filter = new ProductFilter();
        var breadcrumbs = new JsonArray();
        JsonObject? currentCategory = null;
        if (!string.IsNullOrEmpty(q.Category))
        {
            var cat = await catalog.CategoryBySlugAsync(q.Category, activeOnly: true) ?? throw new NotFoundException("Category");
            filter.CategoryIds = await CategoryDescendantIdsAsync(cat.Id);
            currentCategory = new JsonObject { ["id"] = cat.Id.ToString(), ["name"] = cat.Name, ["slug"] = cat.Slug };
            foreach (var c in Enumerable.Reverse(await catalog.CategoryChainAsync(cat.Id)))
                breadcrumbs.Add(new JsonObject { ["name"] = c.Name, ["slug"] = c.Slug });
        }
        if (!string.IsNullOrEmpty(q.Seller)) filter.SellerSlug = q.Seller;
        var text = q.Q.Trim();
        if (text.Length > 0) filter.TextMatches = await TextMatchesAsync(filter, text);

        // Facets are computed before brand/price filters so the user can widen them again.
        var facet = filter.FacetScope();
        if (q.Brand is { Count: > 0 }) filter.Brands = q.Brand.ToList();
        filter.MinPrice = q.MinPrice;
        filter.MaxPrice = q.MaxPrice;
        filter.MinRating = q.MinRating;
        filter.MinDiscount = q.MinDiscount;
        filter.InStock = q.InStock;
        filter.Deal = q.Deal;
        var eta = new Dictionary<Guid, (int Days, string Date)>();
        if (q.Pincode != null)
        {
            eta = await SellerDeliveryAsync((await catalog.FacetSellerIdsAsync(facet)).ToList(), q.Pincode);
            if (q.Delivery is { } within) filter.SellerIds = eta.Where(e => e.Value.Days <= within).Select(e => e.Key).ToList();
        }
        var total = await catalog.SearchCountAsync(filter);
        var rows = (await catalog.SearchPageAsync(filter, q.Sort, pageSize, (q.Page - 1) * pageSize)).ToList();
        // Most products first; equal counts in a fixed order: grouped in name order, then sorted by count (ResultSort).
        var brands = ResultSort.Order((await catalog.FacetBrandsAsync(facet)).OrderBy(b => b.Name, TextCollation.Instance),
            (x, y) => y.Count.CompareTo(x.Count), cfg.Int("brand_filter_max"));
        var (priceMin, priceMax) = await catalog.FacetPriceRangeAsync(facet);
        var catCounts = ResultSort.Order((await catalog.FacetCategoriesAsync(facet))
                .OrderBy(c => c.Name, TextCollation.Instance).ThenBy(c => c.Slug, TextCollation.Instance),
            (x, y) => y.Count.CompareTo(x.Count), 8);
        var delivery = q.Pincode != null ? eta.ToDictionary(e => e.Key, e => (string?)e.Value.Date) : null;

        var sponsored = new List<JsonObject>();
        var sponsoredRail = new List<JsonObject>();
        var served = false;
        if (text.Length > 0 && q.Page == 1)
        {
            var perSearch = cfg.Int("ads_per_search");
            foreach (var hook in ads)
            {
                var got = await hook.ServeAsync("search", visitor, ip, text, perSearch + cfg.Int("ads_per_rail"));
                if (got.Count == 0) continue;
                served = true;
                var products = await PublicProductsAsync(got.Select(x => x.ProductId).ToList());
                var tokens = got.GroupBy(x => x.ProductId).ToDictionary(g => g.Key, g => g.First().Token);
                var cards = await ProductCardsAsync(products, tokens, delivery);
                sponsored = cards.Take(perSearch).ToList();
                sponsoredRail = cards.Skip(perSearch).ToList();
                break;
            }
        }
        var result = new JsonObject
        {
            ["items"] = Arr(await ProductCardsAsync(rows, deliveryBy: delivery)),
            ["sponsored"] = Arr(sponsored),
            ["sponsored_rail"] = Arr(sponsoredRail),
            ["categories"] = Arr(catCounts.Select(c => (JsonNode)new JsonObject { ["name"] = c.Name, ["slug"] = c.Slug, ["count"] = c.Count })),
            ["total"] = total,
            ["page"] = q.Page,
            ["page_size"] = pageSize,
            ["category"] = currentCategory,
            ["breadcrumbs"] = breadcrumbs,
            ["facets"] = new JsonObject
            {
                ["brands"] = Arr(brands.Select(b => (JsonNode)new JsonObject { ["name"] = b.Name, ["count"] = b.Count })),
                ["price_min"] = priceMin,
                ["price_max"] = priceMax,
            },
        };
        return (result, served);
    }

    public async Task<JsonObject> SuggestAsync(string q)
    {
        var text = q.Trim();
        var cfg = await platform.GetAsync();
        var limit = cfg.Int("search_suggestions");
        var titles = new List<(string Title, string Slug)>();
        if (text.Length > 0)
        {
            // the words or a close title (not the brand), closest title first; equally close ones best-selling first
            var queries = SearchSynonyms.Variants(text, SearchSynonyms.Parse(cfg.Str("search_synonyms"))).Select(v => ProductTextQuery.For(v)).ToList();
            var hits = new List<(CatalogDAL.SearchCandidate Product, float Similarity)>();
            foreach (var c in await catalog.SearchCandidatesAsync(new ProductFilter()))
            {
                var best = -1f;
                foreach (var query in queries) if (query.Suggests(c.Entry.Document, out var similarity)) best = Math.Max(best, similarity);
                if (best >= 0) hits.Add((c, best));
            }
            titles = hits.OrderByDescending(h => h.Similarity).ThenByDescending(h => h.Product.SoldCount)
                .ThenBy(h => h.Product.Id.ToString("D"), StringComparer.Ordinal).Take(limit)
                .Select(h => (h.Product.Entry.Document.Title, h.Product.Entry.Slug)).ToList();
        }
        var cats = await catalog.CategoriesNamedLikeAsync(text, Math.Min(4, limit));
        return new JsonObject
        {
            ["products"] = Arr(titles.Select(t => (JsonNode)new JsonObject { ["title"] = t.Title, ["slug"] = t.Slug })),
            ["categories"] = Arr(cats.Select(c => (JsonNode)new JsonObject { ["name"] = c.Name, ["slug"] = c.Slug })),
        };
    }

    // ------------------------------------------------------------------------- product page

    private async Task<string?> BoughtLastMonthAsync(Guid productId, long minimum)
    {
        var units = (await catalog.UnitsSoldSinceAsync([productId], DateTimeFunctions.UtcNow().AddDays(-30))).GetValueOrDefault(productId);
        return units >= minimum ? $"{Bucket(units)} bought in the past month" : null;
    }

    private async Task<JsonObject?> BestsellerRankAsync(ProductModel p)
    {
        if (p.SoldCount <= 0) return null;
        var ahead = await catalog.SellingMoreAsync(p.CategoryId, p.SoldCount);
        var cat = await catalog.GetCategoryAsync(p.CategoryId);
        return new JsonObject { ["rank"] = ahead + 1, ["category"] = cat?.Name ?? "", ["slug"] = cat?.Slug ?? "" };
    }

    private async Task<JsonObject> SellerSnapshotAsync(SellerModel s, JsonObject cfg)
    {
        var now = DateTimeFunctions.UtcNow();
        var since = now.AddDays(-90);
        var (good, total) = await catalog.SellerReviewCountsAsync(s.Id);
        var orders = await catalog.SellerLiveOrdersSinceAsync(s.Id, since);
        var (onTime, shipped) = await catalog.SellerOnTimeAsync(s.Id, s.DispatchDays, since);
        var rating = (double)s.RatingAvg;
        var top = rating * 10 >= cfg.Long("top_seller_min_rating_x10") && s.RatingCount >= 5 && orders >= cfg.Long("top_seller_min_orders");
        var started = s.ApprovedAt ?? s.CreatedAt;
        var months = Math.Max(0, (now.Year - started.Year) * 12 + now.Month - started.Month);
        return new JsonObject
        {
            ["rating_avg"] = rating,
            ["rating_count"] = s.RatingCount,
            ["positive_pct"] = total >= 3 ? (long)Math.Round(100.0 * good / total, MidpointRounding.ToEven) : null,
            ["orders_90d"] = orders >= 5 ? Bucket(orders) : null,
            ["on_time_pct"] = shipped >= 5 ? (long)Math.Round(100.0 * onTime / shipped, MidpointRounding.ToEven) : null,
            ["since"] = started.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["years"] = months / 12,
            ["months"] = months,
            ["top_seller"] = top,
            ["dispatch_days"] = s.DispatchDays,
        };
    }

    /// <summary>The offer's headline and terms: "10% off up to ₹150", "on orders of ₹500 or more".</summary>
    public static (string Title, string Terms) OfferText(CouponModel c)
    {
        string title;
        if (c.Kind == "percent")
        {
            title = $"{(c.Value / 100.0).ToString("G6", CultureInfo.InvariantCulture)}% off";
            if (c.MaxDiscountPaise is > 0) title += $" up to {Rupees(c.MaxDiscountPaise.Value)}";
        }
        else title = $"{Rupees(c.Value)} off";
        var terms = new List<string>();
        if (c.MinOrderPaise > 0) terms.Add($"on orders of {Rupees(c.MinOrderPaise)} or more");
        if (c.FirstOrderOnly) terms.Add("on your first order");
        return (title, string.Join(", ", terms));
    }

    private async Task<JsonArray> OffersForAsync(ProductModel p, SellerModel seller, int limit)
    {
        var chain = (await catalog.CategoryChainAsync(p.CategoryId)).Select(c => c.Id).ToList();
        var outp = new JsonArray();
        foreach (var c in await catalog.OffersAsync(p.SellerId, chain, limit, DateTimeFunctions.UtcNow()))
        {
            var (title, terms) = OfferText(c);
            outp.Add(new JsonObject
            {
                ["code"] = c.Code, ["title"] = title, ["terms"] = terms, ["description"] = c.Description, ["kind"] = c.Kind, ["value"] = c.Value,
                ["max_discount_paise"] = c.MaxDiscountPaise, ["min_order_paise"] = c.MinOrderPaise, ["first_order_only"] = c.FirstOrderOnly,
                ["ends_at"] = DateTimeFunctions.Iso(c.EndsAt), ["source"] = c.SellerId != null ? "seller" : "platform",
                ["source_name"] = c.SellerId != null ? seller.DisplayName : "",
            });
        }
        return outp;
    }

    public async Task<JsonObject> ProductPageAsync(string slug)
    {
        await SyncDealsAsync();
        var p = await catalog.PublicProductBySlugAsync(slug) ?? throw new NotFoundException("Product");
        var seller = await catalog.GetSellerAsync(p.SellerId) ?? throw new NotFoundException("Product");
        var variants = (await catalog.ActiveVariantsAsync([p.Id])).ToList();
        var images = (await catalog.ImagesForAsync([p.Id])).GetValueOrDefault(p.Id) ?? [];
        var cfg = await platform.GetAsync();
        var videos = cfg.Bool("feature_product_videos") ? (await catalog.VideosForAsync([p.Id])).GetValueOrDefault(p.Id) ?? [] : [];
        var breadcrumbs = new JsonArray();
        foreach (var c in Enumerable.Reverse(await catalog.CategoryChainAsync(p.CategoryId)))
            breadcrumbs.Add(new JsonObject { ["name"] = c.Name, ["slug"] = c.Slug });
        var details = ProductInfo.DetailsOf(p.Details);
        var unit = details.NetUnit;
        // option axes, e.g. {"Size": ["S","M","L"], "Colour": ["Red","Blue"]}
        var axes = new JsonObject();
        foreach (var v in variants)
        {
            foreach (var (k, val) in JsonHelper.Node(v.Options) as JsonObject ?? [])
            {
                if (axes[k] is not JsonArray list) axes[k] = list = [];
                if (!list.Any(x => JsonNode.DeepEquals(x, val))) list.Add(val?.DeepClone());
            }
        }
        var similar = cfg.Bool("pdp_similar") && cfg.Int("similar_products") > 0
            ? (await catalog.SimilarAsync(p, Math.Max(1, cfg.Int("similar_products")))).ToList()
            : [];
        var boughtTogether = new List<ProductModel>();
        var btCfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), JsonHelper.Object(await sellerDb.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'")))["bought_together"]!;
        if (btCfg.Bool("enabled")) boughtTogether = (await catalog.BoughtTogetherAsync(p, btCfg.Int("max_items"))).ToList();
        var specs = JsonHelper.Node(p.Specs) as JsonObject ?? [];
        var keySpecs = new JsonArray();
        if (cfg.Bool("pdp_key_specs"))
        {
            var names = details.KeySpecs.Count > 0 ? details.KeySpecs : specs.Select(kv => kv.Key).Take(5).ToList();
            foreach (var k in names.Where(specs.ContainsKey).Take(6))
                keySpecs.Add(new JsonObject { ["label"] = k, ["value"] = specs[k]?.DeepClone() });
            if (p.Brand.Length > 0 && !keySpecs.Any(x => CatalogText.Str(x!["label"]).Equals("brand", StringComparison.OrdinalIgnoreCase)))
                keySpecs.Insert(0, new JsonObject { ["label"] = "Brand", ["value"] = p.Brand });
        }
        var low = cfg.Int("low_stock_threshold");
        var variantsOut = new JsonArray();
        foreach (var v in variants)
        {
            variantsOut.Add(new JsonObject
            {
                ["id"] = v.Id.ToString(),
                ["options"] = JsonHelper.Node(v.Options),
                ["label"] = ProductInfo.VariantLabel(v.Options),
                ["price"] = v.PricePaise,
                ["mrp"] = v.MrpPaise,
                ["discount_pct"] = ProductInfo.DiscountPct(v.PricePaise, v.MrpPaise),
                ["in_stock"] = v.Stock > 0,
                ["low_stock"] = v.Stock > 0 && v.Stock <= low,
                ["stock_left"] = v.Stock <= low ? v.Stock : null,
                ["net_quantity"] = ProductInfo.FmtQty(v.NetQty, unit),
                ["unit_price"] = cfg.Bool("pdp_unit_price") ? ProductInfo.UnitPrice(v.PricePaise, v.NetQty, unit) : null,
            });
        }
        JsonNode? deal = null;
        if (cfg.Bool("feature_deals") && (await ActiveDealsForAsync([p.Id])).TryGetValue(p.Id, out var dd)) deal = dd;
        return new JsonObject
        {
            ["id"] = p.Id.ToString(),
            ["slug"] = p.Slug,
            ["title"] = p.Title,
            ["brand"] = p.Brand,
            ["description"] = p.Description,
            ["highlights"] = JsonHelper.Node(p.Highlights),
            ["specs"] = JsonHelper.Node(p.Specs),
            ["images"] = Arr(images.Select(i => (JsonNode)i)),
            ["videos"] = Arr(videos.Select(v => (JsonNode)new JsonObject { ["url"] = v.Url, ["poster_url"] = v.PosterUrl, ["title"] = v.Title, ["duration_s"] = v.DurationS })),
            ["country_of_origin"] = p.CountryOfOrigin,
            ["return_window_days"] = p.ReturnWindowDays,
            ["rating_avg"] = (double)p.RatingAvg,
            ["rating_count"] = p.RatingCount,
            ["price"] = p.PriceFrom,
            ["mrp"] = p.MrpFrom,
            ["discount_pct"] = ProductInfo.DiscountPct(p.PriceFrom, p.MrpFrom),
            ["in_stock"] = p.InStock,
            ["breadcrumbs"] = breadcrumbs,
            ["option_axes"] = axes,
            ["variants"] = variantsOut,
            ["key_specs"] = keySpecs,
            ["info"] = ProductInfo.InfoRows(details, p.Brand, p.CountryOfOrigin),
            ["important"] = ProductInfo.ImportantInfo(details),
            ["required_missing"] = new JsonArray(), // filled for staff previews only
            ["first_available"] = p.ApprovedAt?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["bought_last_month"] = cfg.Bool("pdp_bought_count") ? await BoughtLastMonthAsync(p.Id, cfg.Long("pdp_bought_min")) : null,
            ["bestseller"] = cfg.Bool("pdp_bestseller_badge") ? await BestsellerRankAsync(p) : null,
            ["offers"] = cfg.Bool("pdp_offers") && cfg.Bool("feature_coupons") ? await OffersForAsync(p, seller, cfg.Int("pdp_offers_max")) : new JsonArray(),
            ["seller_snapshot"] = cfg.Bool("pdp_seller_snapshot") ? await SellerSnapshotAsync(seller, cfg) : null,
            ["returnable"] = p.ReturnWindowDays > 0,
            ["deal"] = deal,
            // Consumer Protection (E-Commerce) Rules 2020, rule 6(5): seller identity shown to buyers.
            ["seller"] = new JsonObject
            {
                ["name"] = seller.DisplayName,
                ["slug"] = seller.Slug,
                ["legal_name"] = seller.LegalName,
                ["gstin"] = seller.Gstin,
                ["city"] = seller.PickupCity,
                ["state"] = IndianStates.Name(seller.PickupStateCode),
                ["grievance_officer"] = new JsonObject { ["name"] = seller.GrievanceName, ["email"] = seller.GrievanceEmail },
                ["dispatch_days"] = seller.DispatchDays,
                // The amount from which this seller's package ships free (the seller's own when Seller shipping is on, else the marketplace's).
                ["free_shipping_threshold_paise"] = CartBAL.FreeThreshold(seller, cfg, await ShippingZones.SellerFreeBoundsAsync(sellerDb)),
            },
            ["similar"] = Arr(await ProductCardsAsync(similar)),
            // "Bought together": other products from the same orders (Admin → Growth; empty while it is off)
            ["bought_together"] = Arr(await ProductCardsAsync(boughtTogether)),
        };
    }

    public async Task<JsonObject> StoreAsync(string slug)
    {
        var s = await catalog.ApprovedSellerBySlugAsync(slug) ?? throw new NotFoundException("Store");
        return new JsonObject
        {
            ["name"] = s.DisplayName,
            ["slug"] = s.Slug,
            ["description"] = s.Description,
            ["city"] = s.PickupCity,
            ["state"] = IndianStates.Name(s.PickupStateCode),
            ["since"] = s.ApprovedAt?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["product_count"] = await catalog.PublicCountForSellerAsync(s.Id),
        };
    }

    public async Task<JsonObject> PlatformAsync()
    {
        var cfg = await platform.GetAsync();
        var b = site.PublicBusiness(await site.GetSiteAsync());
        return new JsonObject
        {
            ["name"] = b["brand"]?.DeepClone(),
            ["legal_name"] = b["legal_name"]?.DeepClone(),
            ["gstin"] = b["gstin"]?.DeepClone(),
            ["registered_address"] = b["registered_address"]?.DeepClone(),
            ["grievance_officer"] = b["grievance"]?.DeepClone(),
            ["free_shipping_threshold_paise"] = cfg.Long("free_shipping_threshold_paise"),
            ["shipping_fee_paise"] = cfg.Long("shipping_fee_paise"),
            ["cod_enabled"] = cfg.Bool("cod_enabled"),
            ["online_payments"] = await razorpay.OnlinePaymentsAsync(),
        };
    }

    // ------------------------------------------------------------------------- home sections

    public async Task<List<JsonObject>> ProductsForAsync(JsonObject config)
    {
        var source = config.TryGetPropertyValue("source", out var s) ? CatalogText.Str(s) : "deals";
        var limit = (int)CatalogText.LenientInt(config.TryGetPropertyValue("limit", out var l) ? l : 12);
        IEnumerable<ProductModel> rows;
        switch (source)
        {
            case "deals" or "bestsellers" or "top_rated" or "new":
                rows = await catalog.RailAsync(source, limit);
                break;
            case "deals_live":
                rows = await catalog.LiveDealProductsAsync(CatalogText.OrEmpty(CatalogText.Get(config, "kind")), limit);
                break;
            case "category":
            {
                var slug = CatalogText.Str(CatalogText.Get(config, "category_slug"));
                var cat = await catalog.CategoryBySlugAsync(slug, activeOnly: false);
                if (cat == null) return [];
                rows = await catalog.RailAsync("category", limit, await CategoryDescendantIdsAsync(cat.Id));
                break;
            }
            case "manual":
            {
                var ids = new List<Guid>();
                foreach (var x in CatalogText.Get(config, "product_ids") as JsonArray ?? [])
                    if (Guid.TryParse(CatalogText.Str(x), out var g)) ids.Add(g);
                var found = (await catalog.PublicProductsByIdsAsync(ids, inStockOnly: true)).ToDictionary(p => p.Id);
                return await ProductCardsAsync(ids.Where(found.ContainsKey).Select(i => found[i]).ToList());
            }
            default:
                return [];
        }
        return await ProductCardsAsync(rows.ToList());
    }
}
