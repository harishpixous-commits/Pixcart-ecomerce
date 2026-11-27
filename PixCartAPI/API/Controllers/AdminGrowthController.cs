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
    public record AdjustIn { [System.ComponentModel.DataAnnotations.Required] public Guid? UserId { get; init; } [System.ComponentModel.DataAnnotations.Range(-100000, 100000)] public int Points { get; init; } [System.ComponentModel.DataAnnotations.Required, System.ComponentModel.DataAnnotations.StringLength(200, MinimumLength = 3)] public string Note { get; init; } = ""; }
    [HttpPost("loyalty/adjust"), RouteGuard("perm:marketing")] public async Task<object> Adjust(AdjustIn b) => await bal.AdjustPointsAsync(await me.RequireAsync(), b.UserId!.Value, b.Points, b.Note);
    [HttpGet("scorecard"), RouteGuard("perm:dashboard")] public async Task<object> Scorecard() => await bal.ScorecardAsync(await me.RequireAsync());
}

[ApiController, SignedIn, Route("/api/loyalty")]
public class LoyaltyController(IGrowthBAL bal, ICurrentUser me) : ControllerBase
{
    [HttpGet, RouteGuard("signed_in")] public async Task<object> Mine() => await bal.LoyaltyAsync((await me.RequireAsync()).Id);
    public record RedeemIn { [System.ComponentModel.DataAnnotations.Range(1, 1000000)] public int Points { get; init; } }
    [HttpPost("redeem"), RouteGuard("signed_in")] public async Task<object> Redeem(RedeemIn b) => await bal.RedeemPointsAsync((await me.RequireAsync()).Id, b.Points);
}

[ApiController, SignedIn]
public class ReferralController(Utils.Interface.IMySqlDapperHelper db, ICurrentUser me) : ControllerBase
{
    public record ApplyIn { [System.ComponentModel.DataAnnotations.Required, System.ComponentModel.DataAnnotations.StringLength(20, MinimumLength = 4)] public string Code { get; init; } = ""; }
    [HttpGet("/api/referral"), RouteGuard("signed_in")] public async Task<object> Mine() => await BAL.ReferralRewards.SummaryAsync(db, (await me.RequireAsync()).Id);
    [HttpPost("/api/referral/apply"), RouteGuard("signed_in")] public async Task<object> Apply(ApplyIn b) => await BAL.ReferralRewards.ApplyAsync(db, (await me.RequireAsync()).Id, b.Code);
    [HttpGet("/api/admin/growth/referrals"), RouteGuard("perm:marketing")] public async Task<object> All() { await me.RequireAsync(); return new { items = await BAL.ReferralRewards.ListAsync(db) }; }
}

[ApiController]
public class SeoController(IGrowthBAL bal) : ControllerBase
{
    private async Task<IActionResult> Map() => await bal.SitemapAsync() is { } xml ? Content(xml, "application/xml") : NotFound(new { error = new { code = "not_found", message = "Sitemap not found", fields = new { } } });
    [HttpGet("/api/seo/sitemap.xml"), RouteGuard("public")] public Task<IActionResult> Api() => Map();
    [HttpGet("/sitemap.xml"), RouteGuard("public")] public Task<IActionResult> Root() => Map();
    [HttpGet("/robots.txt"), RouteGuard("public")] public IActionResult Robots() => Content(bal.RobotsTxt(), "text/plain");
}

[ApiController, SignedIn, Route("/api/seller/scorecard")]
public class SellerScorecardController(IGrowthBAL bal, ICurrentUser me) : ControllerBase
{
    [HttpGet, RouteGuard("approved_seller")] public async Task<object> Mine() => await bal.MyScorecardAsync((await me.RequireSellerAsync(approved: true)).Id);
}
