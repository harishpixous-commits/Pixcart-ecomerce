using Utils.Interface;

namespace DAL;

/// <summary>Daily product counters from the storefront beacon (views, add to cart).</summary>
public class ProductEventDAL(IMySqlDapperHelper db)
{
    /// <summary>True when customers may see and buy the product (approved, priced, from an approved seller not on holiday).</summary>
    public async Task<bool> IsPublicAsync(Guid productId) =>
        await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM products p WHERE p.id = @productId AND p.status = 'approved' AND p.price_from > 0 " +
            "AND p.seller_id IN (SELECT s.id FROM sellers s WHERE s.status = 'approved' AND s.holiday_mode = 0)", new { productId }) > 0;

    /// <summary>Adds to the product's counters for the day (one row per product and India calendar day).</summary>
    public Task BumpAsync(Guid productId, DateOnly day, int views = 0, int addToCart = 0, int orders = 0, int units = 0, long revenue = 0) =>
        db.ExecuteAsync(
            "INSERT INTO product_daily_stats (product_id, day, views, add_to_cart, orders, units, revenue) " +
            "VALUES (@productId, @day, @views, @addToCart, @orders, @units, @revenue) " +
            "ON DUPLICATE KEY UPDATE views = views + VALUES(views), add_to_cart = add_to_cart + VALUES(add_to_cart), orders = orders + VALUES(orders), " +
            "units = units + VALUES(units), revenue = revenue + VALUES(revenue)",
            new { productId, day, views, addToCart, orders, units, revenue });
}
