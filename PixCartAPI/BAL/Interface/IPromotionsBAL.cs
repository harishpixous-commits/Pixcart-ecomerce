using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>The deals page, top lists and the coupons page (reference: routers/promotions.py shopper routes).</summary>
public interface IPromotionsBAL
{
    Task<JsonObject> DealsPageAsync(string tab, string? kind, string? category, int? minDiscount, double? minRating,
        int? minPrice, int? maxPrice, string sort, int page);
    Task<JsonObject> TopListsAsync(string list, string? category);
    Task<JsonObject> CouponsPageAsync();

    /// <summary>Reference: related_products — popular products from the categories of the ones the shopper viewed.</summary>
    Task<JsonObject> RelatedAsync(IReadOnlyList<Guid> ids, int limit);

    /// <summary>Reference: buy_again — products from the shopper's delivered orders that are still on sale.</summary>
    Task<JsonObject> BuyAgainAsync(Guid userId, int limit);
}
