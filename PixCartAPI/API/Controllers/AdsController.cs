using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using API.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>Shopper sponsored products (reference: routers/promotions.py ads routes).</summary>
[ApiController]
[Route("api/ads")]
public partial class AdsController(IAdsBAL ads, ICatalogBAL catalog, ICurrentUser current, AppSettings app) : ControllerBase
{
    private const string VisitorCookie = "pc_vid"; // reference: services/ads.py VISITOR_COOKIE

    [GeneratedRegex("^[A-Za-z0-9_-]{22}$")]
    private static partial Regex VisitorId();

    /// <summary>Reference: ads.visitor_id.</summary>
    private string Visitor()
    {
        var vid = Request.Cookies[VisitorCookie] ?? "";
        return VisitorId().IsMatch(vid) ? vid : Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    /// <summary>Reference: ads.keep_visitor.</summary>
    private void KeepVisitor(string vid) =>
        Response.Cookies.Append(VisitorCookie, vid, new CookieOptions
        {
            MaxAge = TimeSpan.FromDays(30), HttpOnly = true, Secure = app.CookieSecure,
            SameSite = SameSiteMode.Lax, Path = "/api",
        });

    /// <summary>Reference: GET /api/ads/serve.</summary>
    [HttpGet("serve")]
    public async Task<JsonObject> Serve([RegularExpression("^(search|product|home)$")] string placement,
        [MaxLength(100)] string q = "", [MaxLength(230)] string? product = null, [Range(1, 20)] int? limit = null)
    {
        var vid = Visitor();
        var served = await ads.ServeAsync(placement, q, product, limit, vid, current.IpAddress);
        if (served.Count > 0) KeepVisitor(vid);
        var cards = await catalog.ProductCardsAsync(served.Select(s => s.Product).ToList(),
            served.ToDictionary(s => s.Product.Id, s => s.Token));
        return new JsonObject { ["items"] = new JsonArray(cards.Select(c => c.DeepClone()).ToArray<JsonNode>()) };
    }

    /// <summary>Reference: GET /api/ads/click — opens the product behind a sponsored link.</summary>
    [HttpGet("click")]
    public async Task<IActionResult> Click([MaxLength(400)] string t)
    {
        var vid = Request.Cookies[VisitorCookie];
        var (p, clickId) = await ads.ClickAsync(t, vid, current.IpAddress);
        if (p is null) return Redirect("/");
        return Redirect($"/p/{p.Slug}" + (clickId is not null ? $"?sp={clickId}" : ""));
    }

    /// <summary>Reference: POST /api/ads/clicks/{click_id}/claim.</summary>
    [SignedIn]
    [HttpPost("clicks/{clickId:guid}/claim")]
    public async Task<JsonObject> Claim(Guid clickId)
    {
        await ads.ClaimAsync(clickId, (await current.RequireAsync()).Id);
        return new JsonObject { ["ok"] = true };
    }
}
