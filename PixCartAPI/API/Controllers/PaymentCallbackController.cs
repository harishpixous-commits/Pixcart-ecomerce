using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>
/// Razorpay's return to the site after a payment. Public on purpose: Razorpay's own page posts here, so nobody is
/// signed in, and nothing in the post is trusted (the signature is checked and the payment confirmed with Razorpay).
/// </summary>
[ApiController]
public class PaymentCallbackController(IOrdersBAL orders) : ControllerBase
{
    /// <summary>
    /// Where Razorpay sends the shopper after paying (its callback_url; reference: GET/POST
    /// /api/payments/razorpay/callback). Nobody needs to be signed in: Razorpay's page posts here, and nothing in the
    /// post is trusted. Answers 303 to the order page (a relative address, so it lands on the site the payment started from).
    /// </summary>
    [HttpGet("/api/payments/razorpay/callback"), HttpPost("/api/payments/razorpay/callback")]
    public async Task<IActionResult> RazorpayCallback()
    {
        var data = Request.Query.ToDictionary(q => q.Key, q => q.Value.ToString());
        if (HttpMethods.IsPost(Request.Method))
        {
            try
            {
                if (Request.HasFormContentType)
                    foreach (var f in await Request.ReadFormAsync()) data[f.Key] = f.Value.ToString();
            }
            catch (Exception e) when (e is InvalidDataException or IOException or BadHttpRequestException)
            {
                // a malformed post is treated as "no details"
            }
        }
        var (orderId, outcome, reason) = await orders.PaymentReturnAsync(data);
        var query = "payment=" + API.Helpers.UrlQuery.QuotePlus(outcome);
        if (reason.Length > 0) query += "&reason=" + API.Helpers.UrlQuery.QuotePlus(reason.Length > 160 ? reason[..160] : reason);
        Response.Headers.Location = orderId is { } id ? $"/orders/{id}?{query}" : $"/orders?{query}";
        return StatusCode(303);
    }
}
