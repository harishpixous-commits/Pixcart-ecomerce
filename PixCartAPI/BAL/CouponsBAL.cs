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
    /// <summary>Whole rupees for the "add items worth" message: an exact half rounds to even, digits grouped in thousands.</summary>
    public static string ShortfallRupees(long paise) =>
        Math.Round(paise / 100m, 0, MidpointRounding.ToEven).ToString("#,0", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>A validated coupon: the discount and its per-cart-line split (variant id -> paise).</summary>
    public sealed record Result(CouponModel Coupon, long Discount, Dictionary<Guid, long> PerLine, bool FreeShipping = false);

    /// <summary>Checks a coupon against the cart lines. Throws AppException with the reference's reason.</summary>
    public async Task<Result> EvaluateAsync(string code, Guid userId, IReadOnlyList<CartBAL.CartLine> lines)
    {
        var c = await coupons.ByCodeAsync(code.Trim().ToUpperInvariant());
        var now = DateTime.UtcNow;
        if (c is null || !c.IsActive) throw new AppException("This coupon code is not valid", "coupon_invalid");
        if (c.OnlyUserId is { } only && only != userId) throw new AppException("This coupon code is not valid", "coupon_invalid"); // made for someone else: same answer as an unknown code
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
        var productIds = JsonHelper.Array(c.ProductIds).Select(x => x!.GetValue<string>()).ToHashSet();
        var eligible = lines
            .Where(l => l.Problem == "" && (c.SellerId is null || l.Seller.Id == c.SellerId)
                        && (allowedCategories is null || allowedCategories.Contains(l.Product.CategoryId))
                        && (productIds.Count == 0 || productIds.Contains(l.Product.Id.ToString())))
            .ToDictionary(l => l.Variant.Id, l => l.LineTotal);
        var baseSum = eligible.Values.Sum();
        if (c.Kind == "bxgy") // buy X get Y: the cheapest Y of every X+Y units get Value percent off
        {
            var units = lines.Where(l => eligible.ContainsKey(l.Variant.Id)).SelectMany(l => Enumerable.Repeat(l.LineTotal / l.Item.Qty, l.Item.Qty))
                .OrderByDescending(x => x).ToList();
            var group = c.BuyQty + c.GetQty;
            var free = group > 0 ? units.Count / group * c.GetQty : 0;
            if (free == 0)
                throw new AppException(group > units.Count ? $"Add {group - units.Count} more item(s) to get this offer" : "This coupon does not apply to the items in your cart", "coupon_not_applicable");
            var off = Money.ApplyBps(units.Skip(units.Count - free).Sum(), c.Value * 100);
            if (c.MaxDiscountPaise is { } cap) off = Math.Min(off, cap);
            off = Math.Min(off, baseSum);
            return new Result(c, off, Money.Allocate(off, eligible));
        }
        if (c.Kind == "volume") // at least BuyQty eligible units: Value percent off all of them
        {
            var unitsN = lines.Where(l => eligible.ContainsKey(l.Variant.Id)).Sum(l => l.Item.Qty);
            if (unitsN < c.BuyQty)
                throw new AppException(unitsN > 0 ? $"Add {c.BuyQty - unitsN} more item(s) to get this offer" : "This coupon does not apply to the items in your cart", "coupon_not_applicable");
            var off = Money.ApplyBps(baseSum, c.Value * 100);
            if (c.MaxDiscountPaise is { } cap) off = Math.Min(off, cap);
            off = Math.Min(off, baseSum);
            return new Result(c, off, Money.Allocate(off, eligible));
        }
        if (c.Kind == "bundle") // every product of the set in the cart: Value percent off one of each, per complete set
        {
            var byProduct = lines.Where(l => eligible.ContainsKey(l.Variant.Id)).GroupBy(l => l.Product.Id.ToString())
                .ToDictionary(g => g.Key, g => g.SelectMany(l => Enumerable.Repeat(l.LineTotal / l.Item.Qty, l.Item.Qty)).OrderBy(x => x).ToList());
            if (productIds.Count == 0 || productIds.Any(p => !byProduct.ContainsKey(p)))
                throw new AppException("Add every item of this bundle to your cart to get the offer", "coupon_not_applicable");
            var sets = productIds.Min(p => byProduct[p].Count);
            var off = Money.ApplyBps(productIds.Sum(p => byProduct[p].Take(sets).Sum()), c.Value * 100);
            if (c.MaxDiscountPaise is { } cap) off = Math.Min(off, cap);
            off = Math.Min(off, baseSum);
            return new Result(c, off, Money.Allocate(off, eligible));
        }
        if (c.Kind == "freeship")   // delivery is free for the order: no discount
        {
            if (baseSum == 0) throw new AppException("This coupon does not apply to the items in your cart", "coupon_not_applicable");
            if (baseSum < c.MinOrderPaise) throw new AppException($"Add items worth ₹{ShortfallRupees(c.MinOrderPaise - baseSum)} more to use this coupon", "coupon_min_order");
            return new Result(c, 0, eligible.Keys.ToDictionary(k => k, _ => 0L), true);
        }
        if (baseSum == 0) throw new AppException("This coupon does not apply to the items in your cart", "coupon_not_applicable");
        if (baseSum < c.MinOrderPaise)
            throw new AppException($"Add items worth ₹{ShortfallRupees(c.MinOrderPaise - baseSum)} more to use this coupon", "coupon_min_order");
        var discount = c.Kind == "percent" ? Money.ApplyBps(baseSum, c.Value) : c.Value;
        if (c.MaxDiscountPaise is { } max) discount = Math.Min(discount, max);
        discount = Math.Min(discount, baseSum);
        return new Result(c, discount, Money.Allocate(discount, eligible));
    }

    /// <summary>The automatic coupon that saves the customer the most on this cart, or null. Every normal rule still applies: a coupon that fails is skipped.</summary>
    public async Task<Result?> BestAutomaticAsync(Guid userId, IReadOnlyList<CartBAL.CartLine> lines)
    {
        var saved = JsonHelper.Object(await coupons.GrowthJsonAsync());
        if (!((JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["auto_discounts"]!).Bool("enabled")) return null;
        Result? best = null;
        foreach (var c in await coupons.AutomaticAsync())
        {
            Result res;
            try { res = await EvaluateAsync(c.Code, userId, lines); }
            catch (AppException) { continue; }
            if (best is null || res.Discount > best.Discount) best = res;
        }
        return best;
    }

    /// <summary>A short cart hint for the closest automatic offer the cart is just short of: "Add 1 more item to get 10% off" (volume),
    /// "Add 1 more item to get 1 free" (buy X get Y), "Add &lt;product&gt; to get 10% off the set" (bundle missing one product). Null if none is close.</summary>
    public async Task<string?> VolumeNudgeAsync(Guid userId, IReadOnlyList<CartBAL.CartLine> lines)
    {
        var saved = JsonHelper.Object(await coupons.GrowthJsonAsync());
        if (!((JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["auto_discounts"]!).Bool("enabled")) return null;
        (int N, string Text)? best = null;
        var inCart = lines.Where(l => string.IsNullOrEmpty(l.Problem)).Select(l => l.Product.Id.ToString()).ToHashSet();
        foreach (var c in (await coupons.AutomaticAsync()).Where(x => x.Kind is "volume" or "bxgy" or "bundle"))
        {
            try { await EvaluateAsync(c.Code, userId, lines); }
            catch (AppException exc)
            {
                if (exc.Code != "coupon_not_applicable") continue;
                if (c.Kind == "bundle")
                {
                    var all = JsonHelper.Array(c.ProductIds).Select(x => x!.GetValue<string>()).ToList();
                    var missing = all.Where(x => !inCart.Contains(x)).ToList();
                    if (missing.Count != 1 || missing.Count == all.Count) continue;   // only when the cart already holds the rest of the set
                    var prod = (await catalogDal.PublicProductsByIdsAsync([Guid.Parse(missing[0])], inStockOnly: true)).FirstOrDefault();
                    if (prod is not null && (best is null || 1 < best.Value.N)) best = (1, $"Add {prod.Title} to get {c.Value}% off the set");
                    continue;
                }
                var m = System.Text.RegularExpressions.Regex.Match(exc.Message, @"^Add (\d+) more item");
                if (!m.Success || (best is not null && int.Parse(m.Groups[1].Value) >= best.Value.N)) continue;
                var n = int.Parse(m.Groups[1].Value);
                var reward = c.Kind == "volume" ? $"{c.Value}% off" : c.Value == 100 ? $"{c.GetQty} free" : $"{c.GetQty} at {c.Value}% off";
                best = (n, $"Add {n} more item{(n > 1 ? "s" : "")} to get {reward}");
            }
        }
        return best?.Text;
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
