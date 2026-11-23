using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using DAL.Helpers;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>What a product search or category page asks for (the conditions; sorting and paging are separate).</summary>
public sealed class ProductFilter
{
    /// <summary>The category and its active sub-categories.</summary>
    public List<Guid>? CategoryIds { get; set; }
    public string? SellerSlug { get; set; }
    /// <summary>The shopper's words (already trimmed).</summary>
    public string Text { get; set; } = "";
    /// <summary>Products matched by the typo-tolerant comparison (added to the text matches).</summary>
    public List<Guid> FuzzyIds { get; set; } = [];
    public List<string>? Brands { get; set; }
    public long? MinPrice { get; set; }
    public long? MaxPrice { get; set; }
    public double? MinRating { get; set; }
    public int? MinDiscount { get; set; }
    public bool InStock { get; set; }
    public bool Deal { get; set; }
    /// <summary>Only these sellers (delivery within N days); an empty list matches nothing.</summary>
    public List<Guid>? SellerIds { get; set; }

    /// <summary>The conditions facets are computed with: category, seller and text (before brand and price filters).</summary>
    public ProductFilter FacetScope() => new() { CategoryIds = CategoryIds, SellerSlug = SellerSlug, Text = Text, FuzzyIds = FuzzyIds };
}

/// <summary>
/// Products, variants, categories, images, videos and the read-only parts of deals, coupons and orders the storefront
/// shows. Search uses the FULLTEXT index ft_products_search (title, brand, description) plus LIKE for prefixes.
/// </summary>
public partial class CatalogDAL(IMySqlDapperHelper db)
{
    /// <summary>A product customers may see and buy (approved, priced, from an approved seller not on holiday). Alias p.</summary>
    public const string PublicFilter =
        "p.status = 'approved' AND p.price_from > 0 AND p.seller_id IN (SELECT s.id FROM sellers s WHERE s.status = 'approved' AND s.holiday_mode = 0)";

    public static readonly string[] LivePackage = ["placed", "confirmed", "packed", "shipped", "delivered"];

    // ------------------------------------------------------------------------- categories

    public Task<IEnumerable<CategoryModel>> ActiveCategoriesAsync() =>
        db.QueryAsync<CategoryModel>("SELECT * FROM categories WHERE is_active = 1 ORDER BY position, name");

    public async Task<Dictionary<Guid, int>> PublicCountsByCategoryAsync() =>
        (await db.QueryAsync<(Guid, long)>($"SELECT p.category_id, COUNT(*) FROM products p WHERE {PublicFilter} GROUP BY p.category_id"))
        .ToDictionary(r => r.Item1, r => (int)r.Item2);

    public Task<CategoryModel?> CategoryBySlugAsync(string slug, bool activeOnly) =>
        db.QueryFirstOrDefaultAsync<CategoryModel>(
            "SELECT * FROM categories WHERE slug = @slug" + (activeOnly ? " AND is_active = 1" : ""), new { slug });

    public Task<CategoryModel?> GetCategoryAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<CategoryModel>("SELECT * FROM categories WHERE id = @id", new { id });

    public Task<IEnumerable<(Guid Id, Guid? ParentId)>> ActiveCategoryEdgesAsync() =>
        db.QueryAsync<(Guid, Guid?)>("SELECT id, parent_id FROM categories WHERE is_active = 1");

    /// <summary>The category and its parents, nearest first.</summary>
    public async Task<List<CategoryModel>> CategoryChainAsync(Guid? id)
    {
        var outp = new List<CategoryModel>();
        var seen = new HashSet<Guid>();
        while (id is { } cur && seen.Add(cur))
        {
            var c = await GetCategoryAsync(cur);
            if (c == null) break;
            outp.Add(c);
            id = c.ParentId;
        }
        return outp;
    }

    public Task<IEnumerable<(string Name, string Slug)>> CategoriesNamedLikeAsync(string text, int limit) =>
        db.QueryAsync<(string, string)>("SELECT name, slug FROM categories WHERE is_active = 1 AND name LIKE @like LIMIT @limit",
            new { like = SqlHelpers.Contains(text), limit });

    // ------------------------------------------------------------------------- products

