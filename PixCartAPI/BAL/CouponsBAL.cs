using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Coupon validation and allocation (reference: services/coupons.py — same checks in the same order, same codes and
/// messages). Platform-funded coupons lower what the customer pays; the seller is paid on the full price and the
/// platform absorbs the difference. Seller-funded coupons lower the seller's own sale value, so GST, commission and
/// TCS are worked out on the discounted price.
/// </summary>
public class CouponsBAL(CouponDAL coupons, CatalogDAL catalogDal, ICatalogBAL catalog) : ICouponsBAL
{
    /// <summary>A validated coupon: the discount and its per-cart-line split (variant id -> paise).</summary>
    public sealed record Result(CouponModel Coupon, long Discount, Dictionary<Guid, long> PerLine);

    /// <summary>Checks a coupon against the cart lines. Throws AppException with the reference's reason.</summary>
    public async Task<Result> EvaluateAsync(string code, Guid userId, IReadOnlyList<CartBAL.CartLine> lines)
    {
        var c = await coupons.ByCodeAsync(code.Trim().ToUpperInvariant());
        var now = DateTime.UtcNow;
        if (c is null || !c.IsActive) throw new AppException("This coupon code is not valid", "coupon_invalid");
        if (c.StartsAt is { } s && DateTime.SpecifyKind(s, DateTimeKind.Utc) > now) throw new AppException("This coupon is not active yet", "coupon_not_started");
        if (c.EndsAt is { } e && DateTime.SpecifyKind(e, DateTimeKind.Utc) < now) throw new AppException("This coupon has expired", "coupon_expired");
        if (c.UsageLimit is { } limit && c.UsedCount >= limit) throw new AppException("This coupon has been fully used", "coupon_exhausted");
        if (await coupons.RedemptionsAsync(c.Id, userId) >= c.PerUserLimit) throw new AppException("You have already used this coupon", "coupon_used");
        if (c.FirstOrderOnly && await coupons.PlacedOrdersAsync(userId) > 0)
            throw new AppException("This coupon is for your first order only", "coupon_first_order");

        HashSet<Guid>? allowedCategories = null;
        if (c.CategoryId is { } catId)
        {
            var cat = await catalogDal.GetCategoryAsync(catId);
            allowedCategories = cat is not null ? (await catalog.CategoryDescendantIdsAsync(cat.Id)).ToHashSet() : [];
        }
        var eligible = lines
            .Where(l => l.Problem == "" && (c.SellerId is null || l.Seller.Id == c.SellerId)
                        && (allowedCategories is null || allowedCategories.Contains(l.Product.CategoryId)))
            .ToDictionary(l => l.Variant.Id, l => l.LineTotal);
        var baseSum = eligible.Values.Sum();
        if (baseSum == 0) throw new AppException("This coupon does not apply to the items in your cart", "coupon_not_applicable");
        if (baseSum < c.MinOrderPaise)
            throw new AppException($"Add items worth ₹{(c.MinOrderPaise - baseSum) / 100m:#,0} more to use this coupon", "coupon_min_order");
        var discount = c.Kind == "percent" ? Money.ApplyBps(baseSum, c.Value) : c.Value;
        if (c.MaxDiscountPaise is { } max) discount = Math.Min(discount, max);
        discount = Math.Min(discount, baseSum);
        return new Result(c, discount, Money.Allocate(discount, eligible));
    }

    /// <summary>The coupons shown at checkout.</summary>
    public async Task<List<JsonObject>> ListForCheckoutAsync()
    {
        var rows = await coupons.ForCheckoutAsync();
        return rows.Where(c => c.UsageLimit is null || c.UsedCount < c.UsageLimit).Select(Public).ToList();
    }

    public static JsonObject Public(CouponModel c) => new()
    {
        ["code"] = c.Code,
        ["description"] = c.Description,
        ["kind"] = c.Kind,
        ["value"] = c.Value,
        ["max_discount_paise"] = c.MaxDiscountPaise,
        ["min_order_paise"] = c.MinOrderPaise,
        ["ends_at"] = c.EndsAt is { } e ? new DateTimeOffset(DateTime.SpecifyKind(e, DateTimeKind.Utc)).ToString("yyyy-MM-ddTHH:mm:ss.ffffffzzz") : null,
    };
}
