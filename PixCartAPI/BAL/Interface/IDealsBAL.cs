namespace BAL.Interface;

/// <summary>Running deals; port of the reference services/deals.py, growing as modules need more of it.</summary>
public interface IDealsBAL
{
    /// <summary>Units still offered at the deal price, for versions with a running lightning deal (one with a quantity).</summary>
    Task<Dictionary<Guid, int>> UnitsLeftAsync(IEnumerable<Guid> variantIds);
}
