using Utils.Interface;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;

/// <summary>Admin → Growth settings and the seller scorecard. No reference route guard rows: guards are declared here.</summary>
[ApiController, SignedIn, Route("/api/admin/growth")]
public class AdminGrowthController(IGrowthBAL bal, ICurrentUser me, IMySqlDapperHelper db) : ControllerBase
{
    [HttpGet("cart-reminders"), RouteGuard("perm:marketing")] public async Task<object> CartReminderLog() { await me.RequireAsync(); return await BAL.CartReminders.RecentAsync(db); }
    [HttpGet("segments"), RouteGuard("perm:marketing")] public async Task<object> Segments(string? segment) { await me.RequireAsync(); return await BAL.Segments.ListAsync(db, segment); }
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

[ApiController, SignedIn]
public class GiftCardsController(Utils.Interface.IMySqlDapperHelper db, ICurrentUser me, IRateLimitBAL limits, IAuditBAL audit, IPaymentGatewayBAL gateways, IIntegrationBAL integrations) : ControllerBase
{
    public record IssueIn { [System.ComponentModel.DataAnnotations.Range(100, 100000000)] public int AmountPaise { get; init; } [System.ComponentModel.DataAnnotations.StringLength(200)] public string Note { get; init; } = ""; [System.ComponentModel.DataAnnotations.Range(1, 50)] public int Quantity { get; init; } = 1; public int? ValidityDays { get; init; } }
    public record RedeemIn { [System.ComponentModel.DataAnnotations.Required, System.ComponentModel.DataAnnotations.StringLength(20, MinimumLength = 4)] public string Code { get; init; } = ""; public int? AmountPaise { get; init; } }

    [HttpPost("/api/admin/growth/gift-cards"), RouteGuard("perm:marketing")]
    public async Task<object> Issue(IssueIn b)
    {
        var admin = await me.RequireAsync();
        await using var tx = await db.BeginAsync();
        var items = await BAL.GiftCards.IssueAsync(tx, b.AmountPaise, b.Note, b.Quantity, b.ValidityDays);
        await audit.AuditAsync(admin, "gift_card.issue", "settings", "gift_cards", $"{b.Quantity} x {b.AmountPaise}", tx);
        await tx.CommitAsync();
        return new { items };
    }
    [HttpGet("/api/admin/growth/gift-cards"), RouteGuard("perm:marketing")] public async Task<object> All() { await me.RequireAsync(); return new { items = await BAL.GiftCards.ListAsync(db) }; }
    [HttpGet("/api/admin/growth/gift-card-purchases"), RouteGuard("perm:marketing")] public async Task<object> Purchases() { await me.RequireAsync(); return new { items = await BAL.GiftCards.PurchasesAsync(db) }; }
    [HttpPost("/api/admin/growth/gift-card-purchases/{id:guid}/check"), RouteGuard("perm:marketing")]
    public async Task<object> StaffCheck(Guid id)
    {
        var admin = await me.RequireAsync();
        await using var tx = await db.BeginAsync(); var r = await BAL.GiftCards.CheckPurchaseAsync(tx, gateways, null, id);
        await audit.AuditAsync(admin, "gift_card.purchase_check", "gift_card_purchase", id.ToString(), r["status"]!.GetValue<string>(), tx);
        await tx.CommitAsync(); r.Remove("code"); return r; // the code goes to the buyer, staff see it in the cards list
    }
    [HttpPost("/api/admin/growth/gift-cards/{id:guid}/void"), RouteGuard("perm:marketing")]
    public async Task<object> Void(Guid id)
    {
        var admin = await me.RequireAsync();
        await using var tx = await db.BeginAsync();
        var r = await BAL.GiftCards.VoidAsync(tx, id);
        await audit.AuditAsync(admin, "gift_card.void", "settings", id.ToString(), r["code"]!.GetValue<string>(), tx);
        await tx.CommitAsync();
        return r;
    }
    [HttpPost("/api/gift-cards/balance"), RouteGuard("signed_in")]
    public async Task<object> Balance(RedeemIn b)
    {
        var u = await me.RequireAsync(); await limits.RateLimitAsync($"giftcard:{u.Id}", 20, 600);
        await using var tx = await db.BeginAsync(); var r = await BAL.GiftCards.BalanceAsync(tx, b.Code); await tx.CommitAsync(); return r;
    }
    [HttpGet("/api/gift-cards/options"), RouteGuard("signed_in")]
    public async Task<object> Options()
    {
        await me.RequireAsync();
        await using var tx = await db.BeginAsync(); var c = await BAL.GiftCards.OptionsAsync(tx); await tx.CommitAsync(); return c;
    }
    public record BuyIn { [System.ComponentModel.DataAnnotations.Range(100, 100000000)] public int AmountPaise { get; init; } }
    [HttpPost("/api/gift-cards/purchase"), RouteGuard("signed_in")]
    public async Task<IActionResult> Buy(BuyIn b)
    {
        var u = await me.RequireAsync(); await limits.RateLimitAsync($"giftbuy:{u.Id}", 10, 3600);
        await using var tx = await db.BeginAsync(); var r = await BAL.GiftCards.StartPurchaseAsync(tx, gateways, integrations, u, b.AmountPaise); await tx.CommitAsync(); return StatusCode(201, r);
    }
    [HttpPost("/api/gift-cards/purchase/{id:guid}/check"), RouteGuard("signed_in")]
    public async Task<object> CheckBuy(Guid id)
    {
        var u = await me.RequireAsync();
        await using var tx = await db.BeginAsync(); var r = await BAL.GiftCards.CheckPurchaseAsync(tx, gateways, u.Id, id); await tx.CommitAsync(); return r;
    }
    [HttpPost("/api/gift-cards/redeem"), RouteGuard("signed_in")]
    public async Task<object> Redeem(RedeemIn b)
    {
        var u = await me.RequireAsync(); await limits.RateLimitAsync($"giftcard:{u.Id}", 20, 600);
        await using var tx = await db.BeginAsync(); var r = await BAL.GiftCards.RedeemAsync(tx, u.Id, b.Code, b.AmountPaise); await tx.CommitAsync(); return r;
    }
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
