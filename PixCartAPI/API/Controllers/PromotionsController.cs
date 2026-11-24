using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>
/// The deals page, top lists and the coupons page (reference: routers/promotions.py — same paths, query params and
/// payload). Public routes.
/// </summary>
[ApiController]
public class PromotionsController(IPromotionsBAL promotions) : ControllerBase
{
    [HttpGet("/api/catalog/deals")]
    public async Task<JsonObject> Deals(
        [FromQuery, RegularExpression("^(live|upcoming|discounts)$", ErrorMessage = "tab must be live, upcoming or discounts")] string tab = "live",
        [FromQuery, RegularExpression("^(lightning|deal_of_day|limited)$", ErrorMessage = "kind must be lightning, deal_of_day or limited")] string? kind = null,
        [FromQuery, StringLength(90)] string? category = null,
        [FromQuery, Range(0, 95)] int? min_discount = null,
        [FromQuery, Range(0.0, 5.0)] double? min_rating = null,
        [FromQuery, Range(0, int.MaxValue)] int? min_price = null,
        [FromQuery, Range(0, int.MaxValue)] int? max_price = null,
        [FromQuery, RegularExpression("^(featured|ending|discount|price_asc|price_desc|rating)$", ErrorMessage = "sort must be featured, ending, discount, price_asc, price_desc or rating")] string sort = "featured",
        [FromQuery, Range(1, 200)] int page = 1) =>
        await promotions.DealsPageAsync(tab, kind, category, min_discount, min_rating, min_price, max_price, sort, page);

    /// <summary>Bestsellers (units sold in the last 30 days) or Hot New Releases.</summary>
    [HttpGet("/api/catalog/top")]
    public async Task<JsonObject> Top(
        [FromQuery(Name = "list"), RegularExpression("^(bestsellers|new)$", ErrorMessage = "list must be bestsellers or new")] string list = "bestsellers",
        [FromQuery, StringLength(90)] string? category = null) =>
        await promotions.TopListsAsync(list, category);

    [HttpGet("/api/catalog/coupons")]
    public async Task<JsonObject> Coupons() => await promotions.CouponsPageAsync();
}
