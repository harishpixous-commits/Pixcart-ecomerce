using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Public storefront configuration (reference: routers/storefront.py).</summary>
[ApiController]
[Route("api")]
public class StorefrontConfigController(BAL.StorefrontConfigBAL bal) : ControllerBase
{
    /// <summary>Reference: GET /api/site.</summary>
    [HttpGet("site")]
    public async Task<JsonResult> Site() => new(await bal.SiteConfigAsync());

    /// <summary>Reference: GET /api/home.</summary>
    [HttpGet("home")]
    public async Task<JsonResult> Home() => new(await bal.HomeAsync());

    /// <summary>Reference: GET /api/pages/{slug}.</summary>
    [HttpGet("pages/{slug}")]
    public async Task<JsonResult> Page(string slug) => new(await bal.PageAsync(slug));
}
