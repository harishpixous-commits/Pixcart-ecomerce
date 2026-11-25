using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>
/// Return requests and their items (reference: services/returns.py queries). Values the reference ORM fills by
/// default are named explicitly in the INSERT, per the local DDL's NOT NULL columns.
/// </summary>
public class ReturnsDAL(IMySqlDapperHelper db)
{
    public Task<ReturnRequestModel?> ReturnAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ReturnRequestModel>("SELECT * FROM return_requests WHERE id = @id", new { id });

    public Task<ReturnRequestModel?> ReturnForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<ReturnRequestModel>("SELECT * FROM return_requests WHERE id = @id FOR UPDATE", new { id });

    /// <summary>All returns of an order, newest first (reference: the /returnable lookup).</summary>
    public async Task<IReadOnlyList<ReturnRequestModel>> ReturnsForOrderAsync(Guid orderId, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<ReturnRequestModel>(
            "SELECT r.* FROM return_requests r JOIN sub_orders s ON s.id = r.sub_order_id WHERE s.order_id = @orderId ORDER BY r.created_at DESC",
            new { orderId });
        return rows.ToList();
    }

    /// <summary>Quantities already on their way back per order item (reference: the pending lookup; a received
    /// return is already counted in order_items.returned_qty).</summary>
    public async Task<Dictionary<Guid, long>> PendingQtyByItemAsync(Guid subOrderId, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<(Guid OrderItemId, long Qty)>(
            """
            SELECT ri.order_item_id AS OrderItemId, COALESCE(SUM(ri.qty), 0) AS Qty
            FROM return_items ri JOIN return_requests r ON r.id = ri.return_id
            WHERE r.sub_order_id = @subOrderId AND r.status IN ('requested','approved','picked_up')
            GROUP BY ri.order_item_id
            """, new { subOrderId });
        return rows.ToDictionary(r => r.OrderItemId, r => r.Qty);
    }

    /// <summary>A seller's returns, newest first, 20 per page (reference: seller_extras.seller_returns).</summary>
    public async Task<IReadOnlyList<ReturnRequestModel>> SellerReturnsAsync(Guid sellerId, string? status, int offset, IUnitOfWork uow)
    {
        var sql = "SELECT * FROM return_requests WHERE seller_id = @sellerId"
                  + (status is not null ? " AND status = @status" : "")
                  + " ORDER BY created_at DESC LIMIT 20 OFFSET @offset";
        var rows = await uow.QueryAsync<ReturnRequestModel>(sql, new { sellerId, status, offset });
        return rows.ToList();
    }

    /// <summary>Status counts, for one seller or the whole marketplace (reference: the status_counts lookups).</summary>
    public async Task<Dictionary<string, long>> StatusCountsAsync(Guid? sellerId, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<(string Status, long N)>(
            "SELECT status AS Status, COUNT(*) AS N FROM return_requests"
            + (sellerId is not null ? " WHERE seller_id = @sellerId" : "")
            + " GROUP BY status", new { sellerId });
        return rows.ToDictionary(r => r.Status, r => r.N);
    }

    private const string AdminWhere = @"
        FROM return_requests r
        WHERE (@status IS NULL OR r.status = @status)
          AND (@sellerId IS NULL OR r.seller_id = @sellerId)
          AND (@like = '' OR r.number LIKE @like
               OR r.sub_order_id IN (SELECT id FROM sub_orders WHERE number LIKE @like)
               OR r.user_id IN (SELECT id FROM users WHERE phone LIKE @like OR name LIKE @like))";

    /// <summary>Staff returns search (reference: admin_extras.admin_returns).</summary>
    public async Task<IReadOnlyList<ReturnRequestModel>> AdminReturnsAsync(string? status, string like, Guid? sellerId, int offset, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<ReturnRequestModel>(
            "SELECT r.* " + AdminWhere + " ORDER BY r.created_at DESC LIMIT 30 OFFSET @offset",
            new { status, like, sellerId, offset });
        return rows.ToList();
    }

