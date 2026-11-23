using BAL.Interface;
using Utils;

namespace BAL;

/// <summary>
/// Razorpay gateway state (reference: config.py online_payments = razorpay_enabled AND razorpay_checkout).
/// Admin-saved integration values override appsettings once the commerce module merges the
/// IntegrationBAL store from port/auth; until then this reads the server configuration.
/// </summary>
public class RazorpayBAL(AppSettings app) : IRazorpayBAL
{
    public Task<bool> OnlinePaymentsAsync() =>
        Task.FromResult(app.RazorpayKeyId.Length > 0 && app.RazorpayKeySecret.Length > 0 && app.RazorpayCheckout);
}
