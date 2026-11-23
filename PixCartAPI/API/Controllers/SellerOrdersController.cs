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

    private async Task<JsonObject> Act(Guid subId, string dst)
    {
        var user = await current.RequireAsync();
        return await orders.SellerActAsync(user, await orders.RequireSellerAsync(user, approved: true), subId, dst);
    }
}
