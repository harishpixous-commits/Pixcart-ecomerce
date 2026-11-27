using System.Security.Cryptography;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Pay another way, the shopper's return and the webhooks of Cashfree, PhonePe, PayU and Stripe
/// (docs/PAYMENT_GATEWAYS.md section 5; mirror of the bottom of routers/orders.py).</summary>
public class PaymentFlowBAL(OrdersDAL orders, IntegrationDAL integrationDal, IOrdersBAL orderSvc, IPaymentGatewayBAL gateways, IRateLimitBAL rateLimit,
    IRefundQueue refundQueue, IMySqlDapperHelper db) : IPaymentFlowBAL
{
    private static readonly string[] Extra = ["cashfree", "phonepe", "payu", "stripe"];

    public async Task<JsonObject> SwitchAsync(UserModel user, Guid orderId, string? provider)
    {
        if (provider is not null && provider != "razorpay" && !Extra.Contains(provider)) throw new AppException("Unknown payment method", "unknown_gateway", 400);
        PaymentModel created; OrderModel order;
        await using (var uow = await db.BeginAsync())
        {
            order = await orders.GetOrderAsync(orderId, uow) ?? throw new NotFoundException("Order");
            if (order.UserId != user.Id) throw new NotFoundException("Order");
            var latest = await orders.LatestPaymentForUpdateAsync(order.Id, uow);
            if (order.Status != "pending_payment" || latest is null || latest.Status == "captured")
                throw new AppException("Nothing is waiting to be paid on this order.", "not_pending", 409);
            await rateLimit.RateLimitAsync($"payswitch:{order.Id}", 20, 600, uow);
            created = await gateways.StartAsync(order, user, latest.AmountPaise, latest.ChargeAmount, latest.Currency.Length > 0 ? latest.Currency : "INR", uow, provider, latest.Provider);
            await uow.CommitAsync();
        }
        return new JsonObject { ["payment"] = await orderSvc.ShopperCheckoutAsync(order, created, user) };
    }

    private async Task<PaymentModel?> FindAsync(string code, string? reference, IUnitOfWork uow)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        var p = await orders.PaymentByProviderOrderForUpdateAsync(reference.Length > 100 ? reference[..100] : reference, uow);
        return p is not null && p.Provider == code ? p : null;
    }

    public async Task<(Guid? OrderId, string Outcome, string Reason)> ReturnAsync(string code, IReadOnlyDictionary<string, string> data)
    {
        if (!Extra.Contains(code)) throw new NotFoundException("Gateway");
        var adapter = await gateways.AdapterAsync(code);
        var reference = adapter.ReferenceFromReturn(data);
        Guid orderId; JsonObject res;
        try
        {
            await using var uow = await db.BeginAsync();
            var payment = await FindAsync(code, reference, uow);
            if (payment is null) return (null, "unknown", "");
            orderId = payment.OrderId;
            res = await orderSvc.CheckWithGatewayAsync(payment, uow);
            await uow.CommitAsync();
            if (res["result"]?.GetValue<string>() == "refund") refundQueue.Enqueue(await orders.PendingRefundIdsAsync(payment.Id));
        }
        catch (Exception exc) when (exc is RazorpayBAL.GatewayException or AppException)
        {
            var oid = reference is null ? (Guid?)null : (await orders.PaymentByProviderOrderAsync(reference))?.OrderId;
            return (oid, oid is null ? "unknown" : "checking", "");
        }
        var word = res["result"]?.GetValue<string>();
        if (word is "paid" or "already" or "already_paid" or "refund") return (orderId, "success", "");
        if (res["waiting"]?.GetValue<bool>() == true) return (orderId, "checking", "");
        return (orderId, "failed", res["reason"]?.GetValue<string>() is { Length: > 0 } r ? r : "The payment did not go through");
    }

    public async Task<object> WebhookAsync(string code, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        if (!Extra.Contains(code)) throw new NotFoundException("Gateway");
        var adapter = await gateways.AdapterAsync(code);
        var reference = adapter.VerifyWebhook(headers, body);
        if (string.IsNullOrEmpty(reference)) throw new AppException("Invalid signature", "bad_signature", 400);
        var eid = Convert.ToHexStringLower(SHA256.HashData(body));
        await using var uow = await db.BeginAsync();
        if (!await integrationDal.RecordWebhookOnceAsync(code, eid[..Math.Min(80, eid.Length)], "notification", DateTimeFunctions.UtcNow(), uow.Transaction))
            return new { ok = true, duplicate = true };
        var payment = await FindAsync(code, reference, uow);
        if (payment is not null)
        {
            try { var res = await orderSvc.CheckWithGatewayAsync(payment, uow); await uow.CommitAsync(); if (res["result"]?.GetValue<string>() == "refund") refundQueue.Enqueue(await orders.PendingRefundIdsAsync(payment.Id)); }
            catch (Exception exc) when (exc is RazorpayBAL.GatewayException or AppException) { throw new AppException("Could not check the payment yet", "gateway_error", 503); }
        }
        else await uow.CommitAsync();
        return new { ok = true };
    }
}
