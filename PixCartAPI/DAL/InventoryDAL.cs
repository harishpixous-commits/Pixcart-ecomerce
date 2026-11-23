using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>
/// Multi-warehouse stock (reference: services/inventory.py). inventory_levels holds the truth per
/// (variant, warehouse); variants.stock is the sum over ACTIVE warehouses, kept in step here so listing and cart
/// queries stay cheap. Every change writes a stock movement.
/// </summary>
public class InventoryDAL(IMySqlDapperHelper db)
{
    public Task<IEnumerable<WarehouseModel>> ActiveWarehousesAsync(Guid sellerId, IUnitOfWork? uow = null) =>
        uow is null
            ? db.QueryAsync<WarehouseModel>(
                "SELECT * FROM warehouses WHERE seller_id = @sellerId AND is_active = 1", new { sellerId })
            : uow.QueryAsync<WarehouseModel>(
                "SELECT * FROM warehouses WHERE seller_id = @sellerId AND is_active = 1", new { sellerId });

    public Task<WarehouseModel?> DefaultWarehouseAsync(Guid sellerId, IUnitOfWork? uow = null) =>
        uow is null
            ? db.QueryFirstOrDefaultAsync<WarehouseModel>(
                "SELECT * FROM warehouses WHERE seller_id = @sellerId AND is_default = 1", new { sellerId })
            : uow.QueryFirstOrDefaultAsync<WarehouseModel>(
                "SELECT * FROM warehouses WHERE seller_id = @sellerId AND is_default = 1", new { sellerId });

    public Task<int> InsertWarehouseAsync(WarehouseModel w, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO warehouses (id, seller_id, code, name, line1, line2, city, state_code, pincode,
                contact_name, contact_phone, gstin, is_default, is_active)
            VALUES (@Id, @SellerId, @Code, @Name, @Line1, @Line2, @City, @StateCode, @Pincode,
                @ContactName, @ContactPhone, @Gstin, @IsDefault, @IsActive)
            """, w);

    /// <summary>The levels of the given versions in the given warehouses, locked in a fixed order so concurrent
    /// checkouts cannot deadlock (reference: allocate, which orders by variant id then warehouse id).</summary>
    public async Task<IReadOnlyList<InventoryLevelModel>> LevelsForUpdateAsync(
        IReadOnlyList<Guid> variantIds, IReadOnlyList<Guid> warehouseIds, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<InventoryLevelModel>(
            """
            SELECT * FROM inventory_levels
            WHERE variant_id IN @variantIds AND warehouse_id IN @warehouseIds
            ORDER BY variant_id, warehouse_id
            FOR UPDATE
            """, new { variantIds, warehouseIds });
        return rows.ToList();
    }

    /// <summary>One level row, locked; creates it at 0 when it does not exist yet (reference: _level).</summary>
    public async Task<InventoryLevelModel> LevelForUpdateAsync(Guid variantId, Guid warehouseId, IUnitOfWork uow)
    {
        var lvl = await uow.QueryFirstOrDefaultAsync<InventoryLevelModel>(
            "SELECT * FROM inventory_levels WHERE variant_id = @variantId AND warehouse_id = @warehouseId FOR UPDATE",
            new { variantId, warehouseId });
        if (lvl is not null) return lvl;
        lvl = new InventoryLevelModel { VariantId = variantId, WarehouseId = warehouseId, Quantity = 0, UpdatedAt = DateTime.UtcNow };
        await uow.ExecuteAsync(
            """
            INSERT INTO inventory_levels (variant_id, warehouse_id, quantity, updated_at)
            VALUES (@VariantId, @WarehouseId, @Quantity, @UpdatedAt)
            ON DUPLICATE KEY UPDATE quantity = quantity
            """, lvl);
        return lvl;
    }

    public Task<int> UpdateLevelAsync(InventoryLevelModel lvl, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE inventory_levels SET quantity = @Quantity, updated_at = @UpdatedAt WHERE variant_id = @VariantId AND warehouse_id = @WarehouseId",
            lvl);

    public Task<int> InsertMovementAsync(StockMovementModel m, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO stock_movements (id, variant_id, warehouse_id, kind, delta, balance_after, reference, note, actor_user_id, created_at)
            VALUES (@Id, @VariantId, @WarehouseId, @Kind, @Delta, @BalanceAfter, @Reference, @Note, @ActorUserId, @CreatedAt)
            """, m);

    /// <summary>The sellable total of a version: the stock in its seller's ACTIVE warehouses (reference:
    /// refresh_variant_total).</summary>
    public Task<int> VariantStockTotalAsync(Guid variantId, IUnitOfWork? uow = null)
    {
        const string sql = """
            SELECT COALESCE(SUM(il.quantity), 0) FROM inventory_levels il
            JOIN warehouses w ON w.id = il.warehouse_id
            WHERE il.variant_id = @variantId AND w.is_active = 1
            """;
        return uow is null
            ? db.ExecuteScalarAsync<int>(sql, new { variantId })
            : uow.ExecuteScalarAsync<int>(sql, new { variantId });
    }

    public Task<int> SetVariantStockAsync(Guid variantId, int stock, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE variants SET stock = @stock, updated_at = UTC_TIMESTAMP() WHERE id = @variantId",
            new { variantId, stock });

    public Task<WarehouseModel?> WarehouseByIdAsync(Guid id, IUnitOfWork? uow = null) =>
        uow is not null
            ? uow.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE id = @id", new { id })
            : db.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE id = @id", new { id });

    /// <summary>The fleet learns where a store is from the first partner who reaches it (reference: advance at_store).</summary>
    public Task<int> SetWarehouseLocationAsync(Guid id, decimal lat, decimal lng, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE warehouses SET lat = @lat, lng = @lng, updated_at = UTC_TIMESTAMP(6) WHERE id = @id AND lat IS NULL",
            new { id, lat, lng });
}
