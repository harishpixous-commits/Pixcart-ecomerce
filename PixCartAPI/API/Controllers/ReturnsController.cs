using System.ComponentModel.DataAnnotations;
using System.Text.Json;
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
        [param: Required, MinLength(1), MaxLength(50)] List<JsonElement> Items, // free-form objects, like the reference's list[dict]
        [param: Required] string Reason, // checked against the return reasons by the business layer, like the reference
        [param: MaxLength(2000)] string Comment = "",
        [param: MaxLength(60)] string RefundUpi = "");

    /// <summary>Ask to return items of a delivered package (reference: POST /api/returns).</summary>
    [HttpPost("/api/returns")]
    [SignedIn]
    public async Task<JsonObject> Create(CreateIn body)
    {
        var lines = API.Helpers.ReturnLines.Parse(body.Items); // the reference's ReturnIn.lines()
        var ret = await returns.CreateAsync(await current.RequireAsync(), body.SubOrderId, lines,
            body.Reason, body.Comment, body.RefundUpi.Trim());
        Response.StatusCode = StatusCodes.Status201Created;
        return await returns.ReturnOutAsync(ret);
    }

    /// <summary>Cancel your own return request (reference: POST /api/returns/{return_id}/cancel).</summary>
    [HttpPost("/api/returns/{returnId:guid}/cancel")]
    [SignedIn]
    public async Task<JsonObject> Cancel(Guid returnId) =>
        await returns.CancelAsync(await current.RequireAsync(), returnId);
}
