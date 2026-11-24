using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Public storefront configuration: site settings (brand, theme, menus), the home page sections with their products, CMS pages.</summary>
[ApiController]
public class StorefrontController(IStorefrontBAL storefront) : ControllerBase
{
    [HttpGet("/api/site")]
    public Task<JsonObject> Site() => storefront.SiteAsync();

    [HttpGet("/api/home")]
    public Task<JsonObject> Home() => storefront.HomeAsync();

    [HttpGet("/api/pages/{slug}")]
    public Task<JsonObject> Page(string slug) => storefront.PageAsync(slug);
}
