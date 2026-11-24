using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Seller sponsored products (reference: routers/promotions.py seller ads routes).</summary>
[ApiController]
[Route("/api/seller/ads")]
[SignedIn]
public class SellerAdsController(IAdsBAL ads, ICurrentUser current) : ControllerBase
{
    [HttpGet("")]
    public async Task<JsonObject> List() => await ads.SellerListAsync(await Seller(false));

    [HttpGet("products")]
    public async Task<List<JsonObject>> Products() => await ads.SellerProductsAsync(await Seller(false));

    /// <summary>Reference: CampaignIn body validation.</summary>
    [HttpPost("")]
    public async Task<IActionResult> Create([FromBody] CampaignRequest body)
    {
        var seller = await Seller(true);
        var outp = await ads.SellerUpsertAsync(seller, await current.RequireAsync(), body.ToBody(), null);
        return StatusCode(201, outp);
    }

    [HttpPut("{campaignId:guid}")]
    public async Task<JsonObject> Update(Guid campaignId, [FromBody] CampaignRequest body) =>
        await ads.SellerUpsertAsync(await Seller(true), await current.RequireAsync(), body.ToBody(), campaignId);

    [HttpPost("{campaignId:guid}/{campaignAction}")]
    public async Task<JsonObject> Action(Guid campaignId,
        [RegularExpression("^(pause|resume|end)$", ErrorMessage = "campaignAction must be pause, resume or end")] string campaignAction) =>
        await ads.SellerActionAsync(await Seller(false), await current.RequireAsync(), campaignId, campaignAction);

    [HttpGet("{campaignId:guid}/report")]
    public async Task<JsonObject> Report(Guid campaignId, [FromQuery, Range(1, 90)] int days = 30) =>
        await ads.SellerReportAsync(await Seller(false), campaignId, days);

    private async Task<Model.DomainModel.SellerModel> Seller(bool approved) => await current.RequireSellerAsync(approved);

    /// <summary>Reference: CampaignIn (model validators in ToBody).</summary>
    public class CampaignRequest
    {
        [Required, MinLength(3), MaxLength(80)]
        public string Name { get; set; } = "";
        [Required, MinLength(1), MaxLength(50)]
        public List<Guid> ProductIds { get; set; } = [];
        [Required, MinLength(1), MaxLength(3)]
        public List<string> Placements { get; set; } = [];
        [MaxLength(30)]
        public List<string> Keywords { get; set; } = [];
        [Range(1, 10_000_000)]
        public long BidPaise { get; set; }
        [Range(1, 100_000_000)]
        public long DailyBudgetPaise { get; set; }
        [Range(1, 10_000_000_000)]
        public long? TotalBudgetPaise { get; set; }
        public DateTime? StartsAt { get; set; }
        public DateTime? EndsAt { get; set; }

        public CampaignBody ToBody()
        {
            foreach (var p in Placements)
                if (p is not ("search" or "product" or "home"))
                    throw new Utils.AppException("Placements: each placement must be search, product or home", "validation_error", 422);
            if (DailyBudgetPaise < BidPaise)
                throw new Utils.AppException("The daily budget must cover at least one click", "validation_error", 422);
            if (TotalBudgetPaise is not null && TotalBudgetPaise < DailyBudgetPaise)
                throw new Utils.AppException("The total budget cannot be less than the daily budget", "validation_error", 422);
            if (StartsAt is not null && EndsAt is not null && EndsAt <= StartsAt)
                throw new Utils.AppException("The campaign must end after it starts", "validation_error", 422);
            return new CampaignBody
            {
                Name = Name, ProductIds = ProductIds, Placements = Placements, Keywords = Keywords,
                BidPaise = BidPaise, DailyBudgetPaise = DailyBudgetPaise, TotalBudgetPaise = TotalBudgetPaise,
                StartsAt = StartsAt?.ToUniversalTime(), EndsAt = EndsAt?.ToUniversalTime(),
            };
        }
    }
}
