using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The seller's returns desk (reference: routers/seller_extras.py returns endpoints — same paths, bodies and
/// payloads). The seller approves or rejects, records their own courier, and checks received items back in.
/// </summary>
[ApiController]
[Route("/api/seller/returns")]
[SignedIn]
public class SellerReturnsController(IReturnsBAL returns, ICurrentUser current) : ControllerBase
{
    /// <summary>List returns, newest first (reference: GET /api/seller/returns).</summary>
    [HttpGet("")]
    public async Task<JsonObject> List([FromQuery] string? status, [FromQuery, Range(1, 100000)] int page = 1) =>
        await returns.SellerListAsync(await current.RequireAsync(), status, page);

    public sealed record ItemCondition([param: Required] Guid OrderItemId,
        [param: RegularExpression("^(sellable|damaged)$")] string Condition = "sellable");

    public sealed record ActIn(
        [param: Required, RegularExpression("^(approve|reject|picked_up|received)$")] string Action,
        [param: MaxLength(2000)] string Note = "",
        [param: MaxLength(60)] string Courier = "",
        [param: MaxLength(60)] string Tracking = "",
        [param: MaxLength(100)] List<ItemCondition> Items = null!);

    /// <summary>Decide on a return (reference: POST /api/seller/returns/{return_id}).</summary>
    [HttpPost("{returnId}")]
    public async Task<JsonObject> Act(Guid returnId, ActIn body)
    {
        var conditions = (body.Items ?? []).Where(c => c.Condition is "sellable" or "damaged")
            .ToDictionary(c => c.OrderItemId, c => c.Condition);
        return await returns.SellerActAsync(await current.RequireAsync(), returnId, body.Action,
            body.Note, body.Courier, body.Tracking, conditions);
    }
}
