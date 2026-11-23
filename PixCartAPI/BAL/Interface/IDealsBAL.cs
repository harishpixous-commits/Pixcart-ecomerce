using Model.DomainModel;
using Utils.Interface;

namespace BAL.Interface;

/// <summary>Running deals; port of the reference services/deals.py, growing as modules need more of it.</summary>
public interface IDealsBAL : IDealSync
{
    /// <summary>Units still offered at the deal price, for versions with a running lightning deal (one with a quantity).</summary>
    Task<Dictionary<Guid, int>> UnitsLeftAsync(IEnumerable<Guid> variantIds);

    /// <summary>Counts units sold at the deal price while an order is placed, ending a lightning deal whose quantity
    /// is gone (reference: record_sale). Runs in the order's unit of work.</summary>
    Task RecordSaleAsync(Guid variantId, int qty, IUnitOfWork uow);

    /// <summary>Cancelled units go back on offer at the deal price (reference: release_sale). Runs in the order's
    /// unit of work.</summary>
    Task ReleaseSaleAsync(Guid variantId, int qty, long unitPrice, IUnitOfWork uow);

    /// <summary>A version row locked inside the order's transaction (reference: the variant FOR UPDATE in
    /// _release_stock).</summary>
    Task<VariantModel?> VariantForUpdateAsync(Guid variantId, IUnitOfWork uow);
}
