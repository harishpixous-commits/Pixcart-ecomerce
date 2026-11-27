using System.Globalization;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// RazorpayX payout events (POST /api/webhooks/razorpayx): "processed" marks the payout paid with its UTR and tells the
/// seller; "failed", "reversed", "rejected" and "cancelled" mark it failed and give its ledger entries back to the
/// seller's available balance, so the next payout run picks them up again. An unknown payout is ignored.
/// </summary>
public sealed class PayoutWebhookTarget(AdminPayoutDAL data, INotifyBAL notify) : IPayoutWebhookTarget
{
    public async Task ApplyPayoutWebhookAsync(IUnitOfWork uow, string providerPayoutId, string status, string utr, string reason)
    {
        if (providerPayoutId.Length == 0) return;
        var p = await data.LockByProviderAsync(providerPayoutId, uow);
        if (p is null) return;
        var now = DateTimeFunctions.UtcNow();
        if (status == "processed" && p.Status != "paid")
        {
            if (p.Status == "cancelled") throw new AppException("Payout is already cancelled", "invalid_status", 409);
            p.Status = "paid";
            p.Utr = utr;
            p.PaidAt = now;
            var last4 = (JsonNode.Parse(p.BankSnapshot) as JsonObject)?["account_last4"]?.GetValue<string>() ?? "";
            await notify.NotifySellerAsync(p.SellerId, "payout_sent", new Dictionary<string, object?>
            {
                ["payout_number"] = p.Number, ["amount"] = "₹" + (p.Amount / 100.0).ToString("N2", CultureInfo.InvariantCulture),
                ["last4"] = last4, ["utr"] = utr,
            }, "/seller/payouts", uow);
        }
        else if (status is "failed" or "reversed" or "rejected" or "cancelled" && p.Status is not ("failed" or "cancelled"))
        {
            var why = reason.Length > 0 ? reason : status;
            p.Status = "failed";
            p.FailureReason = why.Length > 300 ? why[..300] : why;
            await data.ReleaseAsync(p.Id, uow);  // only this payout's own sales go back to unpaid
        }
        else return;
        p.UpdatedAt = now;
        await data.SaveAsync(p, uow);
    }
}

/// <summary>Courier tracking (POST /api/webhooks/shiprocket) moves packages through the orders module, exactly as a staff
/// action would: picked up → shipped, delivered → delivered, returned to the seller → cancelled with refund and restock.</summary>
public sealed class ShipmentWebhookTarget(IOrdersBAL orders) : IShipmentWebhookTarget
{
    public Task TransitionAsync(IUnitOfWork uow, SubOrderModel sub, string to, string actor, string note) =>
        orders.TransitionAsync(sub, to, actor, note, uow);

    public async Task CancelSubOrderAsync(IUnitOfWork uow, SubOrderModel sub, string actor, string reason) =>
        await orders.CancelSubOrderAsync(sub, actor, reason, uow);
}
