using DAL;
using Model.DomainModel;

namespace BAL;

/// <summary>Running deals. Port of the reference services/deals.py, starting with what the cart needs.</summary>
public class DealsBAL(CatalogSupportDAL support) : Interface.IDealsBAL
{
    /// <summary>Units still offered at the deal price, for versions with a running lightning deal (one with a quantity).</summary>
    public async Task<Dictionary<Guid, int>> UnitsLeftAsync(IEnumerable<Guid> variantIds)
    {
        var ids = variantIds.Distinct().ToList();
        if (ids.Count == 0) return [];
        var rows = await support.DealQuantitiesAsync(ids);
        return rows.Where(r => r.QtyLimit is not null).ToDictionary(r => r.VariantId, r => Math.Max(0, r.QtyLimit!.Value - r.SoldQty));
    }
}
