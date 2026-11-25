using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>What staff see about a customer (Admin → Customers → detail) and what a customer exports about themselves.</summary>
public class CustomerAccountDAL(IMySqlDapperHelper db)
{
    public async Task<long> PlacedOrdersAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM orders WHERE user_id = @userId AND status = 'placed'", new { userId });

    public async Task<long> SpentAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT CAST(COALESCE(SUM(grand_total - refunded_total), 0) AS SIGNED) FROM orders WHERE user_id = @userId AND status = 'placed'", new { userId });

    public async Task<long> ReturnsAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM return_requests WHERE user_id = @userId", new { userId });

    public async Task<long> TicketsAsync(Guid userId, bool openOnly = false) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM support_tickets WHERE user_id = @userId" + (openOnly ? " AND status IN ('open', 'awaiting_customer')" : ""), new { userId });

    public async Task<long> WishlistAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM wishlist_items WHERE user_id = @userId", new { userId });

    public async Task<long> ReviewsAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM reviews WHERE user_id = @userId", new { userId });

    public Task<IEnumerable<OrderModel>> RecentOrdersAsync(Guid userId, int limit) =>
        db.QueryAsync<OrderModel>("SELECT * FROM orders WHERE user_id = @userId ORDER BY created_at DESC LIMIT @limit", new { userId, limit });

    public Task<IEnumerable<SubOrderModel>> SubOrdersAsync(IEnumerable<Guid> orderIds) =>
        db.QueryAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE order_id IN @orderIds ORDER BY number", new { orderIds });

    public Task<IEnumerable<OrderItemModel>> ItemsAsync(IEnumerable<Guid> subOrderIds) =>
        db.QueryAsync<OrderItemModel>("SELECT * FROM order_items WHERE sub_order_id IN @subOrderIds ORDER BY seq", new { subOrderIds });

    public Task<IEnumerable<ReturnRequestModel>> RecentReturnsAsync(Guid userId, int limit) =>
        db.QueryAsync<ReturnRequestModel>("SELECT * FROM return_requests WHERE user_id = @userId ORDER BY created_at DESC LIMIT @limit", new { userId, limit });

    public Task<IEnumerable<SupportTicketModel>> RecentTicketsAsync(Guid userId, int limit) =>
        db.QueryAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE user_id = @userId ORDER BY updated_at DESC LIMIT @limit", new { userId, limit });

    public Task<IEnumerable<ReturnItemModel>> ReturnItemsAsync(Guid returnId) =>
        db.QueryAsync<ReturnItemModel>("SELECT ri.* FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = @returnId", new { returnId });

    public Task<IEnumerable<OrderItemModel>> OrderItemsByIdAsync(IEnumerable<Guid> ids) =>
        db.QueryAsync<OrderItemModel>("SELECT * FROM order_items WHERE id IN @ids ORDER BY seq", new { ids });

    public Task<SubOrderModel?> SubOrderAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE id = @id", new { id });

    public Task<DeliveryAssignmentModel?> LatestReturnAssignmentAsync(Guid returnId) =>
        db.QueryFirstOrDefaultAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE return_id = @returnId ORDER BY created_at DESC LIMIT 1", new { returnId });

    public Task<DeliveryBoyModel?> DeliveryBoyAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<DeliveryBoyModel>("SELECT * FROM delivery_boys WHERE id = @id", new { id });

    public async Task<Dictionary<Guid, string>> UserNamesAsync(IEnumerable<Guid> ids) =>
        (await db.QueryAsync<UserModel>("SELECT * FROM users WHERE id IN @ids", new { ids })).ToDictionary(r => r.Id, r => r.Name);

    /// <summary>All of a customer's orders, newest first (data export).</summary>
    public Task<IEnumerable<OrderModel>> AllOrdersAsync(Guid userId) =>
        db.QueryAsync<OrderModel>("SELECT * FROM orders WHERE user_id = @userId ORDER BY created_at DESC", new { userId });

    /// <summary>The customer's saved (not deleted) addresses, in stored order (data export).</summary>
    public Task<IEnumerable<AddressModel>> AddressesAsync(Guid userId) =>
        db.QueryAsync<AddressModel>("SELECT * FROM addresses WHERE user_id = @userId AND is_deleted = 0", new { userId });

    /// <summary>Packages of the customer still on their way (account deletion waits for them).</summary>
    public async Task<long> OpenPackagesAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE o.user_id = @userId " +
            "AND s.status IN ('pending_payment', 'placed', 'confirmed', 'packed', 'shipped')", new { userId });
}
