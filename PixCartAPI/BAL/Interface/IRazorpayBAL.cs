using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>
/// Razorpay REST client boundary (reference: services/razorpay.py). Amounts are integer paise; auth is HTTP Basic
/// (key id/secret). Payment verification, refunds and webhooks use it from the orders and refund services.
/// </summary>
public interface IRazorpayBAL
{
    /// <summary>Customers can choose online payment at checkout: keys configured AND the checkout switch on.</summary>
    Task<bool> OnlinePaymentsAsync();

    /// <summary>Creates a Razorpay order (reference: create_order). Amount is in the currency's smallest unit
    /// (paise for INR); other currencies need Razorpay international payments.</summary>
    Task<JsonObject> CreateOrderAsync(long amount, string receipt, IReadOnlyDictionary<string, string> notes, string currency = "INR");

    /// <summary>Creates a Razorpay customer for saved cards (reference: create_customer).</summary>
    Task<JsonObject> CreateCustomerAsync(string name, string contact, string email);

    /// <summary>A payment's real state from Razorpay (reference: fetch_payment).</summary>
    Task<JsonObject> FetchPaymentAsync(string paymentId);

    /// <summary>Every payment attempt on a Razorpay order (reference: order_payments).</summary>
    Task<IReadOnlyList<JsonObject>> OrderPaymentsAsync(string orderId);

    /// <summary>Captures an authorized payment (reference: capture_payment).</summary>
    Task<JsonObject> CapturePaymentAsync(string paymentId, long amount, string currency = "INR");

    /// <summary>Refunds (part of) a captured payment (reference: refund_payment). Amount is in the currency the
    /// shopper paid; use the RefundCharge rule to convert paise.</summary>
    Task<JsonObject> RefundPaymentAsync(string paymentId, long amount, string receipt, IReadOnlyDictionary<string, string> notes);

    /// <summary>The checkout signature, HMAC-SHA256 of "order_id|payment_id" with the key secret (reference:
    /// verify_payment_signature). False when no secret is configured.</summary>
    Task<bool> VerifyPaymentSignatureAsync(string orderId, string paymentId, string signature);

    /// <summary>A webhook body's X-Razorpay-Signature (reference: verify_webhook_signature). False when no webhook
    /// secret is configured.</summary>
    Task<bool> VerifyWebhookSignatureAsync(byte[] body, string signature);
}
