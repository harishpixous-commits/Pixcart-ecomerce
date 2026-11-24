using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Utils;

namespace BAL;

/// <summary>
/// The deals page, bestsellers/new releases and the coupons page (reference: routers/promotions.py shopper routes).
/// </summary>
public class PromotionsBAL(PromotionsDAL promotions, ICatalogBAL catalog, IPlatformSettingsBAL platform, IDealSync dealSync) : IPromotionsBAL
{
    private const string PublicProduct =
        "p.status = 'approved' AND p.price_from > 0 AND p.seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)";

    /// <summary>Reference services/deals.py KINDS.</summary>
    private static readonly IReadOnlyDictionary<string, string> Kinds = new Dictionary<string, string>
    {
        ["lightning"] = "Lightning deal", ["deal_of_day"] = "Deal of the Day", ["limited"] = "Limited time deal",
    };

    public async Task<JsonObject> DealsPageAsync(string tab, string? kind, string? category, int? minDiscount, double? minRating,
        int? minPrice, int? maxPrice, string sort, int page)
    {
        var cfg = await platform.GetAsync();
        await dealSync.SyncAsync();
        var where = PublicProduct;
        List<Guid>? catIds = null;
        if (category is not null)
        {
            var cat = await promotions.CategoryBySlugAsync(category) ?? throw new NotFoundException("Category");
            catIds = await catalog.CategoryDescendantIdsAsync(cat.Id);
            where += " AND p.category_id IN @catIds";
        }
        if (minDiscount is not null) where += " AND (p.mrp_from - p.price_from) * 100 >= p.mrp_from * @minDiscount";
        if (minRating is not null) where += " AND p.rating_avg >= @minRating";
        if (minPrice is not null) where += " AND p.price_from >= @minPrice";
        if (maxPrice is not null) where += " AND p.price_from <= @maxPrice";
        var args = new { catIds, minDiscount, minRating, minPrice, maxPrice };
        const string discount = "(p.mrp_from - p.price_from) * 100 / NULLIF(p.mrp_from, 0)";

        if (tab == "upcoming")
        {
            var rows = await promotions.UpcomingDealsAsync(where, args);
            var cards = await catalog.ProductCardsAsync(rows.Select(r => r.Product).ToList());
            var items = new JsonArray();
            for (var i = 0; i < rows.Count; i++)
            {
                var card = cards[i].DeepClone() as JsonObject ?? [];
                card["starts_at"] = rows[i].StartsAt.ToString("yyyy-MM-ddTHH:mm:ss");
                items.Add(card);
            }
            return new JsonObject
            {
                ["items"] = items, ["total"] = rows.Count, ["page"] = 1, ["page_size"] = 60,
                ["facets"] = new JsonObject(), ["tab"] = tab,
            };
        }

        List<Model.DomainModel.ProductModel> products;
        long total;
        if (tab == "discounts")
        {
            var order = sort switch
            {
                "price_asc" => "p.price_from",
                "price_desc" => "p.price_from DESC",
                "rating" => "p.rating_avg DESC",
                _ => $"{discount} DESC",
            };
            (products, total) = await promotions.DiscountedAsync(where, args, order, (page - 1) * 30, 30);
        }
        else
        {
            var order = sort switch
            {
                "ending" => "live.ends_at",
                "discount" => $"{discount} DESC",
                "price_asc" => "p.price_from",
                "price_desc" => "p.price_from DESC",
                "rating" => "p.rating_avg DESC",
                _ => $"live.rnk DESC, {discount} DESC",
            };
            var (rows, n) = await promotions.LiveDealsAsync(where, args, order, (page - 1) * 30, 30, kind);
            products = rows.Select(r => r.Product).ToList();
            total = n;
        }

        // Departments (top-level categories) with live-deal counts, for the filter list.
        var tree = await catalog.CategoryTreeAsync();
        var deptCounts = new JsonArray();
        if (tab == "live")
        {
            foreach (var root in tree)
            {
                if (root is not JsonObject r) continue;
                var ids = await catalog.CategoryDescendantIdsAsync(Guid.Parse(r["id"]!.GetValue<string>()));
                var n = await promotions.DepartmentDealCountAsync(ids);
                if (n > 0)
                {
                    deptCounts.Add(new JsonObject { ["name"] = r["name"]?.GetValue<string>(), ["slug"] = r["slug"]?.GetValue<string>(), ["count"] = n });
                }
            }
        }
        var kindCounts = await promotions.DealKindCountsAsync();
        var kindsNode = new JsonObject();
        foreach (var k in Kinds.Keys)
        {
            kindsNode[k] = kindCounts.GetValueOrDefault(k);
        }
        var upcoming = await promotions.UpcomingDealCountAsync();
        var items2 = new JsonArray();
        foreach (var card in await catalog.ProductCardsAsync(products))
        {
            items2.Add(card);
        }
        return new JsonObject
        {
            ["items"] = items2, ["total"] = total, ["page"] = page, ["page_size"] = 30, ["tab"] = tab,
            ["facets"] = new JsonObject { ["departments"] = deptCounts, ["kinds"] = kindsNode, ["upcoming"] = upcoming },
            ["enabled"] = cfg.Bool("feature_deals"), ["upcoming"] = new JsonArray(),
        };
    }

