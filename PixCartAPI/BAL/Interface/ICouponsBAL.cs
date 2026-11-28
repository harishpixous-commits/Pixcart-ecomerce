using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Coupon validation and allocation (reference: services/coupons.py).</summary>
public interface ICouponsBAL
{
    /// <summary>Checks a coupon against the cart lines. Throws AppException with the reference's reason.</summary>
    Task<CouponsBAL.Result> EvaluateAsync(string code, Guid userId, IReadOnlyList<CartBAL.CartLine> lines);

    /// <summary>The automatic coupon that saves the most on this cart, or null (Growth, Automatic discounts must be on).</summary>
    Task<CouponsBAL.Result?> BestAutomaticAsync(Guid userId, IReadOnlyList<CartBAL.CartLine> lines);

    /// <summary>The coupons shown at checkout.</summary>
    Task<List<JsonObject>> ListForCheckoutAsync();
}
