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

    // ------------------------------------------------------------------ seller / admin surfaces

    /// <summary>Reference: seller_deals — the seller's deals with counts and the feature rules.</summary>
    Task<System.Text.Json.Nodes.JsonObject> SellerListAsync(SellerModel seller, string? status);

    /// <summary>Reference: seller_deal_options — the seller's live products and versions for the new-deal form.</summary>
    Task<System.Text.Json.Nodes.JsonObject> SellerOptionsAsync(SellerModel seller, string q);

    /// <summary>Reference: deals.create — validates and inserts a deal; returns its id.</summary>
    Task<Guid> CreateAsync(SellerModel seller, UserModel user, Guid variantId, string kind, long dealPrice,
        DateTime startsAt, DateTime endsAt, int? qtyLimit);

    /// <summary>Reference: seller_cancel_deal.</summary>
    Task SellerCancelAsync(SellerModel seller, UserModel user, Guid dealId);

    /// <summary>Reference: admin_deals.</summary>
    Task<System.Text.Json.Nodes.JsonObject> AdminListAsync(UserModel admin, string? status, string q, int page);

    /// <summary>Reference: admin_deal_action — approve, reject or cancel a deal.</summary>
    Task<System.Text.Json.Nodes.JsonObject> AdminActionAsync(UserModel admin, Guid dealId, string action, string reason);
}
