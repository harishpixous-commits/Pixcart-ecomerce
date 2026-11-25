using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Checkout (reference: the checkout routes of routers/orders.py — same paths, bodies and payload). The quote shows
/// the bill the shopper will pay: cart totals, delivery and COD fees, the marketplace's own fees, the tip, an optional
/// coupon, and whether cash on delivery is allowed for this amount.
/// </summary>
[ApiController]
[Route("/api/checkout")]
[SignedIn]
public class CheckoutController(ICartBAL cart, IFeesBAL fees, ICouponsBAL coupons, IPlatformSettingsBAL platform, AddressDAL addresses, ICurrentUser current) : ControllerBase
{
    public sealed record QuoteIn(
        [param: Required] Guid AddressId,
        [param: RegularExpression("^(cod|online)$")] string PaymentMethod = "online",
        [param: MaxLength(30)] string? CouponCode = null,
        [param: Range(0, 500_000)] int TipPaise = 0);

    /// <summary>The checkout quote (reference: POST /api/checkout/quote).</summary>
    [HttpPost("quote")]
    public async Task<JsonObject> Quote(QuoteIn body)
    {
        var user = await current.RequireAsync();
        var address = await addresses.GetAsync(body.AddressId);
        if (address is null || address.UserId != user.Id) throw new NotFoundException("Address");
        var cfg = await platform.GetAsync();
        var ck = await fees.GetAsync();
        var view = await cart.ViewAsync(user.Id);
        var summary = view["summary"]!.AsObject();
        var codFee = body.PaymentMethod == "cod" ? cfg.Int("cod_fee_paise") : 0;
        summary["cod_fee"] = codFee;
        summary["grand_total"] = summary["grand_total"]!.GetValue<long>() + codFee;
        long tip;
        try { tip = BAL.FeesBAL.TipAmount(ck, body.TipPaise); }
        catch (AppException) { tip = 0; }
        summary["tip"] = tip;
        summary["grand_total"] = summary["grand_total"]!.GetValue<long>() + tip;
        view["address"] = new JsonObject
        {
            ["instructions"] = address.Instructions,
            ["lat"] = address.Lat is { } lat ? (double)lat : null,
            ["lng"] = address.Lng is { } lng ? (double)lng : null,
        };
        view["coupon"] = null;
        if (!string.IsNullOrWhiteSpace(body.CouponCode))
        {
            var lines = await cart.LoadCartAsync(user.Id);
            try
            {
                var res = await coupons.EvaluateAsync(body.CouponCode, user.Id, lines);
                view["coupon"] = new JsonObject { ["code"] = res.Coupon.Code, ["discount"] = res.Discount, ["description"] = res.Coupon.Description, ["error"] = null };
                summary["grand_total"] = summary["grand_total"]!.GetValue<long>() - res.Discount;
                summary["coupon_discount"] = res.Discount;
            }
            catch (AppException exc)
            {
                view["coupon"] = new JsonObject { ["code"] = body.CouponCode.Trim().ToUpperInvariant(), ["discount"] = 0, ["error"] = exc.Message };
            }
        }
        view["cod_allowed"] = cfg.Bool("cod_enabled") && summary["grand_total"]!.GetValue<long>() <= cfg.Int("cod_max_order_paise");
        view["address_id"] = address.Id.ToString();
        return view;
    }
}