    public Task<ProductModel?> GetProductAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id });

    public Task<ProductModel?> ProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE slug = @slug", new { slug });

    public Task<ProductModel?> PublicProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>($"SELECT p.* FROM products p WHERE p.slug = @slug AND {PublicFilter}", new { slug });

    public Task<IEnumerable<ProductModel>> PublicProductsByIdsAsync(IEnumerable<Guid> ids, bool inStockOnly = false) =>
        db.QueryAsync<ProductModel>($"SELECT p.* FROM products p WHERE p.id IN @ids AND {PublicFilter}" + (inStockOnly ? " AND p.in_stock = 1" : ""),
            new { ids = ids.ToList() });

    /// <summary>Product rails: "deals" (biggest discount), "bestsellers", "bestsellers_sold" (sold at least once), "top_rated", "new".</summary>
    public Task<IEnumerable<ProductModel>> RailAsync(string source, int limit, IEnumerable<Guid>? categoryIds = null)
    {
        var where = $"{PublicFilter} AND p.in_stock = 1";
        var order = "p.id";
        switch (source)
        {
            case "deals":
                where += " AND p.mrp_from > p.price_from";
                order = "(p.mrp_from - p.price_from) * 100 / NULLIF(p.mrp_from, 0) DESC, p.id";
                break;
            case "bestsellers": order = "p.sold_count DESC, p.id"; break;
            case "bestsellers_sold": where += " AND p.sold_count > 0"; order = "p.sold_count DESC"; break;
            case "top_rated": where += " AND p.rating_count > 0"; order = "p.rating_avg DESC, p.rating_count DESC"; break;
            case "new": order = "p.approved_at IS NULL, p.approved_at DESC, p.id"; break;
            case "category": order = "p.sold_count DESC, p.id"; break;
        }
        if (categoryIds != null) where += " AND p.category_id IN @cats";
        return db.QueryAsync<ProductModel>($"SELECT p.* FROM products p WHERE {where} ORDER BY {order} LIMIT @limit",
            new { limit, cats = categoryIds?.ToList() });
    }

    /// <summary>In-stock products with a running deal, soonest-ending first (optionally one kind of deal).</summary>
    public Task<IEnumerable<ProductModel>> LiveDealProductsAsync(string? kind, int limit) =>
        db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p JOIN (SELECT d.product_id, MIN(d.ends_at) AS ends_at FROM deals d WHERE d.status = 'active'" +
            (string.IsNullOrEmpty(kind) ? "" : " AND d.kind = @kind") + " GROUP BY d.product_id) live ON live.product_id = p.id " +
            $"WHERE {PublicFilter} AND p.in_stock = 1 ORDER BY live.ends_at, p.id LIMIT @limit", new { kind, limit });

    /// <summary>Same category, in stock, best sellers first (the "Customers also viewed" rail).</summary>
    public Task<IEnumerable<ProductModel>> SimilarAsync(ProductModel p, int limit) =>
        db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p WHERE {PublicFilter} AND p.category_id = @cat AND p.id <> @id AND p.in_stock = 1 " +
            "ORDER BY p.sold_count DESC, p.rating_avg DESC LIMIT @limit", new { cat = p.CategoryId, id = p.Id, limit });

    public async Task<long> PublicCountForSellerAsync(Guid sellerId) =>
        await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM products p WHERE {PublicFilter} AND p.seller_id = @sellerId", new { sellerId });

    /// <summary>Public products in the category selling more than this one (the best-seller rank).</summary>
    public async Task<long> SellingMoreAsync(Guid categoryId, int soldCount) =>
        await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM products p WHERE {PublicFilter} AND p.category_id = @categoryId AND p.sold_count > @soldCount",
            new { categoryId, soldCount });

    public async Task<Dictionary<Guid, List<string>>> ImagesForAsync(IEnumerable<Guid> productIds)
    {
        var ids = productIds.Distinct().ToList();
        if (ids.Count == 0) return [];
        var rows = await db.QueryAsync<(Guid, string)>("SELECT product_id, url FROM product_images WHERE product_id IN @ids ORDER BY position", new { ids });
        var outp = new Dictionary<Guid, List<string>>();
        foreach (var (pid, url) in rows)
        {
            if (!outp.TryGetValue(pid, out var l)) outp[pid] = l = [];
            l.Add(url);
        }
        return outp;
    }

    public async Task<Dictionary<Guid, List<ProductVideoModel>>> VideosForAsync(IEnumerable<Guid> productIds)
    {
        var ids = productIds.Distinct().ToList();
        if (ids.Count == 0) return [];
        var rows = await db.QueryAsync<ProductVideoModel>("SELECT * FROM product_videos WHERE product_id IN @ids ORDER BY position", new { ids });
        return rows.GroupBy(v => v.ProductId).ToDictionary(g => g.Key, g => g.ToList());
    }

    public Task<IEnumerable<VariantModel>> ActiveVariantsAsync(IEnumerable<Guid> productIds) =>
        db.QueryAsync<VariantModel>("SELECT * FROM variants WHERE product_id IN @ids AND is_active = 1 ORDER BY price_paise, created_at",
            new { ids = productIds.Distinct().ToList() });

    public Task<VariantModel?> GetVariantAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id = @id", new { id });

    /// <summary>refresh_product_aggregates: cheapest in-stock active version sets price_from, mrp_from and in_stock.</summary>
    public async Task RefreshAggregatesAsync(Guid productId, IUnitOfWork? uow = null)
    {
        const string read = "SELECT * FROM variants WHERE product_id = @productId AND is_active = 1";
        var variants = (uow != null ? await uow.QueryAsync<VariantModel>(read, new { productId }) : await db.QueryAsync<VariantModel>(read, new { productId })).ToList();
        long price = 0, mrp = 0;
        var inStock = false;
        if (variants.Count > 0)
        {
            var stocked = variants.Where(v => v.Stock > 0).ToList();
            var cheapest = (stocked.Count > 0 ? stocked : variants).OrderBy(v => v.PricePaise).First();
            (price, mrp, inStock) = (cheapest.PricePaise, cheapest.MrpPaise, stocked.Count > 0);
        }
        const string write = "UPDATE products SET price_from = @price, mrp_from = @mrp, in_stock = @inStock, updated_at = @now WHERE id = @productId";
        var args = new { price, mrp, inStock, productId, now = DateTimeFunctions.UtcNow() };
        if (uow != null) await uow.ExecuteAsync(write, args);
        else await db.ExecuteAsync(write, args);
    }

    // ------------------------------------------------------------------------- sellers, warehouses

    public Task<IEnumerable<SellerModel>> SellersAsync(IEnumerable<Guid> ids) =>
        db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE id IN @ids", new { ids = ids.Distinct().ToList() });

    public Task<SellerModel?> GetSellerAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id });

    public Task<SellerModel?> ApprovedSellerBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE slug = @slug AND status = 'approved'", new { slug });

    public Task<IEnumerable<WarehouseModel>> ActiveWarehousesAsync(IEnumerable<Guid> sellerIds) =>
        db.QueryAsync<WarehouseModel>("SELECT * FROM warehouses WHERE seller_id IN @ids AND is_active = 1 ORDER BY is_default DESC",
            new { ids = sellerIds.Distinct().ToList() });

    // ------------------------------------------------------------------------- deals, orders, coupons (read only)

    /// <summary>Running deals of these products, lowest deal price first.</summary>
    public Task<IEnumerable<DealModel>> ActiveDealsAsync(IEnumerable<Guid> productIds) =>
        db.QueryAsync<DealModel>("SELECT * FROM deals WHERE product_id IN @ids AND status = 'active' ORDER BY deal_price_paise",
            new { ids = productIds.Distinct().ToList() });

    /// <summary>Units sold per product in live packages placed since the given time.</summary>
    public async Task<Dictionary<Guid, long>> UnitsSoldSinceAsync(IEnumerable<Guid> productIds, DateTime since) =>
        (await db.QueryAsync<(Guid, decimal)>(
            "SELECT oi.product_id, SUM(oi.qty) FROM order_items oi JOIN sub_orders so ON so.id = oi.sub_order_id " +
            "WHERE oi.product_id IN @ids AND so.status IN @live AND so.created_at >= @since GROUP BY oi.product_id",
            new { ids = productIds.Distinct().ToList(), live = LivePackage, since }))
        .ToDictionary(r => r.Item1, r => (long)r.Item2);

    /// <summary>(reviews rated 4 or 5, all published reviews) of the seller's products.</summary>
    public async Task<(long Good, long Total)> SellerReviewCountsAsync(Guid sellerId)
    {
        var r = await db.QueryFirstOrDefaultAsync<(decimal?, long)>(
            "SELECT SUM(CASE WHEN r.rating >= 4 THEN 1 ELSE 0 END), COUNT(*) FROM reviews r JOIN products p ON p.id = r.product_id " +
            "WHERE p.seller_id = @sellerId AND r.status = 'published'", new { sellerId });
        return ((long)(r.Item1 ?? 0), r.Item2);
    }

    public async Task<long> SellerLiveOrdersSinceAsync(Guid sellerId, DateTime since) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND status IN @live AND created_at >= @since",
            new { sellerId, live = LivePackage, since });

    /// <summary>(shipped within dispatch days + 1, shipped) packages since the given time.</summary>
    public async Task<(long OnTime, long Shipped)> SellerOnTimeAsync(Guid sellerId, int dispatchDays, DateTime since)
    {
        var r = await db.QueryFirstOrDefaultAsync<(decimal?, long)>(
            "SELECT SUM(CASE WHEN shipped_at <= DATE_ADD(created_at, INTERVAL @days DAY) THEN 1 ELSE 0 END), COUNT(*) FROM sub_orders " +
            "WHERE seller_id = @sellerId AND shipped_at IS NOT NULL AND created_at >= @since", new { sellerId, days = dispatchDays + 1, since });
        return ((long)(r.Item1 ?? 0), r.Item2);
    }

    /// <summary>Coupons shown on the product page: active, in their dates, not used up, platform-wide or this seller's, store-wide or for the category chain.</summary>
    public Task<IEnumerable<CouponModel>> OffersAsync(Guid sellerId, IEnumerable<Guid> categoryChain, int limit, DateTime now) =>
        db.QueryAsync<CouponModel>(
            "SELECT * FROM coupons WHERE is_active = 1 AND show_on_checkout = 1 AND (starts_at IS NULL OR starts_at <= @now) " +
            "AND (ends_at IS NULL OR ends_at >= @now) AND (usage_limit IS NULL OR used_count < usage_limit) " +
            "AND (seller_id IS NULL OR seller_id = @sellerId) AND (category_id IS NULL OR category_id IN @chain) " +
            "ORDER BY ends_at IS NULL, ends_at ASC, created_at DESC LIMIT @limit",
            new { now, sellerId, chain = categoryChain.ToList(), limit });

    /// <summary>Products most often in the same order as this one (last 180 days, live packages), still on sale and in stock.</summary>
    public Task<IEnumerable<ProductModel>> BoughtTogetherAsync(Guid productId, DateTime since, int limit) =>
        db.QueryAsync<ProductModel>(
            "SELECT p.* FROM products p JOIN (" +
            "  SELECT oi.product_id, COUNT(DISTINCT so.order_id) AS n FROM order_items oi JOIN sub_orders so ON so.id = oi.sub_order_id " +
            "  WHERE so.order_id IN (SELECT so2.order_id FROM sub_orders so2 JOIN order_items oi2 ON oi2.sub_order_id = so2.id " +
            "    WHERE oi2.product_id = @productId AND so2.status IN @live AND so2.created_at >= @since) " +
            "  AND oi.product_id <> @productId AND so.status IN @live GROUP BY oi.product_id) other ON other.product_id = p.id " +
            $"WHERE {PublicFilter} AND p.in_stock = 1 ORDER BY other.n DESC, p.sold_count DESC LIMIT @limit",
            new { productId, live = LivePackage, since, limit });

    // ------------------------------------------------------------------------- search

    [GeneratedRegex(@"[^\w]+")]
    private static partial Regex NonWord();

    /// <summary>The shopper's words for the full-text index: lower case, at most 8 (the reference's prefix tsquery).</summary>
    public static List<string> Tokens(string text) =>
        NonWord().Split(text.ToLowerInvariant()).Where(t => t.Length > 0).Take(8).ToList();

    /// <summary>A BOOLEAN MODE query: every word required, each as a prefix ("+phon* +5g*"); null when no word is long enough to be indexed.</summary>
    public static string? BooleanQuery(string text)
    {
        var words = Tokens(text).Where(t => t.Length >= 3).ToList();
        return words.Count == 0 ? null : string.Join(" ", words.Select(w => $"+{w}*"));
    }

    private static string Where(ProductFilter f, DynamicParameters p, bool facets)
    {
        var conds = new List<string> { PublicFilter };
        if (f.CategoryIds != null)
        {
            conds.Add("p.category_id IN @cats");
            p.Add("cats", f.CategoryIds);
        }
        if (f.SellerSlug != null)
        {
            conds.Add("p.seller_id IN (SELECT s2.id FROM sellers s2 WHERE s2.slug = @sellerSlug)");
            p.Add("sellerSlug", f.SellerSlug);
        }
        if (f.Text.Length > 0)
        {
            var ftq = BooleanQuery(f.Text);
            var parts = new List<string> { "p.title LIKE @textLike", "p.brand = @text" };
            if (ftq != null)
            {
                parts.Insert(0, "MATCH(p.title, p.brand, p.description) AGAINST (@ftq IN BOOLEAN MODE)");
                p.Add("ftq", ftq);
            }
            if (f.FuzzyIds.Count > 0)
            {
                parts.Add("p.id IN @fuzzy");
                p.Add("fuzzy", f.FuzzyIds);
            }
            conds.Add("(" + string.Join(" OR ", parts) + ")");
            p.Add("text", f.Text);
            p.Add("textLike", SqlHelpers.Contains(f.Text));
        }
        if (facets) return string.Join(" AND ", conds);
        if (f.Brands is { Count: > 0 })
        {
            conds.Add("p.brand IN @brands");
            p.Add("brands", f.Brands);
        }
        if (f.MinPrice != null) { conds.Add("p.price_from >= @minPrice"); p.Add("minPrice", f.MinPrice); }
        if (f.MaxPrice != null) { conds.Add("p.price_from <= @maxPrice"); p.Add("maxPrice", f.MaxPrice); }
        if (f.MinRating != null) { conds.Add("p.rating_avg >= @minRating"); p.Add("minRating", f.MinRating); }
        if (f.MinDiscount is > 0) { conds.Add("(p.mrp_from - p.price_from) * 100 >= p.mrp_from * @minDiscount"); p.Add("minDiscount", f.MinDiscount); }
        if (f.InStock) conds.Add("p.in_stock = 1");
        if (f.Deal) conds.Add("p.id IN (SELECT d.product_id FROM deals d WHERE d.status = 'active')");
        if (f.SellerIds != null)
        {
            conds.Add(f.SellerIds.Count == 0 ? "1 = 0" : "p.seller_id IN @sellerIds");
            p.Add("sellerIds", f.SellerIds);
        }
        return string.Join(" AND ", conds);
    }

    /// <summary>Relevance: exact title, title prefix, a word of the title starting with the words, then the full-text score.</summary>
    private static string Rank(ProductFilter f, DynamicParameters p)
    {
        if (f.Text.Length == 0) return "0";
        p.Add("textPrefix", SqlHelpers.StartsWith(f.Text));
        p.Add("textWord", "% " + SqlHelpers.StartsWith(f.Text));
        var sb = new StringBuilder("((p.title = @text) * 4 + (p.title LIKE @textPrefix) * 2 + (p.title LIKE @textWord)");
        if (BooleanQuery(f.Text) != null) sb.Append(" + MATCH(p.title, p.brand, p.description) AGAINST (@ftq IN BOOLEAN MODE)");
        return sb.Append(')').ToString();
    }

    public async Task<long> SearchCountAsync(ProductFilter f, bool facetScope = false)
    {
        var p = new DynamicParameters();
        var where = Where(f, p, facetScope);
        return await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM products p WHERE {where}", p);
    }

    /// <summary>One page of results. Sorts: relevance, price_asc, price_desc, newest, rating, discount, popular.</summary>
    public Task<IEnumerable<ProductModel>> SearchPageAsync(ProductFilter f, string sort, int take, int skip)
    {
        var p = new DynamicParameters();
        var where = Where(f, p, false);
        var order = sort switch
        {
            "price_asc" => "p.price_from ASC, p.id",
            "price_desc" => "p.price_from DESC, p.id",
            "newest" => "p.approved_at IS NULL, p.approved_at DESC, p.id",
            "rating" => "p.rating_avg DESC, p.rating_count DESC, p.id",
            "discount" => "(p.mrp_from - p.price_from) * 100 / NULLIF(p.mrp_from, 0) DESC, p.id",
            "popular" => "p.sold_count DESC, p.id",
            _ => $"p.in_stock DESC, {Rank(f, p)} DESC, p.sold_count DESC, p.id",
        };
        p.Add("take", take);
        p.Add("skip", skip);
        return db.QueryAsync<ProductModel>($"SELECT p.* FROM products p WHERE {where} ORDER BY {order} LIMIT @take OFFSET @skip", p);
    }

    /// <summary>Brands with their counts in the facet scope, most products first.</summary>
    public Task<IEnumerable<(string Name, long Count)>> FacetBrandsAsync(ProductFilter f, int limit)
    {
        var p = new DynamicParameters();
        var where = Where(f, p, true);
        p.Add("limit", limit);
        return db.QueryAsync<(string, long)>(
            $"SELECT p.brand, COUNT(*) AS n FROM products p WHERE {where} AND p.brand <> '' GROUP BY p.brand ORDER BY n DESC LIMIT @limit", p);
    }

    public async Task<(long Min, long Max)> FacetPriceRangeAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var where = Where(f, p, true);
        var r = await db.QueryFirstOrDefaultAsync<(long?, long?)>($"SELECT MIN(p.price_from), MAX(p.price_from) FROM products p WHERE {where}", p);
        return (r.Item1 ?? 0, r.Item2 ?? 0);
    }

    public Task<IEnumerable<(string Name, string Slug, long Count)>> FacetCategoriesAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var where = Where(f, p, true);
        return db.QueryAsync<(string, string, long)>(
            $"SELECT c.name, c.slug, COUNT(*) AS n FROM categories c JOIN products p ON p.category_id = c.id WHERE {where} " +
            "GROUP BY c.name, c.slug ORDER BY n DESC LIMIT 8", p);
    }

    public Task<IEnumerable<Guid>> FacetSellerIdsAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var where = Where(f, p, true);
        return db.QueryAsync<Guid>($"SELECT DISTINCT p.seller_id FROM products p WHERE {where}", p);
    }

    /// <summary>
    /// Titles to compare for typo tolerance (public products in the scope without the text condition), best sellers
    /// first, at most <paramref name="limit"/>.
    /// </summary>
    public Task<IEnumerable<(Guid Id, string Title)>> CandidateTitlesAsync(ProductFilter scopeWithoutText, int limit)
    {
        var p = new DynamicParameters();
        var where = Where(new ProductFilter { CategoryIds = scopeWithoutText.CategoryIds, SellerSlug = scopeWithoutText.SellerSlug }, p, true);
        p.Add("limit", limit);
        return db.QueryAsync<(Guid, string)>($"SELECT p.id, p.title FROM products p WHERE {where} ORDER BY p.sold_count DESC, p.id LIMIT @limit", p);
    }

    /// <summary>Title suggestions while typing: (title, slug), best match first.</summary>
    public Task<IEnumerable<(string Title, string Slug)>> SuggestAsync(string text, List<Guid> fuzzyIds, int limit)
    {
        var f = new ProductFilter { Text = text, FuzzyIds = fuzzyIds };
        var p = new DynamicParameters();
        var where = Where(f, p, true);
        var rank = Rank(f, p);
        p.Add("limit", limit);
        return db.QueryAsync<(string, string)>($"SELECT p.title, p.slug FROM products p WHERE {where} ORDER BY {rank} DESC, p.sold_count DESC, p.id LIMIT @limit", p);
    }
}