    public Task<long> AdminCountAsync(string? status, string like, Guid? sellerId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<long>("SELECT COUNT(*) " + AdminWhere, new { status, like, sellerId })!;

    /// <summary>Approved returns our partners should collect that have no live request or trip
    /// (reference: delivery_admin._pickups_waiting).</summary>
    public async Task<IReadOnlyList<ReturnRequestModel>> PickupsWaitingAsync(IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<ReturnRequestModel>(
            @"SELECT * FROM return_requests
            WHERE status = 'approved' AND fleet_requested_at IS NOT NULL
              AND id NOT IN (SELECT return_id FROM delivery_assignments
                             WHERE return_id IS NOT NULL
                               AND status IN ('offered','accepted','at_store','picked','on_the_way','reached'))
            ORDER BY fleet_requested_at");
        return rows.ToList();
    }

    /// <summary>"title x qty" parts of a return's lines (reference: _pickup_item return_items).</summary>
    public async Task<IReadOnlyList<(string Title, int Qty)>> ItemTitlesAsync(Guid returnId, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<(string Title, int Qty)>(
            "SELECT oi.title AS Title, ri.qty AS Qty FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = @returnId",
            new { returnId });
        return rows.ToList();
    }

    /// <summary>The order a package belongs to (reference: the admin_open_return order lookup).</summary>
    /// <summary>Return requests on any of the given packages, oldest first (shop assistant order view).</summary>
    public async Task<IReadOnlyList<ReturnRequestModel>> ReturnsForSubsAsync(IReadOnlyList<Guid> subOrderIds)
    {
        if (subOrderIds.Count == 0) return [];
        var rows = await db.QueryAsync<ReturnRequestModel>(
            "SELECT * FROM return_requests WHERE sub_order_id IN @subOrderIds ORDER BY created_at", new { subOrderIds });
        return rows.ToList();
    }

    /// <summary>The customer's return requests with their package number and order id, newest first (return list).</summary>
    public async Task<IReadOnlyList<(ReturnRequestModel Ret, string SubNumber, Guid OrderId)>> ReturnsForUserAsync(Guid userId, int limit)
    {
        var rows = await db.QueryAsync<ReturnWithSub>(
            "SELECT r.*, s.number AS SubNumber, s.order_id AS OrderId FROM return_requests r " +
            "JOIN sub_orders s ON s.id = r.sub_order_id WHERE r.user_id = @userId ORDER BY r.created_at DESC LIMIT @limit",
            new { userId, limit });
        return rows.Select(r => ((ReturnRequestModel)r, r.SubNumber, r.OrderId)).ToList();
    }

    private sealed class ReturnWithSub : ReturnRequestModel
    {
        public string SubNumber { get; set; } = "";
        public Guid OrderId { get; set; }
    }

        public Task<OrderModel?> OrderForSubAsync(Guid subOrderId) =>
        db.QueryFirstOrDefaultAsync<OrderModel>(
            "SELECT o.* FROM orders o JOIN sub_orders s ON s.order_id = o.id WHERE s.id = @subOrderId", new { subOrderId });

    public Task<int> InsertReturnAsync(ReturnRequestModel r, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO return_requests
                (id, number, sub_order_id, seller_id, user_id, status, reason, comment, refund_amount, refund_upi,
                 seller_note, pickup_courier, pickup_tracking, credit_note_number, fleet_requested_at,
                 fleet_alerted_at, pickup_otp, approved_at, received_at, refunded_at, created_at, updated_at)
            VALUES
                (@Id, @Number, @SubOrderId, @SellerId, @UserId, @Status, @Reason, @Comment, @RefundAmount, @RefundUpi,
                 @SellerNote, @PickupCourier, @PickupTracking, @CreditNoteNumber, @FleetRequestedAt,
                 @FleetAlertedAt, @PickupOtp, @ApprovedAt, @ReceivedAt, @RefundedAt, @CreatedAt, @UpdatedAt)
            """, r);

    /// <summary>Every mutable field; status moves and receipt bookkeeping write their own columns.</summary>
    public Task<int> UpdateReturnAsync(ReturnRequestModel r, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE return_requests SET status = @Status, seller_note = @SellerNote, pickup_courier = @PickupCourier,
                pickup_tracking = @PickupTracking, credit_note_number = @CreditNoteNumber,
                fleet_requested_at = @FleetRequestedAt, fleet_alerted_at = @FleetAlertedAt, pickup_otp = @PickupOtp,
                approved_at = @ApprovedAt, received_at = @ReceivedAt, refunded_at = @RefundedAt,
                refund_amount = @RefundAmount, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @Id
            """, r);

    public Task<int> InsertReturnItemAsync(ReturnItemModel i, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO return_items (id, return_id, order_item_id, qty, amount, `condition`)
            VALUES (@Id, @ReturnId, @OrderItemId, @Qty, @Amount, @Condition)
            """, i);

    public async Task<IReadOnlyList<ReturnItemModel>> ItemsForReturnAsync(Guid returnId, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<ReturnItemModel>(
            "SELECT * FROM return_items WHERE return_id = @returnId", new { returnId });
        return rows.ToList();
    }

    public async Task<IReadOnlyList<OrderItemModel>> OrderItemsByIdsAsync(IReadOnlyCollection<Guid> ids, IUnitOfWork uow)
    {
        if (ids.Count == 0) return [];
        var rows = await uow.QueryAsync<OrderItemModel>(
            "SELECT * FROM order_items WHERE id IN @ids ORDER BY seq", new { ids });
        return rows.ToList();
    }

    public Task<int> SetReturnItemConditionAsync(Guid id, string condition, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE return_items SET `condition` = @condition WHERE id = @id", new { id, condition });

    public Task<int> BumpItemReturnedQtyAsync(Guid orderItemId, int qty, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE order_items SET returned_qty = returned_qty + @qty WHERE id = @orderItemId",
            new { orderItemId, qty });

    public Task<int> BumpSubReturnedTotalAsync(Guid subOrderId, long amount, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE sub_orders SET returned_total = returned_total + @amount, updated_at = UTC_TIMESTAMP(6) WHERE id = @subOrderId",
            new { subOrderId, amount });

    /// <summary>The order's refund running total and payment_status after a refund (reference: _receive).</summary>
    public Task<int> BumpOrderRefundedAsync(Guid orderId, long amount, string paymentStatus, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE orders SET refunded_total = refunded_total + @amount, payment_status = @paymentStatus, updated_at = UTC_TIMESTAMP(6) WHERE id = @orderId",
            new { orderId, amount, paymentStatus });

    /// <summary>One return by its customer-facing number (reference: assistant/actions.py return_decision).</summary>
    public Task<ReturnRequestModel?> ReturnByNumberAsync(string number) =>
        db.QueryFirstOrDefaultAsync<ReturnRequestModel>("SELECT * FROM return_requests WHERE UPPER(number) = @number", new { number });

}
