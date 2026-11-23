using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The shopper's orders (reference: routers/orders.py — same paths, bodies and payload). Placement is one
/// transaction with the stock moves and coupon use; the list, cancellation, delivery rating and payment routes land
/// with the next commerce slices.
/// </summary>
[ApiController]
[Route("/api/orders")]
[SignedIn]
public class OrdersController(IOrdersBAL orders, IPlatformSettingsBAL platform, ICurrentUser current) : ControllerBase
{
    public sealed record PlaceIn(
        [param: Required] Guid AddressId,
        [param: RegularExpression("^(cod|online)$")] string PaymentMethod = "online",
        [param: Required, MinLength(8), MaxLength(64), RegularExpression("^[A-Za-z0-9\\-_]+$")] string IdempotencyKey = "",
        long? ExpectedTotal = null,
        [param: MaxLength(30)] string? CouponCode = null,
        [param: Range(0, 500_000)] int TipPaise = 0,
        [param: MaxLength(20)] string BuyerGstin = "",
        [param: MaxLength(160)] string BuyerBusiness = "",
        [param: MaxLength(300)] string? Instructions = null,
        bool NoBag = false,
        [param: RegularExpression("^[A-Z]{3}$")] string? Currency = null);

    /// <summary>Place the order (reference: POST /api/orders).</summary>
    [HttpPost("")]
    public async Task<JsonObject> Create(PlaceIn body)
    {
        var user = await current.RequireAsync();
        // Maintenance mode (Admin → Marketplace settings): no new orders; staff may still place test orders.
        if (!user.IsAdmin && (await platform.GetAsync()).Bool("maintenance_mode"))
            throw new AppException(
                "The shop is closed for maintenance right now, so orders cannot be placed. Your cart is saved; please try again soon.",
                "maintenance", 503);
        var (order, payment) = await orders.PlaceOrderAsync(
            user,
            body.AddressId,
            body.PaymentMethod,
            body.IdempotencyKey,
            body.ExpectedTotal,
            couponCode: string.IsNullOrWhiteSpace(body.CouponCode) ? null : body.CouponCode.Trim(),
            tipPaise: body.TipPaise,
            buyerGstin: body.BuyerGstin,
            buyerBusiness: body.BuyerBusiness,
            instructions: body.Instructions,
            noBag: body.NoBag,
            currency: body.Currency);
        Response.StatusCode = StatusCodes.Status201Created;
        return new JsonObject
        {
            ["order"] = await orders.DetailAsync(order),
            ["payment"] = await orders.ShopperCheckoutAsync(order, payment, user),
        };
    }
}
