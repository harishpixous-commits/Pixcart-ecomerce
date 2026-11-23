using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>
/// Razorpay REST client boundary (reference: services/razorpay.py). Amounts are integer paise; auth is HTTP Basic
/// (key id/secret). Payments (verify, refunds, webhooks) land with the payments slice.
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
}