    /// <summary>Bestsellers or Hot New Releases: one ranked list for a category, or the top 10 of every department.</summary>
    public async Task<JsonObject> TopListsAsync(string list, string? category)
    {
        var cfg = await platform.GetAsync();
        var newSince = list == "new" ? DateTime.UtcNow.AddDays(-cfg.Int("new_release_days")) : (DateTime?)null;
        var tree = await catalog.CategoryTreeAsync();
        if (category is not null)
        {
            var cat = await promotions.CategoryBySlugAsync(category, activeOnly: true) ?? throw new NotFoundException("Category");
            var products = (await promotions.RankedAsync(await catalog.CategoryDescendantIdsAsync(cat.Id), 50, newSince)).ToList();
            var crumbs = new JsonArray();
            var cur = cat;
            while (true)
            {
                var crumb = new JsonObject { ["name"] = cur.Name, ["slug"] = cur.Slug };
                crumbs.Insert(0, crumb);
                if (cur.ParentId is not Guid parentId) break;
                var parent = await promotions.GetCategoryAsync(parentId);
                if (parent is null) break;
                cur = parent;
            }
            var children = new JsonArray();
            foreach (var c in await promotions.ChildCategoriesAsync(cat.Id))
            {
                children.Add(new JsonObject { ["name"] = c.Name, ["slug"] = c.Slug });
            }
            var items = new JsonArray();
            foreach (var card in await catalog.ProductCardsAsync(products))
            {
                items.Add(card);
            }
            return new JsonObject
            {
                ["list"] = list,
                ["category"] = new JsonObject { ["name"] = cat.Name, ["slug"] = cat.Slug },
                ["breadcrumbs"] = crumbs, ["children"] = children, ["items"] = items, ["tree"] = tree,
            };
        }
        var sections = new JsonArray();
        foreach (var root in tree)
        {
            if (root is not JsonObject r || r["product_count"]?.GetValue<int>() is not > 0) continue;
            var products = (await promotions.RankedAsync(await catalog.CategoryDescendantIdsAsync(Guid.Parse(r["id"]!.GetValue<string>())), 10, newSince)).ToList();
            if (products.Count == 0) continue;
            var items = new JsonArray();
            foreach (var card in await catalog.ProductCardsAsync(products))
            {
                items.Add(card);
            }
            sections.Add(new JsonObject
            {
                ["category"] = new JsonObject { ["name"] = r["name"]?.GetValue<string>(), ["slug"] = r["slug"]?.GetValue<string>() },
                ["items"] = items,
            });
        }
        return new JsonObject { ["list"] = list, ["category"] = null, ["sections"] = sections, ["tree"] = tree, ["new_release_days"] = cfg.Int("new_release_days") };
    }

    public async Task<JsonObject> CouponsPageAsync()
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_coupons"))
        {
            return new JsonObject { ["items"] = new JsonArray(), ["enabled"] = false };
        }
        var items = new JsonArray();
        foreach (var c in await promotions.CouponsAsync())
        {
            var (title, terms) = CatalogBAL.OfferText(c);
            var shop = c.SellerSlug is not null ? $"/search?seller={c.SellerSlug}" : c.CategorySlug is not null ? $"/c/{c.CategorySlug}" : "/search?sort=popular";
            items.Add(new JsonObject
            {
                ["code"] = c.Code,
                ["title"] = title,
                ["terms"] = terms,
                ["description"] = c.Description,
                ["source"] = c.SellerId is not null ? "seller" : "platform",
                ["seller"] = c.SellerName ?? "",
                ["category"] = c.CategoryName ?? "",
                ["shop_link"] = shop,
                ["min_order_paise"] = c.MinOrderPaise,
                ["first_order_only"] = c.FirstOrderOnly,
                ["ends_at"] = c.EndsAt?.ToString("yyyy-MM-ddTHH:mm:ss"),
            });
        }
        return new JsonObject { ["items"] = items, ["enabled"] = true };
    }

    public async Task<JsonObject> RelatedAsync(IReadOnlyList<Guid> ids, int limit)
    {
        if (ids.Count == 0) return new JsonObject { ["items"] = new JsonArray() };
        var cats = await promotions.CategoriesOfAsync(ids);
        if (cats.Count == 0) return new JsonObject { ["items"] = new JsonArray() };
        var rows = (await promotions.RelatedAsync(cats, ids, limit)).ToList();
        return new JsonObject { ["items"] = new JsonArray((await catalog.ProductCardsAsync(rows)).Select(c => c.DeepClone()).ToArray<JsonNode>()) };
    }

    public async Task<JsonObject> BuyAgainAsync(Guid userId, int limit)
    {
        var rows = (await promotions.BuyAgainAsync(userId, limit)).ToList();
        return new JsonObject { ["items"] = new JsonArray((await catalog.ProductCardsAsync(rows)).Select(c => c.DeepClone()).ToArray<JsonNode>()) };
    }
}
