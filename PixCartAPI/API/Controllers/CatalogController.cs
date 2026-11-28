using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using API.Helpers;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Catalog;
using Utils;

namespace API.Controllers;

/// <summary>Public storefront catalogue: categories, home rails, search with facets, suggestions, product pages, stores, delivery estimates.</summary>
[ApiController]
public partial class CatalogController(ICatalogBAL catalog, AppSettings settings, ICurrentUser me) : ControllerBase
{
    /// <summary>First-party visitor id for sponsored products: random, HttpOnly, sent only to /api.</summary>
    public const string VisitorCookie = "pc_vid";

    [GeneratedRegex("^[A-Za-z0-9_-]{22}$")]
    private static partial Regex VisitorRx();

    private string VisitorId()
    {
        var vid = Request.Cookies[VisitorCookie] ?? "";
        return VisitorRx().IsMatch(vid) ? vid : EncryptDecrypt.ToBase64Url(RandomNumberGenerator.GetBytes(16));
    }

    [HttpGet("/api/catalog/categories")]
    public Task<JsonArray> Categories() => catalog.CategoryTreeAsync();

    [HttpGet("/api/catalog/home")]
    public Task<JsonObject> Home() => catalog.HomeRailsAsync();

    [HttpGet("/api/catalog/products")]
    public async Task<JsonObject> Search(
        [FromQuery, Len(0, 100)] string q = "",
        [FromQuery, Len(0, 90)] string? category = null,
        [FromQuery] List<string>? brand = null,
        [FromQuery, Len(0, 90)] string? seller = null,
        [FromQuery(Name = "min_price"), Between(0, long.MaxValue)] long? minPrice = null,
        [FromQuery(Name = "max_price"), Between(0, long.MaxValue)] long? maxPrice = null,
        [FromQuery(Name = "min_rating"), Between(0, 5)] double? minRating = null,
        [FromQuery(Name = "min_discount"), Between(0, 100)] int? minDiscount = null,
        [FromQuery(Name = "in_stock")] bool inStock = false,
        [FromQuery, OneOf("relevance", "price_asc", "price_desc", "newest", "rating", "discount", "popular")] string sort = "relevance",
        [FromQuery, Between(1, 500)] int page = 1,
        [FromQuery(Name = "page_size"), Between(1, 60)] int? pageSize = null,
        [FromQuery, Pattern("^[1-9][0-9]{5}$", "use the 6-digit PIN code")] string? pincode = null,
        [FromQuery, Between(1, 7)] int? delivery = null,
        [FromQuery] bool deal = false,
        [FromQuery, Len(0, 30)] string? tag = null)
    {
        // q, category and seller exactly as sent (model binding turns empty and blank values into null): an empty
        // category or seller means none, a blank one is looked up and found nowhere
        string? Sent(string name) => Request.Query.TryGetValue(name, out var v) && v.Count > 0 ? v[^1] : null;
        var vid = VisitorId();
        var (result, served) = await catalog.SearchAsync(
            new ProductSearch(Sent("q") ?? "", Sent("category"), brand, Sent("seller"), minPrice, maxPrice, minRating, minDiscount,
                inStock, sort, page, pageSize, pincode, delivery, deal, tag),
            vid, ClientIpHelper.Get(HttpContext, settings));
        if (served)
            Response.Cookies.Append(VisitorCookie, vid, new CookieOptions
            {
                MaxAge = TimeSpan.FromDays(30), HttpOnly = true, Secure = settings.CookieSecure, SameSite = SameSiteMode.Lax, Path = "/api",
            });
        return result;
    }

    [HttpGet("/api/catalog/suggest")]
    public Task<JsonObject> Suggest([FromQuery, Len(1, 60)] string? q) => catalog.SuggestAsync(q ?? ""); // presence is checked by the query rules

    [HttpGet("/api/catalog/products/{slug}")]
    public Task<JsonObject> Product(string slug) => catalog.ProductPageAsync(slug);

    [HttpGet("/api/catalog/stores/{slug}")]
    public Task<JsonObject> Store(string slug) => catalog.StoreAsync(slug);

    /// <summary>Operator details the Consumer Protection (E-Commerce) Rules 2020 require on the platform.</summary>
    [HttpGet("/api/catalog/platform")]
    public Task<JsonObject> Platform() => catalog.PlatformAsync();

    [HttpGet("/api/catalog/delivery-estimate")]
    public async Task<JsonObject> DeliveryEstimate(
        [FromQuery(Name = "variant_id"), Required(ErrorMessage = "is required")] Guid? variantId,
        [FromQuery, Required(ErrorMessage = "is required"), Len(6, 6)] string pincode) =>
        await catalog.DeliveryEstimateAsync(variantId!.Value, pincode, (await me.GetAsync())?.Id);
}
