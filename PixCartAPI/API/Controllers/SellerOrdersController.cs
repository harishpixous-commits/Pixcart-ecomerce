using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The seller's order queues (reference: routers/seller_orders.py — same paths and payload). This slice: list,
/// detail, confirm and pack. Ship/deliver arrive with their invoice and payout companions; the fleet endpoints come
/// with the delivery module.
/// </summary>
[ApiController]
[Route("/api/seller")]
[SignedIn]
public class SellerOrdersController(IOrdersBAL orders, ICurrentUser current) : ControllerBase
{
    /// <summary>The order queues (reference: GET /api/seller/orders).</summary>
    [HttpGet("orders")]
    public async Task<JsonObject> List(
        [FromQuery] string? status, [FromQuery] string q = "", [FromQuery] int page = 1,
        [FromQuery(Name = "page_size")] int pageSize = 20)
    {
        if (q.Length > 40) throw new AppException("q must be at most 40 characters", "validation", 422);
        if (page < 1 || pageSize < 1 || pageSize > 100)
            throw new AppException("page must be at least 1 and page_size between 1 and 100", "validation", 422);
        var user = await current.RequireAsync();
        return await orders.SellerListAsync(await orders.RequireSellerAsync(user, approved: false), status, q, page, pageSize);
    }

    /// <summary>One package (reference: GET /api/seller/orders/{sub_id}).</summary>
    [HttpGet("orders/{subId:guid}")]
    public async Task<JsonObject> Get(Guid subId)
    {
        var user = await current.RequireAsync();
        return await orders.SellerGetAsync(await orders.RequireSellerAsync(user, approved: false), subId);
    }

    /// <summary>Accept the order (reference: POST /api/seller/orders/{sub_id}/confirm).</summary>
    [HttpPost("orders/{subId:guid}/confirm")]
    public Task<JsonObject> Confirm(Guid subId) => Act(subId, "confirmed");

    /// <summary>Mark it packed (reference: POST /api/seller/orders/{sub_id}/pack).</summary>
    [HttpPost("orders/{subId:guid}/pack")]
    public Task<JsonObject> Pack(Guid subId) => Act(subId, "packed");

    /// <summary>Hand it to a courier (reference: POST /api/seller/orders/{sub_id}/ship).</summary>
    [HttpPost("orders/{subId:guid}/ship")]
    public Task<JsonObject> Ship(Guid subId, ShipIn body) =>
        Act(subId, "shipped", $"{body.CourierName.Trim()} {body.TrackingNumber.Trim()}", body);

    /// <summary>Cancel a package not yet shipped (reference: POST /api/seller/orders/{sub_id}/reject).</summary>
    [HttpPost("orders/{subId:guid}/reject")]
    public async Task<JsonObject> Reject(Guid subId, RejectIn body)
    {
        var user = await current.RequireAsync();
        return await orders.SellerRejectAsync(user, await orders.RequireSellerAsync(user, approved: false), subId,
            body.Reason, body.Note, body.OutOfStockItems ?? []);
    }

    /// <summary>The seller's own courier brought a shipped package back (reference: POST /api/seller/orders/{sub_id}/rto).</summary>
    [HttpPost("orders/{subId:guid}/rto")]
    public async Task<JsonObject> Rto(Guid subId, RtoIn body)
    {
        var user = await current.RequireAsync();
        return await orders.SellerRtoAsync(user, await orders.RequireSellerAsync(user, approved: true), subId, body.Note);
    }

    /// <summary>Mark it delivered (reference: POST /api/seller/orders/{sub_id}/deliver).</summary>
    [HttpPost("orders/{subId:guid}/deliver")]
    public Task<JsonObject> Deliver(Guid subId) => Act(subId, "delivered", "Marked delivered by seller");

    private async Task<JsonObject> Act(Guid subId, string dst, string note = "", ShipIn? ship = null)
    {
        var user = await current.RequireAsync();
        return await orders.SellerActAsync(user, await orders.RequireSellerAsync(user, approved: true), subId, dst, note,
            ship?.CourierName.Trim(), ship?.TrackingNumber.Trim(), ship is null ? null : ship.TrackingUrl ?? "");
    }

    public sealed record RejectIn(
        [param: Required, RegularExpression("^(out_of_stock|cannot_ship_to_pincode|pricing_error|other)$")] string Reason = "",
        [param: StringLength(200)] string Note = "",
        [param: MaxLength(100)] List<Guid>? OutOfStockItems = null);

    public sealed record RtoIn(
        [param: StringLength(200)] string Note = "");

    public sealed record ShipIn(
        [param: Required, StringLength(60, MinimumLength = 2)] string CourierName = "",
        [param: Required, StringLength(60, MinimumLength = 4), RegularExpression(@"^[A-Za-z0-9\-]+$")] string TrackingNumber = "",
        [param: Url, StringLength(300)] string? TrackingUrl = null);
}
