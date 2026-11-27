using System.Text;
using Dapper;
using DAL.Helpers;
using Model.DomainModel;
using Utils;
using Utils.Interface;
using Utils.TextSearch;

namespace DAL;

/// <summary>What a product search or category page asks for (the conditions; sorting and paging are separate).</summary>
public sealed class ProductFilter
{
    /// <summary>The category and its active sub-categories.</summary>
    public List<Guid>? CategoryIds { get; set; }
    public string? SellerSlug { get; set; }
    /// <summary>
    /// For a text search: the products in scope that match the words, each with the order key of its relevance
    /// (<see cref="ProductTextQuery"/>). Null when there are no words.
    /// </summary>
    public IReadOnlyList<(Guid Id, int Key)>? TextMatches { get; set; }
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
    public ProductFilter FacetScope() => new() { CategoryIds = CategoryIds, SellerSlug = SellerSlug, TextMatches = TextMatches };
}

/// <summary>
/// Products, variants, categories, images, videos and the read-only parts of deals, coupons and orders the storefront
/// shows. Text search reads the products' search documents from <see cref="SearchDocumentCache"/>, decides matches and
/// relevance in memory (<see cref="ProductTextQuery"/>) and joins the result into the SQL as a JSON table, so filters,
/// facets, sorting and paging stay in the database.
/// </summary>
public class CatalogDAL(IMySqlDapperHelper db, SearchDocumentCache searchDocs)
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
            "SELECT * FROM categories WHERE slug = @slug AND slug COLLATE utf8mb4_0900_bin = @slug" + (activeOnly ? " AND is_active = 1" : ""), new { slug });

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

    /// <summary>
    /// Active categories whose name contains the text, oldest first. The text is a LIKE pattern: its % and _ match
    /// anything.
    /// </summary>
    public Task<IEnumerable<(string Name, string Slug)>> CategoriesNamedLikeAsync(string text, int limit) =>
        db.QueryAsync<(string, string)>(
            "SELECT name, slug FROM categories WHERE is_active = 1 AND name LIKE @like ORDER BY created_at, position, name LIMIT @limit",
            new { like = "%" + text + "%", limit });

    // ------------------------------------------------------------------------- products

    public Task<ProductModel?> GetProductAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id });

    public Task<ProductModel?> ProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE slug = @slug AND slug COLLATE utf8mb4_0900_bin = @slug", new { slug });

    public Task<ProductModel?> PublicProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>($"SELECT p.* FROM products p WHERE p.slug = @slug AND p.slug COLLATE utf8mb4_0900_bin = @slug AND {PublicFilter}", new { slug });

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

    /// <summary>Public in-stock products that appeared in the same live orders as this one, most often first.</summary>
    public Task<IEnumerable<ProductModel>> BoughtTogetherAsync(ProductModel p, int limit) =>
        db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p JOIN order_items oi ON oi.product_id = p.id JOIN sub_orders so ON so.id = oi.sub_order_id " +
            $"WHERE {PublicFilter} AND p.id <> @id AND p.in_stock = 1 AND so.status IN @live AND so.order_id IN " +
            "(SELECT so2.order_id FROM sub_orders so2 JOIN order_items oi2 ON oi2.sub_order_id = so2.id WHERE oi2.product_id = @id AND so2.status IN @live) " +
            "GROUP BY p.id ORDER BY COUNT(DISTINCT so.order_id) DESC, p.sold_count DESC LIMIT @limit", new { id = p.Id, live = LivePackage, limit });

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
        // only a real change is written (and moves updated_at)
        const string write = "UPDATE products SET price_from = @price, mrp_from = @mrp, in_stock = @inStock, updated_at = @now " +
                             "WHERE id = @productId AND NOT (price_from = @price AND mrp_from = @mrp AND in_stock = @inStock)";
        var args = new { price, mrp, inStock, productId, now = DateTimeFunctions.UtcNow() };
        if (uow != null) await uow.ExecuteAsync(write, args);
        else await db.ExecuteAsync(write, args);
    }

    // ------------------------------------------------------------------------- sellers, warehouses

    public Task<IEnumerable<SellerModel>> SellersAsync(IEnumerable<Guid> ids) =>
        db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE id IN @ids", new { ids = ids.Distinct().ToList() });

    /// <summary>Product counts by status (reference: dashboard product_counts).</summary>
    public async Task<IReadOnlyDictionary<string, long>> ProductStatusCountsAsync(Guid sellerId)
    {
        var rows = await db.QueryAsync<(string Status, long N)>(
            "SELECT status AS Status, COUNT(*) AS N FROM products WHERE seller_id = @sellerId GROUP BY status",
            new { sellerId });
        return rows.ToDictionary(r => r.Status, r => r.N);
    }

    /// <summary>Active variants of approved products at or under the low-stock threshold (reference: dashboard).</summary>
    public Task<long> LowStockCountAsync(Guid sellerId, int threshold) =>
        db.ExecuteScalarAsync<long>(
            @"SELECT COUNT(*) FROM variants v JOIN products p ON p.id = v.product_id
              WHERE v.seller_id = @sellerId AND v.is_active = 1 AND v.stock <= @threshold AND p.status = 'approved'",
            new { sellerId, threshold });

    public Task<SellerModel?> GetSellerAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id });

    /// <summary>The caller's seller account (reference: deps.seller_account).</summary>
    public Task<SellerModel?> GetSellerByUserAsync(Guid userId) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE user_id = @userId", new { userId });

    public Task<SellerModel?> ApprovedSellerBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE slug = @slug AND slug COLLATE utf8mb4_0900_bin = @slug AND status = 'approved'", new { slug });

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

    /// <summary>A product a text search considers: its id, units sold and cached search document.</summary>
    public sealed record SearchCandidate(Guid Id, long SoldCount, SearchEntry Entry);

    /// <summary>
    /// The public products in the scope's category and seller (the words and the other filters aside) with their search
    /// documents: ids, versions and sales come from MySQL, documents from the cache, and only the texts of new or
    /// changed products are read.
    /// </summary>
    public async Task<List<SearchCandidate>> SearchCandidatesAsync(ProductFilter scope)
    {
        var p = new DynamicParameters();
        var where = Where(new ProductFilter { CategoryIds = scope.CategoryIds, SellerSlug = scope.SellerSlug }, p, true);
        var rows = (await db.QueryAsync<(Guid Id, DateTime UpdatedAt, long SoldCount)>(
            $"SELECT p.id, p.updated_at, p.sold_count FROM products p WHERE {where}", p)).ToList();
        var stale = rows.Where(r => searchDocs.Get(r.Id, r.UpdatedAt) is null).Select(r => r.Id).ToList();
        foreach (var ids in stale.Chunk(500))
            foreach (var t in await db.QueryAsync<(Guid Id, DateTime UpdatedAt, string Title, string Brand, string Slug, string Description)>(
                         "SELECT id, updated_at, title, brand, slug, description FROM products WHERE id IN @ids", new { ids }))
                searchDocs.Put(t.Id, new SearchEntry(t.UpdatedAt, t.Slug, SearchDocument.Build(t.Title, t.Brand, t.Description)));
        var outp = new List<SearchCandidate>(rows.Count);
        foreach (var r in rows)
            if (searchDocs.Get(r.Id, r.UpdatedAt) is { } entry) outp.Add(new SearchCandidate(r.Id, r.SoldCount, entry));
        return outp;
    }

    /// <summary>
    /// The rows a filter reads: <c>products p</c>, and for a text search joined with the matching products and their
    /// relevance keys as <c>rk</c> (a JSON table: one parameter, however many products match).
    /// </summary>
    private static string Source(ProductFilter f, DynamicParameters p)
    {
        if (f.TextMatches is null) return "products p";
        var json = new StringBuilder(f.TextMatches.Count * 48 + 2).Append('[');
        foreach (var (id, key) in f.TextMatches)
            json.Append(json.Length > 1 ? ",[\"" : "[\"").Append(id.ToString("D")).Append("\",").Append(key).Append(']');
        p.Add("textMatches", json.Append(']').ToString());
        return "products p JOIN JSON_TABLE(@textMatches, '$[*]' COLUMNS (id CHAR(36) PATH '$[0]', k INT PATH '$[1]')) rk ON rk.id = p.id";
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
            conds.Add("p.seller_id IN (SELECT s2.id FROM sellers s2 WHERE s2.slug = @sellerSlug AND s2.slug COLLATE utf8mb4_0900_bin = @sellerSlug)");
            p.Add("sellerSlug", f.SellerSlug);
        }
        if (facets) return string.Join(" AND ", conds);
        if (f.Brands is { Count: > 0 })
        {
            conds.Add("p.brand COLLATE utf8mb4_0900_bin IN @brands");
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

    public async Task<long> SearchCountAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var from = Source(f, p);
        return await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM {from} WHERE {Where(f, p, false)}", p);
    }

    /// <summary>
    /// One page of results. Sorts: relevance (in stock first, then the text relevance, then units sold), price_asc,
    /// price_desc, newest, rating, discount, popular.
    /// </summary>
    public Task<IEnumerable<ProductModel>> SearchPageAsync(ProductFilter f, string sort, int take, int skip)
    {
        var p = new DynamicParameters();
        var from = Source(f, p);
        var where = Where(f, p, false);
        var order = sort switch
        {
            "price_asc" => "p.price_from ASC, p.id",
            "price_desc" => "p.price_from DESC, p.id",
            "newest" => "p.approved_at IS NULL, p.approved_at DESC, p.id",
            "rating" => "p.rating_avg DESC, p.rating_count DESC, p.id",
            "discount" => "(p.mrp_from - p.price_from) * 100 / NULLIF(p.mrp_from, 0) DESC, p.id",
            "popular" => "p.sold_count DESC, p.id",
            _ => f.TextMatches is not null ? "p.in_stock DESC, rk.k DESC, p.sold_count DESC, p.id" : "p.in_stock DESC, p.sold_count DESC, p.id",
        };
        p.Add("take", take);
        p.Add("skip", skip);
        return db.QueryAsync<ProductModel>($"SELECT p.* FROM {from} WHERE {where} ORDER BY {order} LIMIT @take OFFSET @skip", p);
    }

    /// <summary>
    /// Every brand in the facet scope with its product count. Names are grouped byte for byte (a binary, no-pad
    /// collation): "Tamra" and "TAMRA" stay two brands. The caller orders and limits.
    /// </summary>
    public Task<IEnumerable<(string Name, long Count)>> FacetBrandsAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var from = Source(f, p);
        var where = Where(f, p, true);
        return db.QueryAsync<(string, long)>(
            $"SELECT p.brand COLLATE utf8mb4_0900_bin AS b, COUNT(*) AS n FROM {from} WHERE {where} AND p.brand <> '' GROUP BY b", p);
    }

    public async Task<(long Min, long Max)> FacetPriceRangeAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var from = Source(f, p);
        var where = Where(f, p, true);
        var r = await db.QueryFirstOrDefaultAsync<(long?, long?)>($"SELECT MIN(p.price_from), MAX(p.price_from) FROM {from} WHERE {where}", p);
        return (r.Item1 ?? 0, r.Item2 ?? 0);
    }

    /// <summary>Every category of the products in the facet scope with its product count. The caller orders and limits.</summary>
    public Task<IEnumerable<(string Name, string Slug, long Count)>> FacetCategoriesAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var from = Source(f, p);
        var where = Where(f, p, true);
        return db.QueryAsync<(string, string, long)>(
            $"SELECT c.name, c.slug, COUNT(*) AS n FROM {from} JOIN categories c ON c.id = p.category_id WHERE {where} " +
            "GROUP BY c.id, c.name, c.slug", p);
    }

    public Task<IEnumerable<Guid>> FacetSellerIdsAsync(ProductFilter f)
    {
        var p = new DynamicParameters();
        var from = Source(f, p);
        var where = Where(f, p, true);
        return db.QueryAsync<Guid>($"SELECT DISTINCT p.seller_id FROM {from} WHERE {where}", p);
    }
}
