using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Seller deals (reference: routers/promotions.py seller deals routes).</summary>
[ApiController]
[Route("/api/seller/deals")]
[SignedIn]
public class SellerDealsController(IDealsBAL deals, ICurrentUser current) : ControllerBase
{
    [HttpGet("")]
    public async Task<JsonObject> List([FromQuery, StringLength(10)] string? status = null) =>
        await deals.SellerListAsync(await current.RequireSellerAsync(approved: false), status);

    [HttpGet("options")]
    public async Task<JsonObject> Options([FromQuery, StringLength(80)] string q = "") =>
        await deals.SellerOptionsAsync(await current.RequireSellerAsync(approved: false), q);

    [HttpPost("")]
    [Consumes("application/json")]
    public async Task<IActionResult> Create([FromBody] DealIn body)
    {
        var id = await deals.CreateAsync(await current.RequireSellerAsync(), await current.RequireAsync(),
            body.VariantId, body.Kind, body.DealPricePaise, Aware(body.StartsAt), Aware(body.EndsAt), body.QtyLimit);
        var seller = await current.RequireSellerAsync();
        var list = await deals.SellerListAsync(seller, null);
        var item = list["items"]!.AsArray().First(i => i!["id"]!.GetValue<string>() == id.ToString())!.DeepClone();
        return StatusCode(201, item);
    }

    [HttpPost("{dealId}/cancel")]
    public async Task<JsonObject> Cancel(Guid dealId)
    {
        await deals.SellerCancelAsync(await current.RequireSellerAsync(approved: false), await current.RequireAsync(), dealId);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: _aware — a time without a zone is India time; stored as UTC.</summary>
    private static DateTime Aware(DateTime v) =>
        v.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(v.AddHours(-5).AddMinutes(-30), DateTimeKind.Utc)
            : v.ToUniversalTime();

    /// <summary>Reference: DealIn.</summary>
    public class DealIn
    {
        [Required]
        public Guid VariantId { get; set; }
        [Required, RegularExpression("^(lightning|deal_of_day|limited)$", ErrorMessage = "Kind must be lightning, deal_of_day or limited")]
        public string Kind { get; set; } = "";
        [Range(1, 100_000_000)]
        public long DealPricePaise { get; set; }
        [Required]
        public DateTime StartsAt { get; set; }
        [Required]
        public DateTime EndsAt { get; set; }
        [Range(1, 100_000)]
        public int? QtyLimit { get; set; }
    }
}
