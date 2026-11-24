using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Notifications inbox, delivery estimates, checkout coupons and the analytics beacon
/// (reference: routers/customer.py).</summary>
[ApiController]
public class CustomerExtrasController(ICustomerExtrasBAL extras, ICatalogBAL catalog, ICouponsBAL coupons,
    IPlatformSettingsBAL platform, ICurrentUser current) : ControllerBase
{
    [HttpGet("/api/notifications")]
    [SignedIn]
    public async Task<JsonObject> Notifications([FromQuery, Range(1, int.MaxValue)] int page = 1) =>
        await extras.NotificationsAsync((await current.RequireAsync()).Id, page);

    [HttpPost("/api/notifications/read-all")]
    [SignedIn]
    public async Task<JsonObject> ReadAll()
    {
        await extras.ReadAllAsync((await current.RequireAsync()).Id);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: delivery_estimate.</summary>
    [HttpGet("/api/catalog/delivery-estimate")]
    public async Task<JsonObject> DeliveryEstimate([FromQuery(Name = "variant_id")] Guid variantId,
        [FromQuery, StringLength(6, MinimumLength = 6)] string pincode) =>
        await catalog.DeliveryEstimateAsync(variantId, pincode);

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

    /// <summary>Reference: event — always 204.</summary>
    [HttpPost("/api/events")]
    [Consumes("application/json")]
    public async Task<IActionResult> Event([FromBody] EventIn body)
    {
        if (body.Type is "view" or "add_to_cart")
            await extras.EventAsync(current.IpAddress, body.Type, body.ProductId);
        return StatusCode(204);
    }

    /// <summary>Reference: EventIn.</summary>
    public class EventIn
    {
        [Required]
        public string Type { get; set; } = "";
        [Required]
        public Guid ProductId { get; set; }
    }
}
