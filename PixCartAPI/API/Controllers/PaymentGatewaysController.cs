using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;

/// <summary>Cashfree, PhonePe, PayU and Stripe: the shopper's return and the server-to-server events (public on purpose; nothing in the
/// request is trusted, the payment is checked with the gateway), pay another way, and Admin → Payments.</summary>
[ApiController]
public class PaymentGatewaysController(IPaymentFlowBAL flow, IPaymentGatewayBAL bal, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/payments/{code}/callback"), HttpPost("/api/payments/{code}/callback"), RouteGuard("public")]
    public async Task<IActionResult> Callback(string code)
    {
        var data = Request.Query.ToDictionary(q => q.Key, q => q.Value.ToString());
        if (HttpMethods.IsPost(Request.Method))
        {
            try { if (Request.HasFormContentType) foreach (var f in await Request.ReadFormAsync()) data[f.Key] = f.Value.ToString(); }
            catch (Exception e) when (e is InvalidDataException or IOException or BadHttpRequestException) { }
        }
        var (orderId, outcome, reason) = await flow.ReturnAsync(code, data);
        var query = "payment=" + API.Helpers.UrlQuery.QuotePlus(outcome);
        if (reason.Length > 0) query += "&reason=" + API.Helpers.UrlQuery.QuotePlus(reason.Length > 160 ? reason[..160] : reason);
        Response.Headers.Location = orderId is { } id ? $"/orders/{id}?{query}" : $"/orders?{query}";
        return StatusCode(303);
    }

    [HttpPost("/api/payments/{code}/webhook"), RouteGuard("public")]
    public async Task<object> Webhook(string code)
    {
        using var ms = new MemoryStream();
        await Request.Body.CopyToAsync(ms);
        return await flow.WebhookAsync(code, Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString()), ms.ToArray());
    }

    public record SwitchIn { public string? Provider { get; init; } }
    [HttpPost("/api/orders/{orderId}/payment/switch"), SignedIn, RouteGuard("signed_in")]
    public async Task<object> Switch(Guid orderId, SwitchIn? body) => await flow.SwitchAsync(await me.RequireAsync(), orderId, body?.Provider);

    [HttpGet("/api/admin/payments/gateways"), SignedIn, RouteGuard("perm:settings")]
    public async Task<object> Gateways() => await bal.GatewaysAsync(await me.RequireAsync());
    [HttpPut("/api/admin/payments/routing"), SignedIn, RouteGuard("perm:settings")]
    public async Task<object> Routing(JsonObject body) => await bal.UpdateRoutingAsync(await me.RequireAsync(), body);
    [HttpPost("/api/admin/payments/gateways/{code}/test"), SignedIn, RouteGuard("perm:settings")]
    public async Task<object> Test(string code) => await bal.TestAsync(await me.RequireAsync(), code);
}
