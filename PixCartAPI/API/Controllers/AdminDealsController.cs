using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Admin deal moderation (reference: routers/promotions.py admin deals routes).</summary>
[ApiController]
[Route("api/admin/deals")]
[SignedIn]
public class AdminDealsController(IDealsBAL deals, ICurrentUser current) : ControllerBase
{
    [HttpGet("")]
    public async Task<JsonObject> List([FromQuery, StringLength(10)] string? status = "pending",
        [FromQuery, StringLength(80)] string q = "", [FromQuery, Range(1, int.MaxValue)] int page = 1) =>
        await deals.AdminListAsync(await current.RequireAsync(), status, q, page);

    [HttpPost("{dealId:guid}/{dealAction}")]
    [Consumes("application/json")]
    public async Task<JsonObject> Action(Guid dealId,
        [RegularExpression("^(approve|reject|cancel)$", ErrorMessage = "dealAction must be approve, reject or cancel")] string dealAction,
        [FromBody] ReasonBody body) =>
        await deals.AdminActionAsync(await current.RequireAsync(), dealId, dealAction, body.Reason);

    /// <summary>Reference: ReasonIn.</summary>
    public class ReasonBody
    {
        [MaxLength(300)]
        public string Reason { get; set; } = "";
    }
}
