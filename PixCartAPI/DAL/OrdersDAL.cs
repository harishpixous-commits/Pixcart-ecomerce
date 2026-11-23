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

    public async Task<IReadOnlyList<OrderItemModel>> ItemsAsync(IReadOnlyList<Guid> subOrderIds)
    {
        if (subOrderIds.Count == 0) return [];
        var rows = await db.QueryAsync<OrderItemModel>(
            "SELECT * FROM order_items WHERE sub_order_id IN @subOrderIds", new { subOrderIds });
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
}
