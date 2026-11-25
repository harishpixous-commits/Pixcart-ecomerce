using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The shopper's returns (reference: routers/customer.py returns endpoints — same paths, bodies and payloads).
/// Seller and staff decisions land with the seller/admin returns slices.
/// </summary>
[ApiController]
public class ReturnsController(IReturnsBAL returns, ICurrentUser current) : ControllerBase
{
    /// <summary>Why a customer can return an item; defect reasons stay allowed past the normal window
    /// (reference: GET /api/returns/reasons).</summary>
    [HttpGet("/api/returns/reasons")]
    public JsonObject Reasons() => new()
    {
        ["reasons"] = new JsonArray(PlatformSettingsBAL.ReturnReasons.Select(kv => (JsonNode?)new JsonObject
        {
            ["code"] = kv.Key, ["label"] = kv.Value,
            ["defect"] = PlatformSettingsBAL.DefectReasons.Contains(kv.Key),
        }).ToArray()),
    };

    /// <summary>What can still be returned from the order, and its returns so far
    /// (reference: GET /api/orders/{order_id}/returnable).</summary>
    [HttpGet("/api/orders/{orderId:guid}/returnable")]
    [SignedIn]
    public async Task<JsonObject> Returnable(Guid orderId) =>
        await returns.ReturnableAsync(await current.RequireAsync(), orderId);

    public sealed record CreateIn(
        [param: Required] Guid SubOrderId,
        [param: Required, MinLength(1), MaxLength(50)] List<CreateLine> Items,
        [param: Required, MaxLength(60)] string Reason,
        [param: MaxLength(2000)] string Comment = "",
        [param: MaxLength(60)] string RefundUpi = "");

    public sealed record CreateLine([param: Required] Guid OrderItemId, [param: Range(1, 1000)] int Qty);

    /// <summary>Ask to return items of a delivered package (reference: POST /api/returns).</summary>
    [HttpPost("/api/returns")]
    [SignedIn]
    public async Task<JsonObject> Create(CreateIn body)
    {
        var lines = body.Items.Select(i => (i.OrderItemId, i.Qty)).ToList();
        var ret = await returns.CreateAsync(await current.RequireAsync(), body.SubOrderId, lines,
            body.Reason.Trim(), body.Comment.Trim(), body.RefundUpi.Trim());
        Response.StatusCode = StatusCodes.Status201Created;
        return await returns.ReturnOutAsync(ret);
    }

    /// <summary>Cancel your own return request (reference: POST /api/returns/{return_id}/cancel).</summary>
    [HttpPost("/api/returns/{returnId:guid}/cancel")]
    [SignedIn]
    public async Task<JsonObject> Cancel(Guid returnId) =>
        await returns.CancelAsync(await current.RequireAsync(), returnId);
}
