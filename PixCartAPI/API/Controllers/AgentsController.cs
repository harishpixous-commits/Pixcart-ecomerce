using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;

/// <summary>Admin → AI agents (reference: routers/agents.py): switches and settings, and the proposals waiting for a decision.</summary>
[ApiController]
[Route("/api/admin/agents")]
[SignedIn]
public class AgentsController(IAgentsBAL bal, ICurrentUser me) : ControllerBase
{
    [HttpGet("")] public async Task<JsonObject> Overview() => await bal.OverviewAsync(await me.RequireAsync());
    [HttpPut("settings")] public async Task<JsonObject> Save([FromBody] JsonObject body) => await bal.SaveSettingsAsync(await me.RequireAsync(), body);
    [HttpGet("proposals")]
    public async Task<JsonObject> Proposals([FromQuery, System.ComponentModel.DataAnnotations.RegularExpression("^(pending|done|rejected|expired|failed|all)$")] string status = "pending", [FromQuery] string? agent = null) =>
        await bal.ProposalsAsync(await me.RequireAsync(), status, agent);
    [HttpPost("run")] public async Task<JsonObject> Run() => await bal.RunNowAsync(await me.RequireAsync());
    [HttpPost("proposals/{id:guid}/{decision:regex(^(approve|reject)$)}")]
    public async Task<JsonObject> Decide(Guid id, string decision) => await bal.DecideAsync(await me.RequireAsync(), id, decision);
}
