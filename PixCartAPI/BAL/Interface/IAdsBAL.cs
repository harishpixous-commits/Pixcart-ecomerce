using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Shopper sponsored products (reference: services/ads.py + routers/promotions.py ads routes).</summary>
public interface IAdsBAL
{
    /// <summary>Ads to show on a placement, each with its signed click token. Empty when ads are off or the address is flooding.</summary>
    Task<List<(ProductModel Product, string Token)>> ServeAsync(string placement, string query, string? productSlug, int? limit, string visitor, string ip);

    /// <summary>A sponsored link was followed. Returns the product to open and the click id when it counted as a genuine click.</summary>
    Task<(ProductModel? Product, Guid? ClickId)> ClickAsync(string token, string? visitor, string ip);

    /// <summary>Link a recent unclaimed click to the signed-in shopper so a later order counts as an ad sale.</summary>
    Task ClaimAsync(Guid clickId, Guid userId);

    // ------------------------------------------------------------------ seller

    /// <summary>Reference: seller_ads — campaigns with stats, rules, 30-day totals and recent billing.</summary>
    Task<JsonObject> SellerListAsync(SellerModel seller);

    /// <summary>Reference: seller_ads_products — the seller's approved products for the picker.</summary>
    Task<List<JsonObject>> SellerProductsAsync(SellerModel seller);

    /// <summary>Reference: seller_create_campaign (201) and seller_update_campaign.</summary>
    Task<JsonObject> SellerUpsertAsync(SellerModel seller, UserModel user, CampaignBody body, Guid? campaignId);

    /// <summary>Reference: seller_campaign_action — pause, resume or end.</summary>
    Task<JsonObject> SellerActionAsync(SellerModel seller, UserModel user, Guid campaignId, string action);

    /// <summary>Reference: seller_campaign_report — per-day and per-product counters.</summary>
    Task<JsonObject> SellerReportAsync(SellerModel seller, Guid campaignId, int days);
}

/// <summary>Reference: CampaignIn.</summary>
public class CampaignBody
{
    public string Name { get; set; } = "";
    public List<Guid> ProductIds { get; set; } = [];
    public List<string> Placements { get; set; } = [];
    public List<string> Keywords { get; set; } = [];
    public long BidPaise { get; set; }
    public long DailyBudgetPaise { get; set; }
    public long? TotalBudgetPaise { get; set; }
    public DateTime? StartsAt { get; set; }
    public DateTime? EndsAt { get; set; }
}
