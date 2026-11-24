using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>The wishlist and what its product cards need (images, sellers, versions, running deals, units sold).</summary>
public class WishlistDAL(IMySqlDapperHelper db)
{
    public Task<ProductModel?> GetProductAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id });

    public Task<WishlistItemModel?> GetAsync(Guid userId, Guid productId) =>
        db.QueryFirstOrDefaultAsync<WishlistItemModel>(
            "SELECT * FROM wishlist_items WHERE user_id = @userId AND product_id = @productId", new { userId, productId });

    public async Task<long> CountAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM wishlist_items WHERE user_id = @userId", new { userId });

    public Task InsertAsync(WishlistItemModel w) =>
        db.ExecuteAsync(
            "INSERT INTO wishlist_items (user_id, product_id, created_at, price_at_add, alerted_price) VALUES (@UserId, @ProductId, @CreatedAt, @PriceAtAdd, @AlertedPrice)", w);

    public Task<int> DeleteAsync(Guid userId, Guid productId) =>
        db.ExecuteAsync("DELETE FROM wishlist_items WHERE user_id = @userId AND product_id = @productId", new { userId, productId });

    /// <summary>The saved products, most recently saved first.</summary>
    public Task<IEnumerable<ProductModel>> ProductsAsync(Guid userId) =>
        db.QueryAsync<ProductModel>(
            "SELECT p.* FROM products p JOIN wishlist_items w ON w.product_id = p.id WHERE w.user_id = @userId ORDER BY w.created_at DESC", new { userId });

    // ---------------------------------------------------------------- product cards

    public Task<IEnumerable<ProductImageModel>> ImagesAsync(IEnumerable<Guid> productIds) =>
        db.QueryAsync<ProductImageModel>("SELECT * FROM product_images WHERE product_id IN @productIds ORDER BY position", new { productIds });

    public Task<IEnumerable<SellerModel>> SellersAsync(IEnumerable<Guid> ids) =>
        db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE id IN @ids", new { ids });

    /// <summary>Active versions, cheapest first.</summary>
    public Task<IEnumerable<VariantModel>> ActiveVariantsAsync(IEnumerable<Guid> productIds) =>
        db.QueryAsync<VariantModel>("SELECT * FROM variants WHERE product_id IN @productIds AND is_active = 1 ORDER BY price_paise", new { productIds });

    /// <summary>Running deals, lowest deal price first.</summary>
    public Task<IEnumerable<DealModel>> ActiveDealsAsync(IEnumerable<Guid> productIds) =>
        db.QueryAsync<DealModel>("SELECT * FROM deals WHERE product_id IN @productIds AND status = 'active' ORDER BY deal_price_paise", new { productIds });

    /// <summary>Units sold per product since the given time in live packages.</summary>
    public async Task<Dictionary<Guid, long>> UnitsSoldSinceAsync(IEnumerable<Guid> productIds, DateTime since)
    {
        var rows = await db.QueryAsync<(Guid ProductId, decimal Units)>(
            "SELECT oi.product_id, SUM(oi.qty) FROM order_items oi JOIN sub_orders s ON s.id = oi.sub_order_id " +
            "WHERE oi.product_id IN @productIds AND s.status IN ('placed', 'confirmed', 'packed', 'shipped', 'delivered') AND s.created_at >= @since " +
            "GROUP BY oi.product_id", new { productIds, since });
        return rows.ToDictionary(r => r.ProductId, r => (long)r.Units);
    }
}
