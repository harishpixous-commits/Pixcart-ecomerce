namespace BAL.Interface;

/// <summary>
/// Razorpay gateway state (reference: config.py online_payments). The full gateway
/// client (orders, UPI, refunds, webhooks) lands with the commerce module.
/// </summary>
public interface IRazorpayBAL
{
    /// <summary>Customers can choose online payment at checkout: keys configured AND the checkout switch on.</summary>
    Task<bool> OnlinePaymentsAsync();
}
