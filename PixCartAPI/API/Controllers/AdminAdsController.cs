using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Admin sponsored-products oversight (reference: routers/promotions.py admin ads routes).</summary>
[ApiController]
[Route("api/admin/ads")]
[SignedIn]
public class AdminAdsController(IAdsBAL ads, ICurrentUser current) : ControllerBase
{
    [HttpGet("")]
    public async Task<JsonObject> List([FromQuery, StringLength(10)] string? status = null,
        [FromQuery, StringLength(80)] string q = "", [FromQuery, Range(1, int.MaxValue)] int page = 1) =>
        await ads.AdminListAsync(await current.RequireAsync(), status, q, page);

    [HttpPost("bill")]
    public async Task<JsonObject> Bill() => await ads.AdminBillAsync(await current.RequireAsync());

    [HttpPost("{campaignId}/{campaignAction}")]
    [Consumes("application/json")]
    public async Task<JsonObject> Action(Guid campaignId,
        [RegularExpression("^(approve|reject|pause|resume|end)$", ErrorMessage = "campaignAction must be approve, reject, pause, resume or end")] string campaignAction,
        [FromBody] ReasonBody body) =>
        await ads.AdminActionAsync(await current.RequireAsync(), campaignId, campaignAction, body.Reason);

    /// <summary>Reference: ReasonIn.</summary>
    public class ReasonBody
    {
        [MaxLength(300)]
        public string Reason { get; set; } = "";
    }
}
