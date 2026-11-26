using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Notifications inbox, delivery estimates, checkout coupons and the analytics beacon
/// (reference: routers/customer.py).</summary>
[ApiController]
public class CustomerExtrasController(ICouponsBAL coupons, IPlatformSettingsBAL platform) : ControllerBase
{
    /// <summary>Reference: checkout_coupons.</summary>
    [HttpGet("/api/checkout/coupons")]
    [SignedIn]
    public async Task<JsonObject> CheckoutCoupons()
    {
        var cfg = await platform.GetAsync();
        return new JsonObject
        {
            ["items"] = cfg.Bool("feature_coupons")
                ? new JsonArray((await coupons.ListForCheckoutAsync()).Select(c => (JsonNode)c).ToArray())
                : new JsonArray(),
        };
    }

}
