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
}
