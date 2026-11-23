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
            "SELECT * FROM order_items WHERE id IN @ids", new { ids });
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
}
