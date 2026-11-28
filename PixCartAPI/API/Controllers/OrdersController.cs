using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The shopper's orders (reference: routers/orders.py — same paths, bodies and payload). Placement is one
/// transaction with the stock moves and coupon use; also the orders list, cancellation, delivery rating and
/// complaints, and the Razorpay payment routes.
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
        [param: MaxLength(300)] string GiftMessage = "",
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
            giftMessage: body.GiftMessage,
            currency: body.Currency);
        Response.StatusCode = StatusCodes.Status201Created;
        return new JsonObject
        {
            ["order"] = await orders.DetailAsync(order),
            ["payment"] = await orders.ShopperCheckoutAsync(order, payment, user),
        };
    }

    /// <summary>The shopper's orders page (reference: GET /api/orders).</summary>
    [HttpGet("")]
    public async Task<JsonObject> MyOrders([FromQuery] int page = 1, [FromQuery(Name = "page_size")] int pageSize = 10)
    {
        if (page < 1 || pageSize < 1 || pageSize > 50)
            throw new AppException("page must be at least 1 and page_size between 1 and 50", "validation", 422);
        return await orders.MyOrdersAsync(await current.RequireAsync(), page, pageSize);
    }

    /// <summary>One order as its shopper sees it (reference: GET /api/orders/{order_id}).</summary>
    [HttpGet("{orderId}")]
    public async Task<JsonObject> GetOrder(Guid orderId) =>
        await orders.GetShopperOrderAsync(await current.RequireAsync(), orderId);

    /// <summary>Cancel the order's cancellable packages, all or one (reference: POST /api/orders/{order_id}/cancel).</summary>
    [HttpPost("{orderId}/cancel")]
    public async Task<JsonObject> Cancel(Guid orderId, CancelIn body) =>
        await orders.CancelAsync(await current.RequireAsync(), orderId, body.Reason, body.SubOrderId);

    public sealed record CancelIn(
        [param: StringLength(300, MinimumLength = 3)] string Reason = "Changed my mind",
        Guid? SubOrderId = null);

    /// <summary>Verify a Razorpay payment after the payment window returns (reference: POST
    /// /api/payments/razorpay/verify).</summary>
    [HttpPost("/api/payments/razorpay/verify")]
    public async Task<JsonObject> VerifyPayment(VerifyIn body)
    {
        var user = await current.RequireAsync();
        var (result, order) = await orders.VerifyPaymentAsync(
            user, body.RazorpayOrderId, body.RazorpayPaymentId, body.RazorpaySignature);
        return new JsonObject { ["result"] = result, ["order"] = await orders.DetailAsync(order) };
    }

    public sealed record VerifyIn(
        [param: Required, MaxLength(40)] string RazorpayOrderId = "",
        [param: Required, MaxLength(40)] string RazorpayPaymentId = "",
        [param: Required, MaxLength(128)] string RazorpaySignature = "");

    /// <summary>The shopper's "did my payment go through?" (reference: POST /api/orders/{order_id}/payment-status).</summary>
    [HttpPost("{orderId}/payment-status")]
    public async Task<JsonObject> PaymentStatus(Guid orderId) =>
        await orders.PaymentStatusAsync(await current.RequireAsync(), orderId);
}
