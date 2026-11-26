using System.Text.Json;
using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Orders and their packages, items, events, payments and redemptions (reference: the persistence parts of
/// services/orders.py).</summary>
public class OrdersDAL(IMySqlDapperHelper db)
{
    // ------------------------------------------------------------------ placement

    /// <summary>An order this shopper already placed with this idempotency key (reference: the place_order
    /// idempotency lookup).</summary>
    public Task<OrderModel?> FindByIdempotencyAsync(Guid userId, string key, IUnitOfWork? uow = null) =>
        uow is null
            ? db.QueryFirstOrDefaultAsync<OrderModel>(
                "SELECT * FROM orders WHERE user_id = @userId AND idempotency_key = @key", new { userId, key })
            : uow.QueryFirstOrDefaultAsync<OrderModel>(
                "SELECT * FROM orders WHERE user_id = @userId AND idempotency_key = @key", new { userId, key });

    public Task<OrderModel?> GetOrderAsync(Guid id, IUnitOfWork? uow = null) =>
        uow is null
            ? db.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id = @id", new { id })
            : uow.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id = @id", new { id });

    public Task<int> InsertOrderAsync(OrderModel o, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO orders (id, number, user_id, status, payment_method, payment_status, ship_to, items_total,
                shipping_total, cod_fee, discount_total, coupon_code, fees, fees_total, tip_paise, buyer_gstin,
                buyer_business, grand_total, currency, fx_rate, refunded_total, idempotency_key, payment_expires_at,
                placed_at, created_at, updated_at)
            VALUES (@Id, @Number, @UserId, @Status, @PaymentMethod, @PaymentStatus, @ShipTo, @ItemsTotal,
                @ShippingTotal, @CodFee, @DiscountTotal, @CouponCode, @Fees, @FeesTotal, @TipPaise, @BuyerGstin,
                @BuyerBusiness, @GrandTotal, @Currency, @FxRate, @RefundedTotal, @IdempotencyKey, @PaymentExpiresAt,
                @PlacedAt, @CreatedAt, @UpdatedAt)
            """, o);

    public Task<int> InsertSubOrderAsync(SubOrderModel s, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO sub_orders (id, order_id, seller_id, number, status, items_total, shipping_fee, cod_fee,
                seller_discount, platform_discount, total, taxable_total, shipping_gst_bps, is_interstate,
                commission_paise, commission_gst_paise, tcs_paise, tds_paise, seller_payout_paise, settlement_status,
                courier_name, tracking_number, tracking_url, cancelled_by, cancel_reason,
                warehouse_id, expected_delivery_at, created_at, updated_at)
            VALUES (@Id, @OrderId, @SellerId, @Number, @Status, @ItemsTotal, @ShippingFee, @CodFee,
                @SellerDiscount, @PlatformDiscount, @Total, @TaxableTotal, @ShippingGstBps, @IsInterstate,
                @CommissionPaise, @CommissionGstPaise, @TcsPaise, @TdsPaise, @SellerPayoutPaise, @SettlementStatus,
                @CourierName, @TrackingNumber, @TrackingUrl, @CancelledBy, @CancelReason,
                @WarehouseId, @ExpectedDeliveryAt, @CreatedAt, @UpdatedAt)
            """, s);

    public Task<int> InsertOrderItemAsync(OrderItemModel i, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO order_items (id, sub_order_id, product_id, variant_id, title, variant_label, image_url, sku,
                hsn_code, qty, unit_price, unit_mrp, line_total, gst_bps, taxable_value, cgst, sgst, igst,
                commission_bps, commission_paise, seller_discount, platform_discount, return_window_days)
            VALUES (@Id, @SubOrderId, @ProductId, @VariantId, @Title, @VariantLabel, @ImageUrl, @Sku,
                @HsnCode, @Qty, @UnitPrice, @UnitMrp, @LineTotal, @GstBps, @TaxableValue, @Cgst, @Sgst, @Igst,
                @CommissionBps, @CommissionPaise, @SellerDiscount, @PlatformDiscount, @ReturnWindowDays)
            """, i);

    public Task<int> InsertEventAsync(OrderEventModel e, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO order_events (id, order_id, sub_order_id, from_status, to_status, actor, note, created_at)
            VALUES (@Id, @OrderId, @SubOrderId, @FromStatus, @ToStatus, @Actor, @Note, @CreatedAt)
            """, e);

    public Task<int> ClearCartAsync(Guid userId, IUnitOfWork uow) =>
        uow.ExecuteAsync("DELETE FROM cart_items WHERE user_id = @userId", new { userId });

    /// <summary>The coupon row, locked, so its usage limit holds under concurrent checkouts (reference: the
    /// with_for_update in place_order).</summary>
    public Task<CouponModel?> CouponForUpdateAsync(Guid couponId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE id = @couponId FOR UPDATE", new { couponId });

    public Task<int> IncrementCouponUsageAsync(Guid couponId, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE coupons SET used_count = used_count + 1, updated_at = UTC_TIMESTAMP() WHERE id = @couponId",
            new { couponId });

    public Task<int> InsertRedemptionAsync(CouponRedemptionModel r, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, discount_paise, released, created_at)
            VALUES (@Id, @CouponId, @UserId, @OrderId, @DiscountPaise, @Released, @CreatedAt)
            """, r);

    /// <summary>Product stats for the day (reference: stats.bump).</summary>
    public Task<int> BumpDailyStatsAsync(Guid productId, DateTime day, int orders, int units, long revenue, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO product_daily_stats (product_id, day, views, add_to_cart, orders, units, revenue)
            VALUES (@productId, @day, 0, 0, @orders, @units, @revenue)
            ON DUPLICATE KEY UPDATE orders = orders + @orders, units = units + @units, revenue = revenue + @revenue
            """, new { productId, day, orders, units, revenue });

    public Task<int> AddSoldCountAsync(Guid productId, int qty, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE products SET sold_count = sold_count + @qty, updated_at = UTC_TIMESTAMP() WHERE id = @productId",
            new { productId, qty });

    public Task<int> InsertPaymentAsync(PaymentModel p, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO payments (id, order_id, provider, provider_order_id, amount_paise, currency, charge_amount,
                status, method, error, created_at, updated_at)
            VALUES (@Id, @OrderId, @Provider, @ProviderOrderId, @AmountPaise, @Currency, @ChargeAmount,
                @Status, @Method, @Error, @CreatedAt, @UpdatedAt)
            """, p);

    public Task<PaymentModel?> LatestPaymentAsync(Guid orderId, IUnitOfWork? uow = null) =>
        uow is null
            ? db.QueryFirstOrDefaultAsync<PaymentModel>(
                "SELECT * FROM payments WHERE order_id = @orderId ORDER BY created_at DESC LIMIT 1", new { orderId })
            : uow.QueryFirstOrDefaultAsync<PaymentModel>(
                "SELECT * FROM payments WHERE order_id = @orderId ORDER BY created_at DESC LIMIT 1", new { orderId });

    /// <summary>The captured online payment (Razorpay), shown as "Payment received" with its reference.</summary>
    public Task<PaymentModel?> CapturedPaymentAsync(Guid orderId) =>
        db.QueryFirstOrDefaultAsync<PaymentModel>(
            "SELECT * FROM payments WHERE order_id = @orderId AND status = 'captured' ORDER BY created_at DESC LIMIT 1",
            new { orderId });

    // ------------------------------------------------------------------ detail

    public async Task<IReadOnlyList<SubOrderModel>> SubOrdersAsync(Guid orderId)
    {
        var rows = await db.QueryAsync<SubOrderModel>(
            "SELECT * FROM sub_orders WHERE order_id = @orderId ORDER BY number", new { orderId });
        return rows.ToList();
    }

    /// <summary>The customer's orders that have at least one package in one of the given statuses, newest first.</summary>
    public async Task<IReadOnlyList<OrderModel>> OrdersWithSubStatusAsync(Guid userId, IReadOnlyList<string> statuses, int limit)
    {
        var rows = await db.QueryAsync<OrderModel>(
            "SELECT * FROM orders WHERE user_id = @userId AND EXISTS(SELECT 1 FROM sub_orders s WHERE s.order_id = orders.id AND s.status IN @statuses) " +
            "ORDER BY created_at DESC LIMIT @limit", new { userId, statuses, limit });
        return rows.ToList();
    }

    /// <summary>The customer's recent orders, newest first (shop assistant tools).</summary>
    public async Task<IReadOnlyList<OrderModel>> RecentForUserAsync(Guid userId, int limit)
    {
        var rows = await db.QueryAsync<OrderModel>(
            "SELECT * FROM orders WHERE user_id = @userId ORDER BY created_at DESC LIMIT @limit", new { userId, limit });
        return rows.ToList();
    }

    /// <summary>The customer's own order by order number (reference: _own_order; ownership in the query itself).</summary>
    public Task<OrderModel?> OwnByNumberAsync(Guid userId, string number) =>
        db.QueryFirstOrDefaultAsync<OrderModel>(
            "SELECT * FROM orders WHERE user_id = @userId AND number = @number LIMIT 1", new { userId, number });

    /// <summary>The customer's orders with any refunded money, newest first (refund status tool).</summary>
    public async Task<IReadOnlyList<OrderModel>> RefundedForUserAsync(Guid userId, int limit)
    {
        var rows = await db.QueryAsync<OrderModel>(
            "SELECT * FROM orders WHERE user_id = @userId AND refunded_total > 0 ORDER BY created_at DESC LIMIT @limit",
            new { userId, limit });
        return rows.ToList();
    }

        public async Task<IReadOnlyList<OrderItemModel>> ItemsAsync(IReadOnlyList<Guid> subOrderIds)
    {
        if (subOrderIds.Count == 0) return [];
        var rows = await db.QueryAsync<OrderItemModel>(
            "SELECT * FROM order_items WHERE sub_order_id IN @subOrderIds ORDER BY seq", new { subOrderIds });
        return rows.ToList();
    }

    public async Task<IReadOnlyList<OrderEventModel>> EventsAsync(Guid orderId)
    {
        var rows = await db.QueryAsync<OrderEventModel>(
            "SELECT * FROM order_events WHERE order_id = @orderId ORDER BY created_at", new { orderId });
        return rows.ToList();
    }

    public async Task<IReadOnlyList<RefundModel>> RefundsAsync(Guid orderId)
    {
        var rows = await db.QueryAsync<RefundModel>(
            "SELECT * FROM refunds WHERE order_id = @orderId ORDER BY created_at", new { orderId });
        return rows.ToList();
    }

    public async Task<IReadOnlyDictionary<Guid, string>> ProductSlugsAsync(IReadOnlyList<Guid> productIds)
    {
        if (productIds.Count == 0) return new Dictionary<Guid, string>();
        var rows = await db.QueryAsync<(Guid Id, string Slug)>(
            "SELECT id AS Id, slug AS Slug FROM products WHERE id IN @productIds", new { productIds });
        return rows.ToDictionary(r => r.Id, r => r.Slug);
    }

    public async Task<IReadOnlyList<SellerModel>> SellersAsync(IReadOnlyList<Guid> sellerIds)
    {
        if (sellerIds.Count == 0) return [];
        var rows = await db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE id IN @sellerIds", new { sellerIds });
        return rows.ToList();
    }

    /// <summary>The shopper's saved-cards reference on Razorpay (reference: the razorpay customer save in
    /// shopper_checkout).</summary>
    public Task<int> SetRazorpayCustomerAsync(Guid userId, string customerId, IUnitOfWork? uow = null) =>
        uow is null
            ? db.ExecuteAsync("UPDATE users SET razorpay_customer_id = @customerId, updated_at = UTC_TIMESTAMP() WHERE id = @userId",
                new { userId, customerId })
            : uow.ExecuteAsync("UPDATE users SET razorpay_customer_id = @customerId, updated_at = UTC_TIMESTAMP() WHERE id = @userId",
                new { userId, customerId });

    // ------------------------------------------------------------------ payments

    /// <summary>A payment row by its Razorpay order id, locked (reference: verify_payment).</summary>
    public Task<PaymentModel?> PaymentByProviderOrderForUpdateAsync(string providerOrderId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<PaymentModel>(
            "SELECT * FROM payments WHERE provider_order_id = @providerOrderId FOR UPDATE", new { providerOrderId });

    /// <summary>The order's latest payment, locked (reference: payment_status).</summary>
    public Task<PaymentModel?> LatestPaymentForUpdateAsync(Guid orderId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<PaymentModel>(
            "SELECT * FROM payments WHERE order_id = @orderId ORDER BY created_at DESC LIMIT 1 FOR UPDATE", new { orderId });

    /// <summary>The order row, locked (reference: mark_paid's order lock).</summary>
    public Task<OrderModel?> OrderForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id = @id FOR UPDATE", new { id });

    public Task<PaymentModel?> PaymentForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<PaymentModel>("SELECT * FROM payments WHERE id = @id FOR UPDATE", new { id });

    /// <summary>A refund already recorded for this gateway payment (reference: the duplicate check in mark_paid).</summary>
    public Task<bool> RefundExistsForProviderPaymentAsync(string providerPaymentId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<int>(
            "SELECT COUNT(1) FROM refunds WHERE provider_payment_id = @providerPaymentId", new { providerPaymentId })
        .ContinueWith(t => t.Result > 0);

    public Task<int> UpdatePaymentAsync(PaymentModel p, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE payments SET status = @Status, provider_payment_id = @ProviderPaymentId, method = @Method,
                error = @Error, updated_at = UTC_TIMESTAMP()
            WHERE id = @Id
            """, p);

    /// <summary>The payment-state fields of the order (reference: the order updates in mark_paid).</summary>
    public Task<int> UpdateOrderPaymentStateAsync(OrderModel o, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE orders SET status = @Status, payment_status = @PaymentStatus, placed_at = @PlacedAt,
                refunded_total = @RefundedTotal, updated_at = UTC_TIMESTAMP()
            WHERE id = @Id
            """, o);

    /// <summary>All packages of the order (reference: the sub-order update in mark_paid).</summary>
    public async Task<IReadOnlyList<SubOrderModel>> SubOrdersForUpdateAsync(Guid orderId, IUnitOfWork uow)
    {
        var rows = await uow.QueryAsync<SubOrderModel>(
            "SELECT * FROM sub_orders WHERE order_id = @orderId ORDER BY number FOR UPDATE", new { orderId });
        return rows.ToList();
    }

    public Task<int> SetSubStatusAsync(Guid subId, string status, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE sub_orders SET status = @status, updated_at = UTC_TIMESTAMP() WHERE id = @subId",
            new { subId, status });

    public Task<int> InsertRefundAsync(RefundModel r, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO refunds (id, order_id, payment_id, provider_payment_id, sub_order_id, amount_paise, status,
                reason, attempts, last_error, created_at, updated_at)
            VALUES (@Id, @OrderId, @PaymentId, @ProviderPaymentId, @SubOrderId, @AmountPaise, @Status,
                @Reason, @Attempts, @LastError, @CreatedAt, @UpdatedAt)
            """, r);

    /// <summary>Refunds waiting to go to the gateway (reference: the run_refunds lookup).</summary>
    public async Task<IReadOnlyList<Guid>> PendingRefundIdsAsync(Guid paymentId)
    {
        var rows = await db.QueryAsync<Guid>(
            "SELECT id FROM refunds WHERE payment_id = @paymentId AND status = 'pending'", new { paymentId });
        return rows.ToList();
    }

    /// <summary>The shopper's orders, newest first (reference: my_orders).</summary>
    public async Task<IReadOnlyList<OrderModel>> OrdersByUserAsync(Guid userId, int offset, int limit)
    {
        var rows = await db.QueryAsync<OrderModel>(
            "SELECT * FROM orders WHERE user_id = @userId ORDER BY created_at DESC LIMIT @limit OFFSET @offset",
            new { userId, offset, limit });
        return rows.ToList();
    }

    public Task<long> CountOrdersByUserAsync(Guid userId) =>
        db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM orders WHERE user_id = @userId", new { userId });

    /// <summary>One package, locked (reference: _own_sub FOR UPDATE).</summary>
    public Task<SubOrderModel?> SubForUpdateAsync(Guid subId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE id = @subId FOR UPDATE", new { subId });

    public Task<SubOrderModel?> GetSubAsync(Guid subId) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE id = @subId", new { subId });

    /// <summary>The status move with its timestamp (reference: the sub-order update in transition()).</summary>
    /// <summary>The seller's document counter row, locked (reference: invoices.next_number).</summary>
    public Task<int?> DocCounterForUpdateAsync(Guid sellerId, string docType, string fy, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<int?>(
            "SELECT last_number FROM document_counters WHERE seller_id = @sellerId AND doc_type = @docType AND fiscal_year = @fy FOR UPDATE",
            new { sellerId, docType, fy });

    public Task<int> InsertDocCounterAsync(Guid sellerId, string docType, string fy, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "INSERT INTO document_counters (seller_id, doc_type, fiscal_year, last_number) VALUES (@sellerId, @docType, @fy, 1)",
            new { sellerId, docType, fy });

    public Task<int> BumpDocCounterAsync(Guid sellerId, string docType, string fy, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE document_counters SET last_number = last_number + 1 WHERE seller_id = @sellerId AND doc_type = @docType AND fiscal_year = @fy",
            new { sellerId, docType, fy });

    public Task<int> SetSubInvoiceAsync(Guid subId, string number, DateTime at, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE sub_orders SET invoice_number = @number, invoice_date = @at WHERE id = @subId",
            new { subId, number, at });

    /// <summary>The order's first package still alive, by number (reference: collect_amount).</summary>
    public Task<Guid?> FirstLiveSubIdAsync(Guid orderId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<Guid?>(
            "SELECT id FROM sub_orders WHERE order_id = @orderId AND status <> 'cancelled' ORDER BY number LIMIT 1",
            new { orderId });

    public async Task<Guid?> FirstLiveSubIdAsync(Guid orderId)
    {
        var rows = await db.QueryAsync<Guid>(
            "SELECT id FROM sub_orders WHERE order_id = @orderId AND status <> 'cancelled' ORDER BY number LIMIT 1",
            new { orderId });
        return rows.Cast<Guid?>().FirstOrDefault();
    }

    /// <summary>The longest return window saved on the package's lines (reference: transition delivered).</summary>
    public Task<int> MaxReturnWindowAsync(Guid subId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<int>(
            "SELECT COALESCE(MAX(return_window_days), 0) FROM order_items WHERE sub_order_id = @subId", new { subId });

    public Task<bool> LedgerHasAsync(Guid subId, string kind, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<bool>(
            "SELECT EXISTS(SELECT 1 FROM seller_ledger WHERE sub_order_id = @subId AND kind = @kind)", new { subId, kind });

    /// <summary>One seller_ledger row (reference: ledger._entry).</summary>
    public Task<int> InsertLedgerAsync(Guid sellerId, Guid subId, string kind, long amount, string description, DateTime availableAt, IUnitOfWork uow, Guid? returnId = null) =>
        uow.ExecuteAsync(
            """
            INSERT INTO seller_ledger (id, seller_id, sub_order_id, return_id, kind, amount, description, available_at, payout_id, created_at)
            VALUES (@id, @sellerId, @subId, @returnId, @kind, @amount, @description, @availableAt, NULL, UTC_TIMESTAMP(6))
            """,
            new
            {
                id = Guid.NewGuid().ToString(), sellerId, subId, returnId = returnId?.ToString(), kind, amount,
                description = description.Length > 200 ? description[..200] : description, availableAt,
            });

    public async Task<IReadOnlyList<OrderEventModel>> EventsForSubAsync(Guid subId)
    {
        var rows = await db.QueryAsync<OrderEventModel>(
            "SELECT * FROM order_events WHERE sub_order_id = @subId ORDER BY created_at", new { subId });
        return rows.ToList();
    }

    public Task<int> UpdateSubTransitionAsync(SubOrderModel s, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE sub_orders SET status = @Status, confirmed_at = @ConfirmedAt, packed_at = @PackedAt,
                shipped_at = @ShippedAt, delivered_at = @DeliveredAt, settlement_status = @SettlementStatus,
                settlement_due_at = @SettlementDueAt, courier_name = @CourierName, tracking_number = @TrackingNumber,
                tracking_url = @TrackingUrl, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @Id
            """, s);

    /// <summary>The seller's work queues (reference: seller list_orders). Oldest first for open steps, newest first
    /// for history.</summary>
    public async Task<IReadOnlyList<SubOrderModel>> SellerSubsAsync(
        Guid sellerId, string? status, string q, int offset, int limit)
    {
        var where = "s.seller_id = @sellerId AND s.status != 'pending_payment'";
        if (status is { Length: > 0 }) where += " AND s.status = @status";
        if (q.Trim().Length > 0) where += " AND (s.number LIKE @like OR o.number LIKE @like)";
        var asc = status is "placed" or "confirmed" or "packed";
        var rows = await db.QueryAsync<SubOrderModel>(
            $"""
            SELECT s.* FROM sub_orders s JOIN orders o ON o.id = s.order_id
            WHERE {where} ORDER BY s.created_at {(asc ? "ASC" : "DESC")} LIMIT @limit OFFSET @offset
            """,
            new { sellerId, status, like = $"%{q.Trim()}%", offset, limit });
        return rows.ToList();
    }

    public async Task<IReadOnlyList<OrderModel>> OrdersByIdsAsync(IReadOnlyList<Guid> ids)
    {
        if (ids.Count == 0) return [];
        var rows = await db.QueryAsync<OrderModel>("SELECT * FROM orders WHERE id IN @ids", new { ids });
        return rows.ToList();
    }

    public Task<long> CountSellerSubsAsync(Guid sellerId, string? status, string q)
    {
        var where = "s.seller_id = @sellerId AND s.status != 'pending_payment'";
        if (status is { Length: > 0 }) where += " AND s.status = @status";
        if (q.Trim().Length > 0) where += " AND (s.number LIKE @like OR o.number LIKE @like)";
        return db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE {where}",
            new { sellerId, status, like = $"%{q.Trim()}%" });
    }

    /// <summary>Packages per step, for the queue tabs (reference: the status_counts group-by).</summary>
    public async Task<IReadOnlyDictionary<string, long>> SellerStatusCountsAsync(Guid sellerId)
    {
        var rows = await db.QueryAsync<(string Status, long N)>(
            "SELECT status AS Status, COUNT(*) AS N FROM sub_orders WHERE seller_id = @sellerId AND status != 'pending_payment' GROUP BY status",
            new { sellerId });
        return rows.ToDictionary(r => r.Status, r => r.N);
    }

    /// <summary>Last-30-days sales rollup (reference: dashboard sales query; pending/unpaid and cancelled excluded).</summary>
    public async Task<(long Amount, long Orders)> SalesSinceAsync(Guid sellerId, DateTime since)
    {
        var row = (await db.QueryAsync<(long Amount, long Orders)>(
            @"SELECT COALESCE(SUM(total), 0) AS Amount, COUNT(*) AS Orders FROM sub_orders
              WHERE seller_id = @sellerId AND created_at >= @since AND status NOT IN ('pending_payment', 'cancelled')",
            new { sellerId, since })).First();
        return row;
    }

    public async Task<IReadOnlyList<(string Date, long Amount, long Orders)>> DailySalesSinceAsync(Guid sellerId, DateTime since)
    {
        var rows = await db.QueryAsync<(DateTime Date, long Amount, long Orders)>(
            // days are Indian days (times are stored in UTC), like every other daily figure
            @"SELECT DATE(CONVERT_TZ(created_at, '+00:00', '+05:30')) AS Date, COALESCE(SUM(total), 0) AS Amount, COUNT(*) AS Orders
              FROM sub_orders
              WHERE seller_id = @sellerId AND created_at >= @since AND status NOT IN ('pending_payment', 'cancelled')
              GROUP BY Date ORDER BY Date",
            new { sellerId, since });
        return rows.Select(r => (r.Date.ToString("yyyy-MM-dd"), r.Amount, r.Orders)).ToList();
    }

    /// <summary>Available / in-return-window / paid-out from the ledger (reference: ledger.balances).</summary>
    public async Task<(long Available, long Upcoming, long PaidOut)> LedgerBalancesAsync(Guid sellerId)
    {
        var row = (await db.QueryAsync<(long Available, long Upcoming, long PaidOut)>(
            @"SELECT COALESCE(SUM(CASE WHEN payout_id IS NULL AND available_at <= UTC_TIMESTAMP(6) THEN amount ELSE 0 END), 0) AS Available,
                     COALESCE(SUM(CASE WHEN payout_id IS NULL AND available_at > UTC_TIMESTAMP(6) THEN amount ELSE 0 END), 0) AS Upcoming,
                     COALESCE(SUM(CASE WHEN payout_id IS NOT NULL THEN amount ELSE 0 END), 0) AS PaidOut
              FROM seller_ledger WHERE seller_id = @sellerId",
            new { sellerId })).First();
        return row;
    }

    public Task<long> CountDeliveredSubsAsync(Guid sellerId) =>
        db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND status = 'delivered'", new { sellerId });

    /// <summary>One earnings page (reference: earnings; newest deliveries first).</summary>
    public async Task<IReadOnlyList<SubOrderModel>> DeliveredSubsAsync(Guid sellerId, int offset, int limit)
    {
        var rows = await db.QueryAsync<SubOrderModel>(
            @"SELECT * FROM sub_orders WHERE seller_id = @sellerId AND status = 'delivered'
              ORDER BY delivered_at DESC LIMIT @limit OFFSET @offset",
            new { sellerId, offset, limit });
        return rows.ToList();
    }

    public async Task<(long Gross, long Commission, long CommissionGst, long Tcs, long Tds, long Payout)> DeliveredSumsAsync(Guid sellerId)
    {
        var row = (await db.QueryAsync<(long Gross, long Commission, long CommissionGst, long Tcs, long Tds, long Payout)>(
            @"SELECT COALESCE(SUM(total), 0) AS Gross, COALESCE(SUM(commission_paise), 0) AS Commission,
                     COALESCE(SUM(commission_gst_paise), 0) AS CommissionGst, COALESCE(SUM(tcs_paise), 0) AS Tcs,
                     COALESCE(SUM(tds_paise), 0) AS Tds, COALESCE(SUM(seller_payout_paise), 0) AS Payout
              FROM sub_orders WHERE seller_id = @sellerId AND status = 'delivered'",
            new { sellerId })).First();
        return row;
    }

    /// <summary>Packages of several orders at once (reference: the my_orders sub-order read).</summary>
    public async Task<IReadOnlyList<SubOrderModel>> SubOrdersForOrdersAsync(IReadOnlyList<Guid> orderIds)
    {
        if (orderIds.Count == 0) return [];
        var rows = await db.QueryAsync<SubOrderModel>(
            "SELECT * FROM sub_orders WHERE order_id IN @orderIds ORDER BY number", new { orderIds });
        return rows.ToList();
    }

    /// <summary>Items of the packages, inside the order's transaction (reference: the _release_stock read).</summary>
    public async Task<IReadOnlyList<OrderItemModel>> ItemsAsync(IReadOnlyList<Guid> subOrderIds, IUnitOfWork uow)
    {
        if (subOrderIds.Count == 0) return [];
        var rows = await uow.QueryAsync<OrderItemModel>(
            "SELECT * FROM order_items WHERE sub_order_id IN @subOrderIds ORDER BY seq", new { subOrderIds });
        return rows.ToList();
    }

    /// <summary>The cancel write on the package (reference: the cancel_sub_order sub-order update).</summary>
    public Task<int> UpdateSubCancelledAsync(SubOrderModel s, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE sub_orders SET status = 'cancelled', cancelled_at = @CancelledAt, cancelled_by = @CancelledBy,
                cancel_reason = @CancelReason, settlement_status = 'void', updated_at = UTC_TIMESTAMP(6)
            WHERE id = @Id
            """, s);

    /// <summary>Packages of the order still live, excluding one (reference: the others_live counts in cancel_sub_order).</summary>
    public Task<long> CountLiveOtherSubsAsync(Guid orderId, Guid excludeSubId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders WHERE order_id = @orderId AND status != 'cancelled' AND id != @excludeSubId",
            new { orderId, excludeSubId });

    /// <summary>The order is fully cancelled (reference: the order update in cancel_sub_order). An unpaid online
    /// order's payment becomes 'failed' with it.</summary>
    public Task<int> MarkOrderCancelledAsync(Guid orderId, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE orders SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(6),
                payment_status = IF(payment_method = 'online' AND payment_status = 'pending', 'failed', payment_status),
                updated_at = UTC_TIMESTAMP(6)
            WHERE id = @orderId
            """, new { orderId });

    /// <summary>The order's unreleased coupon redemption, locked (reference: the redemption release in cancel_sub_order).</summary>
    public Task<Guid?> UnreleasedRedemptionCouponAsync(Guid orderId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<Guid?>(
            "SELECT coupon_id FROM coupon_redemptions WHERE order_id = @orderId AND released = 0 LIMIT 1 FOR UPDATE",
            new { orderId });

    public Task<int> ReleaseRedemptionAsync(Guid orderId, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE coupon_redemptions SET released = 1 WHERE order_id = @orderId AND released = 0", new { orderId });

    /// <summary>used_count floor 0 (reference: the coupon update in cancel_sub_order).</summary>
    public Task<int> DecrementCouponUsageAsync(Guid couponId, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE coupons SET used_count = GREATEST(used_count - 1, 0), updated_at = UTC_TIMESTAMP(6) WHERE id = @couponId",
            new { couponId });

    /// <summary>sold_count floor 0 on release (reference: the product update in _release_stock).</summary>
    public Task<int> ReleaseSoldCountAsync(Guid productId, int qty, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE products SET sold_count = GREATEST(sold_count - @qty, 0), updated_at = UTC_TIMESTAMP(6) WHERE id = @productId",
            new { productId, qty });

    /// <summary>One refund, locked for the runner (reference: process_refund's select FOR UPDATE SKIP LOCKED; our
    /// runner is single-process so a plain row lock is the same guarantee).</summary>
    public Task<RefundModel?> RefundForUpdateAsync(Guid refundId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<RefundModel>("SELECT * FROM refunds WHERE id = @refundId FOR UPDATE", new { refundId });

    public Task<int> UpdateRefundAsync(RefundModel r, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE refunds SET status = @Status, provider_refund_id = @ProviderRefundId, attempts = @Attempts,
                last_error = @LastError, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @Id
            """, r);

    /// <summary>The marketplace fee invoice number on the order, once (reference: fee_invoices.issue).</summary>
    public Task<int> SetFeeInvoiceAsync(Guid orderId, string number, DateTime at, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE orders SET fee_invoice_number = @number, fee_invoice_date = @at, updated_at = UTC_TIMESTAMP(6) WHERE id = @orderId",
            new { orderId, number, at });

    /// <summary>Gap-free invoice counter under a row lock (reference: fee_invoices._next_number on the
    /// 'operator_documents' platform_settings row; a rollback gives the number back).</summary>
    public async Task<int> NextInvoiceNumberAsync(string fy, IUnitOfWork uow)
    {
        const string key = "operator_documents";
        var json = await uow.ExecuteScalarAsync<string>(
            "SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = @key FOR UPDATE", new { key });
        var doc = json is not null ? (JsonNode.Parse(json) as JsonObject ?? new JsonObject()) : new JsonObject();
        var counterKey = $"INV/{fy}";
        var n = (doc[counterKey] is JsonValue v && v.GetValueKind() == JsonValueKind.Number ? v.GetValue<int>() : 0) + 1;
        doc[counterKey] = n;
        await uow.ExecuteAsync(
            "INSERT INTO platform_settings (`key`, `value`, updated_at) VALUES (@key, CAST(@value AS JSON), UTC_TIMESTAMP(6)) " +
            "ON DUPLICATE KEY UPDATE `value` = CAST(@value AS JSON), updated_at = UTC_TIMESTAMP(6)",
            new { key, value = doc.ToJsonString() });
        return n;
    }
    /// <summary>The fleet hand-off fields on a package (reference: fleet.ready_for_pickup / use_courier writes).</summary>
    public Task<int> UpdateSubFleetAsync(SubOrderModel s, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE sub_orders SET shipping_provider = @ShippingProvider, ready_for_pickup_at = @ReadyForPickupAt,
                pickup_code = @PickupCode, delivery_otp = @DeliveryOtp, delivery_zone_id = @DeliveryZoneId,
                fleet_alerted_at = @FleetAlertedAt, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @Id
            """, s);

    /// <summary>Reference: jobs.expire_unpaid_orders — payment window closed and still unpaid.</summary>
    public Task<IEnumerable<OrderModel>> PendingPaymentExpiredAsync(DateTime now) => db.QueryAsync<OrderModel>(
        "SELECT * FROM orders WHERE status = 'pending_payment' AND payment_expires_at < @now ORDER BY created_at LIMIT 100",
        new { now });

    public Task<IEnumerable<PaymentModel>> PaymentsForOrderAsync(Guid orderId) => db.QueryAsync<PaymentModel>(
        "SELECT * FROM payments WHERE order_id = @orderId ORDER BY created_at", new { orderId });

    /// <summary>Reference: jobs.pending_refund_ids.</summary>
    public Task<IEnumerable<Guid>> PendingRefundIdsAsync() => db.QueryAsync<Guid>(
        "SELECT id FROM refunds WHERE status = 'pending' AND provider_refund_id IS NULL ORDER BY created_at LIMIT 50");

    /// <summary>Reference: jobs.cancel_unconfirmed_orders (skip-locked batch).</summary>
    public Task<IEnumerable<SubOrderModel>> UnconfirmedForUpdateAsync(DateTime cutoff, IUnitOfWork uow) => uow.QueryAsync<SubOrderModel>(
        "SELECT * FROM sub_orders WHERE status = 'placed' AND created_at < @cutoff ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED",
        new { cutoff });
    /// <summary>One package by its customer-facing number (reference: assistant/actions.py _package).</summary>
    public Task<SubOrderModel?> SubByNumberAsync(string number) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE UPPER(number) = @number", new { number });
}
