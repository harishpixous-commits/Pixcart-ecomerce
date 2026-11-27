using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;

/// <summary>Admin → Growth settings and the seller scorecard. No reference route guard rows: guards are declared here.</summary>
[ApiController, SignedIn, Route("/api/admin/growth")]
public class AdminGrowthController(IGrowthBAL bal, ICurrentUser me) : ControllerBase
{
    [HttpGet("settings"), RouteGuard("perm:marketing")] public async Task<object> Settings() => await bal.SettingsAsync(await me.RequireAsync());
    [HttpPut("settings"), RouteGuard("perm:marketing")] public async Task<object> Settings(JsonObject body) => await bal.UpdateAsync(await me.RequireAsync(), body);
    [HttpGet("scorecard"), RouteGuard("perm:dashboard")] public async Task<object> Scorecard() => await bal.ScorecardAsync(await me.RequireAsync());
}
