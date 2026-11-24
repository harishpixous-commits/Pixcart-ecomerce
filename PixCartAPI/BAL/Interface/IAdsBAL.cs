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
}
