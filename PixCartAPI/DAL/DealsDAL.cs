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

    public Task<int> SetVariantPriceAsync(Guid variantId, long pricePaise, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE variants SET price_paise = @pricePaise, updated_at = UTC_TIMESTAMP() WHERE id = @variantId",
            new { variantId, pricePaise });
}
