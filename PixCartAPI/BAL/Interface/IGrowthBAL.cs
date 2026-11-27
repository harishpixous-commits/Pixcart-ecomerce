using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;

/// <summary>Admin → Growth: settings for loyalty, referral, abandoned carts, flash sales, gift cards, seller scorecard,
/// COD risk, SEO, bulk edit and segments (<c>platform_settings['growth']</c>, all modules off by default) and the seller scorecard.
/// Mirror of the Python <c>services/growth.py</c>.</summary>
public interface IGrowthBAL
{
    Task<JsonObject> GetAsync();
    Task<JsonObject> SettingsAsync(UserModel admin);
    Task<JsonObject> UpdateAsync(UserModel admin, JsonObject body);
    Task<JsonObject> ScorecardAsync(UserModel admin);
    Task<JsonObject> LoyaltyAsync(Guid userId);
    /// <summary>The seller's own scorecard against the levels staff set (GET /api/seller/scorecard).</summary>
    Task<JsonObject> MyScorecardAsync(Guid sellerId);
    /// <summary>The sitemap XML, or null when staff switched it off (Admin → Growth → Search engines).</summary>
    Task<string?> SitemapAsync();
    string RobotsTxt();
    Task<JsonObject> AdjustPointsAsync(UserModel admin, Guid userId, int points, string note);
}
