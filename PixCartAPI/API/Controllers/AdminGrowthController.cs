using Utils.Interface;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;

/// <summary>Admin → Growth settings and the seller scorecard. No reference route guard rows: guards are declared here.</summary>
[ApiController, SignedIn, Route("/api/admin/growth")]
public class AdminGrowthController(IGrowthBAL bal, ICurrentUser me, IMySqlDapperHelper db, ICatalogNotifyBAL notify) : ControllerBase
{
    [HttpGet("newsletter"), RouteGuard("perm:marketing")] public async Task<object> NewsletterList() { await me.RequireAsync(); return await BAL.Newsletter.ListAsync(db); }
    [HttpDelete("newsletter/{id:guid}"), RouteGuard("perm:marketing")] public async Task<object> NewsletterRemove(Guid id) { await me.RequireAsync(); return await BAL.Newsletter.RemoveAsync(db, id) ? new { ok = true } : throw new Utils.NotFoundException("Subscriber"); }
    [HttpGet("cart-reminders"), RouteGuard("perm:marketing")] public async Task<object> CartReminderLog() { await me.RequireAsync(); return await BAL.CartReminders.RecentAsync(db); }
    [HttpGet("loyalty"), RouteGuard("perm:marketing")] public async Task<object> LoyaltyOverview() { await me.RequireAsync(); return await BAL.LoyaltyPoints.OverviewAsync(db); }
    [HttpGet("loyalty/{userId:guid}"), RouteGuard("perm:marketing")] public async Task<object> MemberLoyalty(Guid userId) { await me.RequireAsync(); return await bal.LoyaltyAsync(userId); }
    [HttpGet("segments"), RouteGuard("perm:marketing")] public async Task<object> Segments(string? segment) { await me.RequireAsync(); return await BAL.Segments.ListAsync(db, segment); }
    public record CampaignIn { public DateTime? SendAt { get; init; } public int RepeatDays { get; init; } public int RepeatTimes { get; init; } [System.ComponentModel.DataAnnotations.Required] public string Segment { get; init; } = ""; [System.ComponentModel.DataAnnotations.Required, System.ComponentModel.DataAnnotations.StringLength(80)] public string Title { get; init; } = ""; [System.ComponentModel.DataAnnotations.Required, System.ComponentModel.DataAnnotations.StringLength(300)] public string Message { get; init; } = ""; [System.ComponentModel.DataAnnotations.StringLength(200)] public string Link { get; init; } = ""; public bool DryRun { get; init; } = true; }
    [HttpPost("campaigns"), RouteGuard("perm:marketing")] public async Task<object> SendCampaign(CampaignIn b) => await BAL.SegmentCampaigns.SendAsync(db, notify, await me.RequireAsync(), b.Segment, b.Title, b.Message, b.Link, b.DryRun, b.SendAt, b.RepeatDays, b.RepeatTimes);
    [HttpDelete("campaigns/{id:guid}"), RouteGuard("perm:marketing")] public async Task<object> CancelCampaign(Guid id) => await BAL.SegmentCampaigns.CancelAsync(db, await me.RequireAsync(), id) ? new { ok = true } : throw new Utils.AppException("Only a scheduled campaign can be cancelled", "not_scheduled", 400);
    [HttpGet("campaigns"), RouteGuard("perm:marketing")] public async Task<object> CampaignLog() { await me.RequireAsync(); return await BAL.SegmentCampaigns.RecentAsync(db); }
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
public class GiftCardsController(Utils.Interface.IMySqlDapperHelper db, ICurrentUser me, IRateLimitBAL limits, IAuditBAL audit, IPaymentGatewayBAL gateways, IIntegrationBAL integrations, ICatalogNotifyBAL notify) : ControllerBase
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
        await using var tx = await db.BeginAsync(); var after = new List<Func<Task>>(); var r = await BAL.GiftCards.CheckPurchaseAsync(tx, gateways, null, id, after, notify);
        await audit.AuditAsync(admin, "gift_card.purchase_check", "gift_card_purchase", id.ToString(), r["status"]!.GetValue<string>(), tx);
        await tx.CommitAsync(); foreach (var f in after) await f(); r.Remove("code"); return r; // the code goes to the buyer, staff see it in the cards list
    }
    public sealed record GiftRefundIn(string? Reference);
    [HttpPost("/api/admin/growth/gift-card-purchases/{id:guid}/refund"), RouteGuard("perm:marketing")]
    public async Task<object> StaffRefund(Guid id, [FromBody] GiftRefundIn body)
    {
        var admin = await me.RequireAsync();
        await using var tx = await db.BeginAsync();
        var (view, p, changed) = await BAL.GiftCards.RefundPurchaseAsync(tx, id, body.Reference ?? "");
        if (changed) await audit.AuditAsync(admin, "gift_card.purchase_refund", "gift_card_purchase", id.ToString(), $"₹{p.Amount / 100m:N2}", tx);
        await tx.CommitAsync();
        if (changed) await notify.NotifyUserAsync(p.UserId, "gift_card_refunded", new Dictionary<string, string> { ["amount"] = $"₹{p.Amount / 100m:N2}", ["reference"] = (body.Reference ?? "").Trim() }, "/rewards");
        return view;
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
        await using var tx = await db.BeginAsync(); var after = new List<Func<Task>>(); var r = await BAL.GiftCards.CheckPurchaseAsync(tx, gateways, u.Id, id, after, notify); await tx.CommitAsync(); foreach (var f in after) await f(); return r;
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

[ApiController, SignedIn, Route("/api/saved-searches")]
public class SavedSearchesController(Utils.Interface.IMySqlDapperHelper db, ICurrentUser me) : ControllerBase
{
    public record FollowIn { [System.ComponentModel.DataAnnotations.Required, System.ComponentModel.DataAnnotations.StringLength(120, MinimumLength = 1)] public string Query { get; init; } = ""; [System.ComponentModel.DataAnnotations.Range(0, 100000000)] public long? MaxPricePaise { get; init; } }
    [HttpGet, RouteGuard("signed_in")] public async Task<object> Mine() => await BAL.SavedSearches.ListAsync(db, (await me.RequireAsync()).Id);
    [HttpPost, RouteGuard("signed_in")] public async Task<IActionResult> Follow(FollowIn b) => StatusCode(201, await BAL.SavedSearches.AddAsync(db, (await me.RequireAsync()).Id, b.Query, b.MaxPricePaise));
    [HttpDelete("{id:guid}"), RouteGuard("signed_in")] public async Task<object> Unfollow(Guid id) { await BAL.SavedSearches.RemoveAsync(db, (await me.RequireAsync()).Id, id); return new { ok = true }; }
}

[ApiController, SignedIn]
public class CouponBatchController(Utils.Interface.IMySqlDapperHelper db, ICurrentUser me) : ControllerBase
{
    public record BatchIn { public int Count { get; init; } public string Prefix { get; init; } = ""; public bool SingleUse { get; init; } = true; }
    [HttpPost("/api/admin/coupons/{id:guid}/generate"), RouteGuard("perm:marketing")]
    public async Task<IActionResult> Generate(Guid id, BatchIn b) => StatusCode(201, await BAL.CouponBatch.GenerateAsync(db, await me.RequireAsync(), id, b.Count, b.Prefix, b.SingleUse));
}

[ApiController, SignedIn]
public class OrderNotesController(Utils.Interface.IMySqlDapperHelper db, ICurrentUser me) : ControllerBase
{
    public record NoteIn { public string Note { get; init; } = ""; }
    [HttpGet("/api/admin/orders/{id:guid}/notes"), RouteGuard("perm:orders")] public async Task<object> List(Guid id) { await me.RequireAsync(); return await BAL.OrderNotes.ListAsync(db, id); }
    [HttpPost("/api/admin/orders/{id:guid}/notes"), RouteGuard("perm:orders")] public async Task<IActionResult> Add(Guid id, NoteIn b) => StatusCode(201, await BAL.OrderNotes.AddAsync(db, await me.RequireAsync(), id, b.Note));
}

/// <summary>The footer newsletter box: its heading, and joining the list.</summary>
[ApiController, Route("/api/newsletter")]
public class NewsletterController(IMySqlDapperHelper db, IRateLimitBAL rateLimit, Utils.AppSettings settings) : ControllerBase
{
    public record JoinIn { [System.ComponentModel.DataAnnotations.MaxLength(254)] public string Email { get; init; } = ""; }
    [HttpGet(""), RouteGuard("public")] public async Task<object> Box() => await BAL.Newsletter.BoxAsync(db);
    [HttpPost(""), RouteGuard("public")]
    public async Task<IActionResult> Join(JoinIn body)
    {
        if (!(await BAL.Newsletter.ConfigAsync(db)).Bool("enabled")) throw new Utils.AppException("The newsletter is not open", "newsletter_off");
        await rateLimit.RateLimitAsync($"newsletter:ip:{API.Helpers.ClientIpHelper.Get(HttpContext, settings)}", 10, 3600);
        await BAL.Newsletter.JoinAsync(db, body.Email);
        return StatusCode(201, new { ok = true });
    }
}

/// <summary>The storefront's one-time welcome popup.</summary>
[ApiController, Route("/api/promo-popup")]
public class PromoPopupController(IMySqlDapperHelper db) : ControllerBase
{
    [HttpGet(""), RouteGuard("public")] public async Task<object> Box() => await BAL.PromoPopup.BoxAsync(db);
}
