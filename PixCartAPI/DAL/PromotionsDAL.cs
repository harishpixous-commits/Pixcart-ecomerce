using Dapper;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Reads for the deals page, top lists and the coupons page (reference: routers/promotions.py).</summary>
public class PromotionsDAL(IMySqlDapperHelper db)
{
    private const string PublicProduct =
        "p.status = 'approved' AND p.price_from > 0 AND p.seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)";

    public Task<CategoryModel?> CategoryBySlugAsync(string slug, bool activeOnly = false) =>
        db.QueryFirstOrDefaultAsync<CategoryModel>(
            $"SELECT * FROM categories WHERE slug = @slug{(activeOnly ? " AND is_active = 1" : "")}", new { slug });

    /// <summary>Live deals: one row per product with the soonest end and the best kind rank (reference: deals_page live).</summary>
    public async Task<(List<(ProductModel Product, DateTime EndsAt, int Rank)> Rows, long Total)> LiveDealsAsync(
        string where, object p, string order, int offset, int size, string? kind)
    {
        var live = "SELECT product_id, MIN(ends_at) AS ends_at, MAX(CASE kind WHEN 'lightning' THEN 3 WHEN 'deal_of_day' THEN 2 ELSE 1 END) AS rnk " +
                   $"FROM deals WHERE status = 'active'{(kind is null ? "" : " AND kind = @kind")} GROUP BY product_id";
        var from = $"FROM products p JOIN ({live}) live ON live.product_id = p.id WHERE {where}";
        var param = new DynamicParameters(p);
        param.Add("kind", kind);
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from}", param);
        var rows = await db.QueryAsync<LiveDealRow>(
            $"SELECT p.*, live.ends_at AS live_ends_at, live.rnk AS live_rank {from} ORDER BY {order}, p.id LIMIT {size} OFFSET {offset}", param);
        return (rows.Select(r => ((ProductModel)r, r.LiveEndsAt, r.LiveRank)).ToList(), total);
    }

    public class LiveDealRow : ProductModel
    {
        public DateTime LiveEndsAt { get; set; }
        public int LiveRank { get; set; }
    }

    /// <summary>Approved deals starting within a week, soonest first (reference: deals_page upcoming).</summary>
    public async Task<List<(ProductModel Product, DateTime StartsAt)>> UpcomingDealsAsync(string where, object p)
    {
        var rows = await db.QueryAsync<UpcomingDealRow>(
            "SELECT p.*, soon.starts_at AS soon_starts_at FROM products p JOIN (" +
            "SELECT product_id, MIN(starts_at) AS starts_at FROM deals WHERE status = 'approved' AND starts_at > UTC_TIMESTAMP(6) " +
            "AND starts_at <= UTC_TIMESTAMP(6) + INTERVAL 7 DAY GROUP BY product_id" +
            $") soon ON soon.product_id = p.id WHERE {where} ORDER BY soon.starts_at LIMIT 60", p);
        return rows.Select(r => ((ProductModel)r, r.SoonStartsAt)).ToList();
    }

    public class UpcomingDealRow : ProductModel
    {
        public DateTime SoonStartsAt { get; set; }
    }

    /// <summary>Discounted in-stock products (reference: deals_page discounts tab).</summary>
    public async Task<(List<ProductModel> Rows, long Total)> DiscountedAsync(string where, object p, string order, int offset, int size)
    {
        var from = $"FROM products p WHERE {where} AND p.mrp_from > p.price_from AND p.in_stock = 1";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from}", p);
        var rows = await db.QueryAsync<ProductModel>($"SELECT p.* {from} ORDER BY {order}, p.id LIMIT {size} OFFSET {offset}", p);
        return (rows.ToList(), total);
    }

    /// <summary>Live-deal product counts per department (reference: dept_counts).</summary>
    public async Task<long> DepartmentDealCountAsync(IReadOnlyList<Guid> categoryIds) =>
        await db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM products p WHERE {PublicProduct} " +
            "AND p.id IN (SELECT product_id FROM deals WHERE status = 'active') AND p.category_id IN @categoryIds", new { categoryIds });

    /// <summary>Active deal kinds with distinct product counts.</summary>
    public async Task<Dictionary<string, long>> DealKindCountsAsync()
    {
        var rows = await db.QueryAsync<(string Kind, long N)>(
            "SELECT kind, COUNT(DISTINCT product_id) FROM deals WHERE status = 'active' GROUP BY kind");
        return rows.ToDictionary(x => x.Kind, x => x.N);
    }

    public async Task<long> UpcomingDealCountAsync() =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(DISTINCT product_id) FROM deals WHERE status = 'approved' AND starts_at > UTC_TIMESTAMP(6) " +
            "AND starts_at <= UTC_TIMESTAMP(6) + INTERVAL 7 DAY");

    /// <summary>Products ranked by units sold in the last 30 days (reference: _ranked).</summary>
    public Task<IEnumerable<ProductModel>> RankedAsync(IReadOnlyList<Guid>? categoryIds, int limit, DateTime? newSince)
    {
        var where = PublicProduct + (categoryIds is not null ? " AND p.category_id IN @categoryIds" : "") +
            (newSince is not null ? " AND p.approved_at >= @newSince" : "");
        var order = newSince is not null
            ? "units DESC, p.approved_at DESC, p.id"
            : "units DESC, p.sold_count DESC, p.rating_avg DESC, p.id";
        return db.QueryAsync<ProductModel>(
            "SELECT p.*, COALESCE(recent.units, 0) AS units FROM products p LEFT JOIN (" +
            "SELECT i.product_id, SUM(i.qty) AS units FROM order_items i JOIN sub_orders s ON s.id = i.sub_order_id " +
            "WHERE s.status IN @live AND s.created_at >= @since GROUP BY i.product_id" +
            $") recent ON recent.product_id = p.id WHERE {where} ORDER BY {order} LIMIT {limit}",
            new { categoryIds, newSince, live = CatalogDAL.LivePackage, since = DateTime.UtcNow.AddDays(-30) });
    }

    /// <summary>A category's breadcrumb ancestors and children (reference: top_lists).</summary>
    public Task<CategoryModel?> GetCategoryAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<CategoryModel>("SELECT * FROM categories WHERE id = @id", new { id });

    public Task<IEnumerable<CategoryModel>> ChildCategoriesAsync(Guid parentId) =>
        db.QueryAsync<CategoryModel>(
            "SELECT * FROM categories WHERE parent_id = @parentId AND is_active = 1 ORDER BY position, name", new { parentId });

    public class CouponRow : CouponModel
    {
        public string? SellerName { get; set; }
        public string? SellerSlug { get; set; }
        public string? CategoryName { get; set; }
        public string? CategorySlug { get; set; }
    }

    /// <summary>Checkout-visible coupons, seller ones after platform ones (reference: coupons_page).</summary>
    public Task<IEnumerable<CouponRow>> CouponsAsync() =>
        db.QueryAsync<CouponRow>(
            "SELECT c.*, s.display_name AS seller_name, s.slug AS seller_slug, cat.name AS category_name, cat.slug AS category_slug " +
            "FROM coupons c LEFT JOIN sellers s ON s.id = c.seller_id LEFT JOIN categories cat ON cat.id = c.category_id " +
            "WHERE c.is_active = 1 AND c.show_on_checkout = 1 " +
            "AND (c.starts_at IS NULL OR c.starts_at <= UTC_TIMESTAMP(6)) AND (c.ends_at IS NULL OR c.ends_at >= UTC_TIMESTAMP(6)) " +
            "AND (c.usage_limit IS NULL OR c.used_count < c.usage_limit) " +
            "ORDER BY c.seller_id IS NOT NULL, c.ends_at IS NULL, c.ends_at, c.created_at DESC LIMIT 200");

    /// <summary>Categories of the given products (reference: related_products).</summary>
    public async Task<List<Guid>> CategoriesOfAsync(IReadOnlyList<Guid> ids) =>
        (await db.QueryAsync<Guid>("SELECT DISTINCT category_id FROM products WHERE id IN @ids", new { ids })).ToList();

    /// <summary>Popular in-stock products in these categories, excluding the seen ones (reference: related_products).</summary>
    public Task<IEnumerable<ProductModel>> RelatedAsync(IReadOnlyList<Guid> categoryIds, IReadOnlyList<Guid> excludeIds, int limit) =>
        db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p WHERE {PublicProduct} AND p.in_stock = 1 AND p.category_id IN @categoryIds AND p.id NOT IN @excludeIds " +
            "ORDER BY p.sold_count DESC, p.rating_avg DESC LIMIT @limit", new { categoryIds, excludeIds, limit });

    /// <summary>Products from the shopper's delivered orders, most recent first (reference: buy_again).</summary>
    public Task<IEnumerable<ProductModel>> BuyAgainAsync(Guid userId, int limit) =>
        db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p JOIN (" +
            "SELECT oi.product_id, MAX(o.created_at) AS at FROM order_items oi " +
            "JOIN sub_orders so ON so.id = oi.sub_order_id JOIN orders o ON o.id = so.order_id " +
            "WHERE o.user_id = @userId AND so.status = 'delivered' GROUP BY oi.product_id) last ON last.product_id = p.id " +
            $"WHERE {PublicProduct} ORDER BY last.at DESC LIMIT @limit", new { userId, limit });
}
