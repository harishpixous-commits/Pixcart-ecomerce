using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Deals: a lower price on one product version for a limited time (reference: services/deals.py).</summary>
public class DealsDAL(IMySqlDapperHelper db)
{
    /// <summary>The deal running on a version, locked (reference: record_sale/release_sale lookups).</summary>
    public Task<DealModel?> ActiveDealForUpdateAsync(Guid variantId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<DealModel>(
            "SELECT * FROM deals WHERE variant_id = @variantId AND status = 'active' FOR UPDATE", new { variantId });

    /// <summary>Active deals whose time is over (reference: sync). SKIP LOCKED so concurrent syncs do not pile up.</summary>
    public async Task<IReadOnlyList<DealModel>> ActiveEndedAsync(DateTime now, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<DealModel>(
            "SELECT * FROM deals WHERE status = 'active' AND ends_at <= @now FOR UPDATE SKIP LOCKED", new { now });
        return rows.ToList();
    }

    /// <summary>Approved deals whose window never started (reference: the bulk end in sync).</summary>
    public Task<int> EndMissedApprovedAsync(DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE deals SET status = 'ended', note = 'The deal time passed', updated_at = UTC_TIMESTAMP() WHERE status = 'approved' AND ends_at <= @now",
            new { now });

    /// <summary>Approved deals due to start (reference: sync).</summary>
    public async Task<IReadOnlyList<DealModel>> DueToStartAsync(DateTime now, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<DealModel>(
            """
            SELECT * FROM deals WHERE status = 'approved' AND starts_at <= @now AND ends_at > @now
            ORDER BY starts_at FOR UPDATE SKIP LOCKED
            """, new { now });
        return rows.ToList();
    }

    public Task<int> UpdateDealAsync(DealModel d, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE deals SET status = @Status, note = @Note, regular_price_paise = @RegularPricePaise,
                sold_qty = @SoldQty, deal_price_paise = @DealPricePaise, updated_at = UTC_TIMESTAMP()
            WHERE id = @Id
            """, d);

    public Task<VariantModel?> VariantForUpdateAsync(Guid variantId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id = @variantId FOR UPDATE", new { variantId });

    public Task<ProductModel?> GetProductAsync(Guid productId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @productId", new { productId });

    public Task<VariantModel?> VariantAsync(Guid variantId) =>
        db.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id = @variantId", new { variantId });

    public Task<DealModel?> DealForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<DealModel>("SELECT * FROM deals WHERE id = @id FOR UPDATE", new { id });

    /// <summary>OPEN statuses from the reference: pending, approved, active (approved only while unexpired).</summary>
    public async Task<bool> OverlapExistsAsync(Guid variantId, DateTime startsAt, DateTime endsAt, DateTime now) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM deals WHERE variant_id = @variantId " +
            "AND (status IN ('pending','active') OR (status = 'approved' AND ends_at > @now)) " +
            "AND starts_at < @endsAt AND ends_at > @startsAt", new { variantId, startsAt, endsAt, now }) > 0;

    /// <summary>Versions with a running deal (reference: active_variant_ids).</summary>
    public async Task<HashSet<Guid>> ActiveVariantIdsAsync(IReadOnlyList<Guid> variantIds) =>
        variantIds.Count == 0
            ? []
            : (await db.QueryAsync<Guid>("SELECT variant_id FROM deals WHERE variant_id IN @variantIds AND status = 'active'",
                new { variantIds })).ToHashSet();

    public Task InsertDealAsync(DealModel d, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "INSERT INTO deals (id, seller_id, product_id, variant_id, kind, deal_price_paise, regular_price_paise, " +
            "starts_at, ends_at, qty_limit, sold_qty, status, note, created_at, updated_at) " +
            "VALUES (@Id, @SellerId, @ProductId, @VariantId, @Kind, @DealPricePaise, @RegularPricePaise, " +
            "@StartsAt, @EndsAt, @QtyLimit, @SoldQty, @Status, @Note, @CreatedAt, @UpdatedAt)", d);

    public class DealListRow : DealModel
    {
        public string ProductTitle { get; set; } = "";
        public string ProductSlug { get; set; } = "";
        public string? VariantOptions { get; set; }
        public long VariantPrice { get; set; }
        public long VariantMrp { get; set; }
        public int VariantStock { get; set; }
        public string SellerName { get; set; } = "";
    }

    private const string DealListCols =
        "d.*, p.title AS product_title, p.slug AS product_slug, CAST(v.options AS CHAR) AS variant_options, " +
        "v.price_paise AS variant_price, v.mrp_paise AS variant_mrp, v.stock AS variant_stock, s.display_name AS seller_name";

    private const string DealListJoin =
        "FROM deals d JOIN products p ON p.id = d.product_id JOIN variants v ON v.id = d.variant_id " +
        "JOIN sellers s ON s.id = d.seller_id";

    /// <summary>A seller's deals, newest first (reference: seller_deals + deal_rows).</summary>
    public Task<IEnumerable<DealListRow>> SellerDealsAsync(Guid sellerId, string? status) =>
        db.QueryAsync<DealListRow>(
            $"SELECT {DealListCols} {DealListJoin} WHERE d.seller_id = @sellerId{(status is null ? "" : " AND d.status = @status")} " +
            "ORDER BY d.created_at DESC LIMIT 200", new { sellerId, status });

    /// <summary>All deals for staff, soonest-starting first (reference: admin_deals).</summary>
    public async Task<(List<DealListRow> Items, long Total)> AdminDealsAsync(string? status, string q, int offset, int size)
    {
        var where = "1=1";
        if (status is not null && status != "all") where += " AND d.status = @status";
        if (q.Trim().Length > 0)
            where += " AND (d.product_id IN (SELECT id FROM products WHERE title LIKE @like) " +
                     "OR d.seller_id IN (SELECT id FROM sellers WHERE display_name LIKE @like))";
        var param = new { status, like = $"%{q.Trim()}%", offset, size };
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM deals d WHERE {where}", param);
        var rows = await db.QueryAsync<DealListRow>(
            $"SELECT {DealListCols} {DealListJoin} WHERE {where} ORDER BY d.starts_at DESC LIMIT @size OFFSET @offset", param);
        return (rows.ToList(), total);
    }

    /// <summary>One deal row by id (reference: deal_rows after create).</summary>
    public Task<DealListRow?> DealRowAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<DealListRow>($"SELECT {DealListCols} {DealListJoin} WHERE d.id = @id", new { id });

    public class DealCountRow
    {
        public string Status { get; set; } = "";
        public long N { get; set; }
    }

    public async Task<Dictionary<string, long>> DealStatusCountsAsync(Guid? sellerId) =>
        (await db.QueryAsync<DealCountRow>(
            $"SELECT status, COUNT(*) AS n FROM deals{(sellerId is null ? "" : " WHERE seller_id = @sellerId")} GROUP BY status",
            new { sellerId })).ToDictionary(r => r.Status, r => r.N);

    /// <summary>The seller's live products for the new-deal form (reference: seller_deal_options).</summary>
    public Task<IEnumerable<ProductModel>> SellerLiveProductsAsync(Guid sellerId, string q) =>
        db.QueryAsync<ProductModel>(
            "SELECT * FROM products WHERE seller_id = @sellerId AND status = 'approved' " +
            "AND (@q = '' OR title LIKE @like) ORDER BY title LIMIT 100",
            new { sellerId, q = q.Trim(), like = $"%{q.Trim()}%" });

    /// <summary>Active versions of the given products (reference: seller_deal_options variants).</summary>
    public Task<IEnumerable<VariantModel>> ActiveVariantsForAsync(IReadOnlyList<Guid> productIds) =>
        productIds.Count == 0
            ? Task.FromResult(Enumerable.Empty<VariantModel>())
            : db.QueryAsync<VariantModel>("SELECT * FROM variants WHERE product_id IN @productIds AND is_active = 1",
                new { productIds });

    public Task<int> SetVariantPriceAsync(Guid variantId, long pricePaise, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE variants SET price_paise = @pricePaise, updated_at = UTC_TIMESTAMP() WHERE id = @variantId",
            new { variantId, pricePaise });
}
