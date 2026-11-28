using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>The cart (<c>cart_items</c>) and "Saved for later" (<c>saved_items</c>). Port of the cart parts of the
/// reference services/orders.py and routers/cart.py.</summary>
public class CartDAL(IMySqlDapperHelper db)
{
    /// <summary>The cart lines with what they need (version, product, seller), in version order: the fixed order that
    /// prevents deadlocks between concurrent checkouts (the reference orders by variant id for the same reason).</summary>
    public async Task<IReadOnlyList<(CartItemModel Item, VariantModel Variant, ProductModel Product, SellerModel Seller)>> LoadAsync(
        Guid userId, IUnitOfWork? uow = null, bool forUpdate = false)
    {
        const string sql = """
            SELECT c.*, v.id AS v_id, v.*, p.id AS p_id, p.*, s.id AS s_id, s.*
            FROM cart_items c
            JOIN variants v ON v.id = c.variant_id
            JOIN products p ON p.id = v.product_id
            JOIN sellers s ON s.id = p.seller_id
            WHERE c.user_id = @userId
            ORDER BY v.id
            """;
        // Locking the shopper's cart rows and the versions while an order is placed keeps a concurrent cart edit or a sale
        // of the same stock from slipping through. Products and sellers are not locked: other shoppers buying from the
        // same seller must not wait for this checkout.
        var stmt = forUpdate ? sql + "\nFOR UPDATE OF c, v" : sql;
        var rows = uow is null
            ? await db.QueryAsync<CartItemModel, VariantModel, ProductModel, SellerModel, (CartItemModel, VariantModel, ProductModel, SellerModel)>(
                stmt, (c, v, p, s) => (c, v, p, s), new { userId }, splitOn: "v_id,p_id,s_id")
            : await Dapper.SqlMapper.QueryAsync<CartItemModel, VariantModel, ProductModel, SellerModel, (CartItemModel, VariantModel, ProductModel, SellerModel)>(
                uow.Connection, stmt, (c, v, p, s) => (c, v, p, s), new { userId }, transaction: uow.Transaction, splitOn: "v_id,p_id,s_id");
        return rows.ToList();
    }

    /// <summary>A version that can be bought: active, of an approved product, of an approved seller.</summary>
    public Task<VariantModel?> PurchasableAsync(Guid variantId) =>
        db.QueryFirstOrDefaultAsync<VariantModel>(
            """
            SELECT v.* FROM variants v
            JOIN products p ON p.id = v.product_id
            JOIN sellers s ON s.id = p.seller_id
            WHERE v.id = @variantId AND v.is_active = 1 AND p.status = 'approved' AND (p.publish_at IS NULL OR p.publish_at <= UTC_TIMESTAMP(6)) AND s.status = 'approved'
            """, new { variantId });

    public Task<CartItemModel?> GetItemAsync(Guid userId, Guid variantId) =>
        db.QueryFirstOrDefaultAsync<CartItemModel>(
            "SELECT * FROM cart_items WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    public async Task<long> CountItemsAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM cart_items WHERE user_id = @userId", new { userId });

    public Task InsertItemAsync(CartItemModel item) =>
        db.ExecuteAsync(
            "INSERT INTO cart_items (id, user_id, variant_id, qty, created_at, updated_at) VALUES (@Id, @UserId, @VariantId, @Qty, @CreatedAt, @UpdatedAt)", item);

    public Task UpdateQtyAsync(Guid userId, Guid variantId, int qty) =>
        db.ExecuteAsync(
            "UPDATE cart_items SET qty = @qty, updated_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND variant_id = @variantId",
            new { userId, variantId, qty });

    public Task DeleteItemAsync(Guid userId, Guid variantId) =>
        db.ExecuteAsync("DELETE FROM cart_items WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    // ---------------------------------------------------------------- saved for later

    /// <summary>The saved lines with their version and product, most recently saved first.</summary>
    public async Task<IReadOnlyList<(SavedItemModel Saved, VariantModel Variant, ProductModel Product)>> SavedAsync(Guid userId)
    {
        var rows = await db.QueryAsync<SavedItemModel, VariantModel, ProductModel, (SavedItemModel, VariantModel, ProductModel)>(
            """
            SELECT si.*, v.id AS v_id, v.*, p.id AS p_id, p.*
            FROM saved_items si
            JOIN variants v ON v.id = si.variant_id
            JOIN products p ON p.id = v.product_id
            WHERE si.user_id = @userId
            ORDER BY si.created_at DESC
            """,
            (si, v, p) => (si, v, p), new { userId }, splitOn: "v_id,p_id");
        return rows.ToList();
    }

    public Task<SavedItemModel?> GetSavedAsync(Guid userId, Guid variantId) =>
        db.QueryFirstOrDefaultAsync<SavedItemModel>(
            "SELECT * FROM saved_items WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    public async Task<long> CountSavedAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM saved_items WHERE user_id = @userId", new { userId });

    public Task InsertSavedAsync(SavedItemModel saved) =>
        db.ExecuteAsync("INSERT INTO saved_items (user_id, variant_id, created_at) VALUES (@UserId, @VariantId, @CreatedAt)", saved);

    public Task<int> DeleteSavedAsync(Guid userId, Guid variantId) =>
        db.ExecuteAsync("DELETE FROM saved_items WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });
}
