using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>Razorpay keys in force: Admin → Integrations values over appsettings (App:Razorpay*).</summary>
public sealed record RazorpayConfig(string KeyId, string KeySecret, string ApiBase, bool Checkout)
{
    /// <summary>Keys are set (razorpay_enabled).</summary>
    public bool Enabled => KeyId.Length > 0 && KeySecret.Length > 0;

    /// <summary>Customers can choose online payment at checkout.</summary>
    public bool OnlinePayments => Enabled && Checkout;
}

/// <summary>A Razorpay call failed: not configured, not reachable, or Razorpay refused it (the message says why).</summary>
public sealed class RazorpayGatewayException(string message) : Exception(message);

/// <summary>
/// A minimal Razorpay REST client for customers and saved-card tokens (the storefront's saved cards). The payments
/// module can replace the registration with its full client (orders, payments, refunds) implementing this interface.
/// HTTP goes through the named HttpClient "razorpay" (tests swap its handler).
/// </summary>
public interface IRazorpayClient
{
    Task<RazorpayConfig> ConfigAsync();

    /// <summary>Online payments offered at checkout (keys set and the Admin → Integrations switch on).</summary>
    Task<bool> OnlinePaymentsAsync();

    /// <summary>POST /customers (an existing customer with the same contact is returned).</summary>
    Task<JsonObject> CreateCustomerAsync(string name, string contact, string email);

    /// <summary>GET /customers/{id}/tokens: the customer's saved cards and other tokens.</summary>
    Task<List<JsonObject>> CustomerTokensAsync(string customerId);

    /// <summary>DELETE /customers/{id}/tokens/{token}.</summary>
    Task DeleteTokenAsync(string customerId, string tokenId);
}
