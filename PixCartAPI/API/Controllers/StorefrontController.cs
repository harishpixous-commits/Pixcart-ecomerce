using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>Public storefront catalogue (reference: routers/catalog.py).</summary>
[ApiController]
[Route("api/catalog")]
public class StorefrontController(ICatalogBAL catalog, ICurrentUser current, AppSettings app) : ControllerBase
{
    private const string VisitorCookie = "pc_vid"; // reference: services/ads.py VISITOR_COOKIE
    private static readonly Regex VisitorId = new("^[A-Za-z0-9_-]{22}$", RegexOptions.Compiled);

    /// <summary>Reference: ads.visitor_id.</summary>
    private string Visitor()
    {
        var vid = Request.Cookies[VisitorCookie] ?? "";
        return VisitorId.IsMatch(vid) ? vid : Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    /// <summary>Reference: ads.keep_visitor.</summary>
    private void KeepVisitor(string vid) =>
        Response.Cookies.Append(VisitorCookie, vid, new CookieOptions
        {
            MaxAge = TimeSpan.FromDays(30), HttpOnly = true, Secure = app.CookieSecure,
            SameSite = SameSiteMode.Lax, Path = "/api",
        });

    /// <summary>Reference: GET /api/catalog/categories.</summary>
    [HttpGet("categories")]
    public async Task<JsonArray> Categories() => await catalog.CategoryTreeAsync();

    /// <summary>Reference: GET /api/catalog/home.</summary>
    [HttpGet("home")]
    public async Task<JsonObject> Home() => await catalog.HomeRailsAsync();

    /// <summary>Reference: GET /api/catalog/products (search with facets and sponsored listings).</summary>
    [HttpGet("products")]
    public async Task<JsonObject> Products(
        [FromQuery, MaxLength(100)] string q = "",
        [FromQuery, MaxLength(90)] string? category = null,
        [FromQuery] List<string>? brand = null,
        [FromQuery, MaxLength(90)] string? seller = null,
        [FromQuery, Range(0, long.MaxValue)] long? min_price = null,
        [FromQuery, Range(0, long.MaxValue)] long? max_price = null,
        [FromQuery, Range(0, 5)] double? min_rating = null,
        [FromQuery, Range(0, 100)] int? min_discount = null,
        [FromQuery] bool in_stock = false,
        [FromQuery, RegularExpression("^(relevance|price_asc|price_desc|newest|rating|discount|popular)$")] string sort = "relevance",
        [FromQuery, Range(1, 500)] int page = 1,
        [FromQuery, Range(1, 60)] int? page_size = null,
        [FromQuery, RegularExpression("^[1-9][0-9]{5}$")] string? pincode = null,
        [FromQuery, Range(1, 7)] int? delivery = null,
        [FromQuery] bool deal = false)
    {
        var vid = Visitor();
        var (result, servedAds) = await catalog.SearchAsync(
            new ProductSearch(q, category, brand, seller, min_price, max_price, min_rating, min_discount, in_stock,
                sort, page, page_size, pincode, delivery, deal),
            vid, current.IpAddress);
        if (servedAds)
            KeepVisitor(vid);
        return result;
    }

    /// <summary>Reference: GET /api/catalog/suggest.</summary>
    [HttpGet("suggest")]
    public async Task<JsonObject> Suggest([FromQuery, Required, MinLength(1), MaxLength(60)] string q) =>
        await catalog.SuggestAsync(q);

    /// <summary>Reference: GET /api/catalog/products/{slug}.</summary>
    [HttpGet("products/{slug}")]
    public async Task<JsonObject> ProductPage(string slug) => await catalog.ProductPageAsync(slug);

    /// <summary>Reference: GET /api/catalog/stores/{slug}.</summary>
    [HttpGet("stores/{slug}")]
    public async Task<JsonObject> Store(string slug) => await catalog.StoreAsync(slug);

    /// <summary>Reference: GET /api/catalog/platform.</summary>
    [HttpGet("platform")]
    public async Task<JsonObject> Platform() => await catalog.PlatformAsync();
}
