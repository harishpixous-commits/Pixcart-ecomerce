using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Staff returns operations (reference: routers/admin_extras.py returns endpoints — same paths, bodies and
/// payloads). Listing and opening returns needs the "orders" permission; decisions and COD refund marking need
/// "refunds".
/// </summary>
[ApiController]
[Route("/api/admin")]
[SignedIn]
public class AdminReturnsController(IReturnsBAL returns, ICurrentUser current) : ControllerBase
{
    /// <summary>Search returns (reference: GET /api/admin/returns).</summary>
    [HttpGet("returns")]
    public async Task<JsonObject> List([FromQuery] string? status, [FromQuery] string q = "",
        [FromQuery] Guid? sellerId = null, [FromQuery, Range(1, 100000)] int page = 1) =>
        await returns.AdminListAsync(await current.RequireAsync(), status, q, sellerId, page);

    /// <summary>What can still be returned from an order (reference: GET /api/admin/orders/{order_id}/returnable).</summary>
    [HttpGet("orders/{orderId:guid}/returnable")]
    public async Task<JsonObject> Returnable(Guid orderId) =>
        await returns.AdminReturnableAsync(await current.RequireAsync(), orderId);

    public sealed record CreateIn(
        [param: Required] Guid SubOrderId,
        [param: Required, MinLength(1), MaxLength(50)] List<JsonElement> Items, // free-form objects, checked by ReturnLines.Parse
        [param: Required] string Reason, // checked against the return reasons by the business layer, like the reference
        [param: MaxLength(2000)] string Comment = "",
        [param: MaxLength(60)] string RefundUpi = "");

    /// <summary>Open a return for the customer (reference: POST /api/admin/returns).</summary>
    [HttpPost("returns")]
    public async Task<JsonObject> Create(CreateIn body)
    {
        var lines = API.Helpers.ReturnLines.Parse(body.Items); // the reference's ReturnIn.lines()
        return await returns.AdminCreateAsync(await current.RequireAsync(), body.SubOrderId, lines,
            body.Reason, body.Comment, body.RefundUpi.Trim());
    }

    public sealed record ActIn(
        [param: Required, RegularExpression("^(approve|reject|received|mark_refunded)$")] string Action,
        [param: MaxLength(2000)] string Note = "",
        [param: MaxLength(60)] string Reference = "");

    /// <summary>Decide on a return, or mark a COD refund paid with its reference
    /// (reference: POST /api/admin/returns/{return_id}).</summary>
    [HttpPost("returns/{returnId:guid}")]
    public async Task<JsonObject> Act(Guid returnId, ActIn body) =>
        await returns.AdminActAsync(await current.RequireAsync(), returnId, body.Action, body.Note, body.Reference);
}
