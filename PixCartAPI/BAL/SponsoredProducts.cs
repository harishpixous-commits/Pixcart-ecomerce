using BAL.Interface;
using Microsoft.Extensions.DependencyInjection;

namespace BAL;

/// <summary>
/// Plugs the advertising module into the storefront search (<see cref="ISponsoredProducts"/>): the products of running
/// campaigns that match the search, each with its signed click link, recorded as impressions. The ads service itself
/// reads the catalogue, so it is resolved when an ad is served rather than when the catalogue is built (no cycle).
/// </summary>
public sealed class SponsoredProducts(IServiceProvider services) : ISponsoredProducts
{
    public async Task<IReadOnlyList<(Guid ProductId, string Token)>> ServeAsync(string placement, string visitor, string ip, string query, int limit)
    {
        var served = await services.GetRequiredService<IAdsBAL>().ServeAsync(placement, query, productSlug: null, limit, visitor, ip);
        return served.Select(ad => (ad.Product.Id, ad.Token)).ToList();
    }
}
