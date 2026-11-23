using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Order placement and the shopper's order view (reference: services/orders.py + the checkout routes of
/// routers/orders.py).</summary>
public interface IOrdersBAL
{
    /// <summary>Places the order (reference: place_order). Idempotent on IdempotencyKey per shopper; throws
    /// AppException/ConflictException with the reference's codes and texts.</summary>
    Task<(OrderModel Order, PaymentModel? Payment)> PlaceOrderAsync(
        UserModel user,
        Guid addressId,
        string paymentMethod,
        string idempotencyKey,
        long? expectedTotal,
        string? couponCode = null,
        int tipPaise = 0,
        string buyerGstin = "",
        string buyerBusiness = "",
        string? instructions = null,
        bool noBag = false,
        string? currency = null);

    /// <summary>The order as its shopper sees it (reference: routers/orders.py order_detail with for_admin false).</summary>
    Task<JsonObject> DetailAsync(OrderModel order, bool forAdmin = false);

    /// <summary>What the payment window needs while the order is unpaid (reference: shopper_checkout +
    /// checkout_payload). Null for COD orders and paid ones.</summary>
    Task<JsonObject?> ShopperCheckoutAsync(OrderModel order, PaymentModel? payment, UserModel user);

    /// <summary>POST /api/payments/razorpay/verify (reference: verify_payment): signature check, then the gateway's
    /// own record of the payment is trusted, never the browser. Returns the result word and the order.</summary>
    Task<(string Result, OrderModel Order)> VerifyPaymentAsync(UserModel user, string razorpayOrderId, string razorpayPaymentId, string razorpaySignature);

    /// <summary>POST /api/orders/{id}/payment-status (reference: payment_status): paid | waiting | failed |
    /// not_paid | unknown, from Razorpay's records, plus the shopper's order view.</summary>
    Task<JsonObject> PaymentStatusAsync(UserModel user, Guid orderId);

    /// <summary>A refund in rupees as Razorpay must send it: in the currency the shopper paid, at the order's own
    /// rate (reference: refund_charge).</summary>
    long RefundCharge(PaymentModel payment, long paise);

    /// <summary>The payment's real state from Razorpay, recorded (reference: confirm_with_gateway).</summary>
    Task<string> ConfirmWithGatewayAsync(PaymentModel payment, string providerPaymentId, Utils.Interface.IUnitOfWork uow);

    /// <summary>Idempotently records a captured payment (reference: mark_paid). Returns 'paid', 'already' or
    /// 'refund' (a duplicate or late payment, refunded in full).</summary>
    Task<string> MarkPaidAsync(PaymentModel payment, string providerPaymentId, string method, long amount, Utils.Interface.IUnitOfWork uow);

    /// <summary>The shopper's orders page (reference: GET /api/orders my_orders + order_summary).</summary>
    Task<JsonObject> MyOrdersAsync(UserModel user, int page, int pageSize);

    /// <summary>The order as its shopper sees it (reference: GET /api/orders/{order_id} → _shopper_order).</summary>
    Task<JsonObject> GetShopperOrderAsync(UserModel user, Guid orderId);

    /// <summary>Cancels the customer's cancellable packages, all or one (reference: POST /api/orders/{order_id}/cancel
    /// + customer_cancel). Returns the order detail snapshot; queued refunds are then sent to the gateway.</summary>
    Task<JsonObject> CancelAsync(UserModel user, Guid orderId, string reason, Guid? subOrderId);

    /// <summary>Sends queued refunds to the gateway (reference: run_refunds); the refund retry job calls this too.</summary>
    Task ProcessRefundsAsync(IReadOnlyList<Guid> refundIds);

    /// <summary>Sends one pending refund, repeatable (reference: process_refund; attempts ≥ 8 → failed).</summary>
    Task ProcessRefundAsync(Guid refundId);

    /// <summary>The caller's seller account (reference: deps.seller_account / approved_seller).</summary>
    Task<SellerModel> RequireSellerAsync(UserModel user, bool approved);

    /// <summary>The seller's order queues (reference: GET /api/seller/orders).</summary>
    Task<JsonObject> SellerListAsync(SellerModel seller, string? status, string q, int page, int pageSize);

    /// <summary>One package as the seller sees it (reference: GET /api/seller/orders/{sub_id}).</summary>
    Task<JsonObject> SellerGetAsync(SellerModel seller, Guid subId);

    /// <summary>confirm / pack (reference: _act). ship/deliver arrive with their invoice/payout companions.</summary>
    Task<JsonObject> SellerRejectAsync(UserModel user, SellerModel seller, Guid subId,
        string reasonKey, string note, IReadOnlyList<Guid> outOfStockItems);

    Task<JsonObject> SellerRtoAsync(UserModel user, SellerModel seller, Guid subId, string note);

    Task<JsonObject> SellerActAsync(UserModel user, SellerModel seller, Guid subId, string dst, string note = "",
        string? courierName = null, string? trackingNumber = null, string? trackingUrl = null);
}
