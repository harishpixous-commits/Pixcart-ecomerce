using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>Multi-warehouse stock. Port of the reference services/inventory.py, starting with what checkout needs.</summary>
public class InventoryBAL(InventoryDAL inventory, IMySqlDapperHelper db,
    Interface.IPlatformSettingsBAL platform, Interface.ICatalogNotifyBAL notify) : Interface.IInventoryBAL
{
    /// <summary>Fewer units are left in the seller's active warehouses than the line asks for (another buyer was
    /// quicker) (reference: InsufficientStock).</summary>
    public sealed class InsufficientStockException(Guid variantId, int available)
        : AppException("Not enough stock", "insufficient_stock")
    {
        public Guid VariantId { get; } = variantId;
        public int Available { get; } = available;
    }

    public async Task<WarehouseModel?> DefaultWarehouseAsync(SellerModel seller, bool create = true, IUnitOfWork? uow = null)
    {
        var wh = await inventory.DefaultWarehouseAsync(seller.Id, uow);
        if (wh is not null || !create || seller.PickupLine1.Length == 0) return wh;
        wh = new WarehouseModel
        {
            Id = Guid.NewGuid(),
            SellerId = seller.Id,
            Code = "MAIN",
            Name = "Main warehouse",
            Line1 = seller.PickupLine1,
            Line2 = seller.PickupLine2,
            City = seller.PickupCity,
            StateCode = seller.PickupStateCode,
            Pincode = seller.PickupPincode,
            ContactName = seller.DisplayName,
            ContactPhone = seller.ContactPhone,
            IsDefault = true,
            IsActive = true,
        };
        if (uow is not null)
        {
            await inventory.InsertWarehouseAsync(wh, uow);
        }
        else
        {
            await using var own = await db.BeginAsync();
            await inventory.InsertWarehouseAsync(wh, own);
            await own.CommitAsync();
        }
        return wh;
    }

    /// <summary>Prefers one warehouse that can ship everything (same state as the customer first, then the default);
    /// otherwise each line from the best warehouse that holds all of it; otherwise the line is split across
    /// warehouses, fullest first, so the fewest packages carry it. Any quantity the seller holds in total across
    /// active warehouses can be ordered (reference: allocate).</summary>
    public async Task<Dictionary<Guid, List<(WarehouseModel Warehouse, int Qty)>>> AllocateAsync(
        SellerModel seller, IReadOnlyList<(VariantModel Variant, int Qty)> lines, string shipState, IUnitOfWork uow)
    {
        var warehouses = (await inventory.ActiveWarehousesAsync(seller.Id, uow)).ToList();
        if (warehouses.Count == 0)
            throw new AppException($"{seller.DisplayName} has no active warehouse", "no_warehouse");
        var variantIds = lines.Select(l => l.Variant.Id).OrderBy(id => id).ToList();
        var levels = await inventory.LevelsForUpdateAsync(variantIds, warehouses.Select(w => w.Id).ToList(), uow);
        var qtyAt = levels.ToDictionary(l => (l.VariantId, l.WarehouseId), l => l.Quantity);

        static (bool, bool, string) Rank(WarehouseModel w, string shipState) =>
            (w.StateCode != shipState, !w.IsDefault, w.Code);

        var ranked = warehouses.OrderBy(w => Rank(w, shipState)).ToList();
        foreach (var w in ranked)
        {
            if (lines.All(l => qtyAt.GetValueOrDefault((l.Variant.Id, w.Id)) >= l.Qty))
                return lines.ToDictionary(l => l.Variant.Id, l => new List<(WarehouseModel, int)> { (w, l.Qty) });
        }
        var outp = new Dictionary<Guid, List<(WarehouseModel, int)>>();
        foreach (var (variant, qty) in lines)
        {
            var whole = ranked.FirstOrDefault(w => qtyAt.GetValueOrDefault((variant.Id, w.Id)) >= qty);
            if (whole is not null)
            {
                outp[variant.Id] = [(whole, qty)];
                continue;
            }
            var pieces = new List<(WarehouseModel, int)>();
            var left = qty;
            foreach (var w in ranked.OrderByDescending(w => qtyAt.GetValueOrDefault((variant.Id, w.Id))).ThenBy(w => Rank(w, shipState)))
            {
                var have = qtyAt.GetValueOrDefault((variant.Id, w.Id));
                if (have <= 0 || left == 0) break;
                var take = Math.Min(have, left);
                pieces.Add((w, take));
                left -= take;
            }
            if (left > 0) throw new InsufficientStockException(variant.Id, qty - left);
            outp[variant.Id] = pieces;
        }
        return outp;
    }

    /// <summary>Sets one warehouse's level with a recorded movement (reference: inventory.set_quantity).</summary>
    public async Task<int> SetQuantityAsync(VariantModel variant, Guid warehouseId, int qty, Guid? actorId, string note, IUnitOfWork uow)
    {
        var lvl = await inventory.LevelForUpdateAsync(variant.Id, warehouseId, uow);
        var delta = qty - lvl.Quantity;
        if (delta == 0) return qty;
        return await ChangeAsync(variant, warehouseId, delta, "set", "", note, actorId, uow);
    }

    public async Task<int> ChangeAsync(VariantModel variant, Guid warehouseId, int delta, string kind,
        string reference = "", string note = "", Guid? actorId = null, IUnitOfWork? uow = null)
    {
        if (uow is null)
        {
            await using var own = await db.BeginAsync();
            var result = await ChangeAsync(variant, warehouseId, delta, kind, reference, note, actorId, own);
            await own.CommitAsync();
            return result;
        }
        var lvl = await inventory.LevelForUpdateAsync(variant.Id, warehouseId, uow);
        var newQty = lvl.Quantity + delta;
        if (newQty < 0) throw new AppException("Not enough stock in this warehouse", "insufficient_stock");
        lvl.Quantity = newQty;
        lvl.UpdatedAt = DateTime.UtcNow;
        await inventory.UpdateLevelAsync(lvl, uow);
        await inventory.InsertMovementAsync(new StockMovementModel
        {
            Id = Guid.NewGuid(),
            VariantId = variant.Id,
            WarehouseId = warehouseId,
            Kind = kind,
            Delta = delta,
            BalanceAfter = newQty,
            Reference = reference.Length > 80 ? reference[..80] : reference,
            Note = note.Length > 300 ? note[..300] : note,
            ActorUserId = actorId,
            CreatedAt = DateTime.UtcNow,
        }, uow);
        var total = await inventory.VariantStockTotalAsync(variant.Id, uow);
        await inventory.SetVariantStockAsync(variant.Id, total, uow);
        variant.Stock = total;
        return newQty;
    }

    /// <summary>Direct variants.stock write for a package with no warehouse.</summary>
    public Task<int> SetVariantStockAsync(Guid variantId, int stock, IUnitOfWork uow) =>
        inventory.SetVariantStockAsync(variantId, stock, uow);

    /// <summary>Tells a seller once when an approved product with a go-live time has gone live.</summary>
    public async Task<int> ProductLiveNotifyAsync()
    {
        var n = 0;
        foreach (var p in (await inventory.ProductsGoneLiveAsync()).ToList())
        {
            if (await inventory.MarkProductLiveNotifiedAsync(p.Id) == 0) continue;
            await notify.NotifySellerAsync(p.SellerId, "product_live", new Dictionary<string, string> { ["item"] = p.Title }, $"/p/{p.Slug}");
            n++;
        }
        return n;
    }

    /// <summary>Reference: jobs.low_stock_scan — one in-app note per seller listing their at-or-below-threshold options.</summary>
    public async Task<int> LowStockNotifyAsync()
    {
        var threshold = (await platform.GetAsync()).Long("low_stock_threshold");
        var rows = (await inventory.LowStockCountsAsync(threshold)).ToList();
        foreach (var r in rows)
            await notify.NotifySellerAsync(r.SellerId, "low_stock", new Dictionary<string, string>
            {
                ["count"] = r.Count.ToString(),
                ["threshold"] = threshold.ToString(),
            }, "/seller/inventory?low_stock=1");
        return rows.Count;
    }
}
