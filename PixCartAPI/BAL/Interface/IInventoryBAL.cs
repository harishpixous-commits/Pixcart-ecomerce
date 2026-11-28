using Model.DomainModel;
using Utils.Interface;

namespace BAL.Interface;

/// <summary>Multi-warehouse stock (reference: services/inventory.py).</summary>
public interface IInventoryBAL
{
    /// <summary>The seller's default warehouse, creating the "MAIN" one from the KYC pickup address when it does
    /// not exist yet and the seller has one (reference: default_warehouse).</summary>
    Task<WarehouseModel?> DefaultWarehouseAsync(SellerModel seller, bool create = true, IUnitOfWork? uow = null);

    /// <summary>Where each line ships from, as (warehouse, quantity) pieces (reference: allocate). Rows are locked;
    /// call inside the order's unit of work.</summary>
    Task<Dictionary<Guid, List<(WarehouseModel Warehouse, int Qty)>>> AllocateAsync(
        SellerModel seller, IReadOnlyList<(VariantModel Variant, int Qty)> lines, string shipState, IUnitOfWork uow);

    /// <summary>One stock change with its movement record; refreshes variants.stock (reference: change).</summary>
    /// <summary>Reference: inventory.set_quantity.</summary>
    Task<int> SetQuantityAsync(VariantModel variant, Guid warehouseId, int qty, Guid? actorId, string note, IUnitOfWork uow);

    Task<int> ChangeAsync(VariantModel variant, Guid warehouseId, int delta, string kind,
        string reference = "", string note = "", Guid? actorId = null, IUnitOfWork? uow = null);

    /// <summary>Direct variants.stock write for a package with no warehouse (reference: the variant.stock += qty in
    /// _release_stock).</summary>
    Task<int> SetVariantStockAsync(Guid variantId, int stock, IUnitOfWork uow);
    Task<int> LowStockNotifyAsync();
    Task<int> ProductLiveNotifyAsync();
}
