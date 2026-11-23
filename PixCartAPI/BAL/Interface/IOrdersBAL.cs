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
}
