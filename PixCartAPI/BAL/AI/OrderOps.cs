using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.AI;

/// <summary>
/// Cancelling packages for the assistants (reference services/orders.cancel_sub_order and routers/orders.customer_cancel)
/// until the orders module is merged: status, stock, refund of an online payment (queued for the refunds job), order closed
/// and coupon released when nothing is left, and the customer and seller told.
/// </summary>
public static class OrderOps
{
    public static readonly string[] CustomerCancellableMax = ["placed", "confirmed", "packed"];
    private static readonly Dictionary<string, string[]> Transitions = new()
    {
        ["pending_payment"] = ["placed", "cancelled"], ["placed"] = ["confirmed", "cancelled"], ["confirmed"] = ["packed", "cancelled"],
        ["packed"] = ["shipped", "cancelled"], ["shipped"] = ["delivered", "cancelled"], ["delivered"] = [], ["cancelled"] = [],
    };

    /// <summary>The package steps a customer can still cancel at, up to the owner's choice (Admin → Marketplace settings).</summary>
    public static async Task<string[]> CustomerCancellableAsync(AiDAL dal)
    {
        var until = J.S((await AiShared.MarketplaceAsync(dal))["customer_cancel_until"]);
        var i = Array.IndexOf(CustomerCancellableMax, until);
        return i >= 0 ? CustomerCancellableMax[..(i + 1)] : CustomerCancellableMax;
    }

    private static async Task<bool> FeesBackAsync(AiDAL dal)
    {
        var ck = await dal.SettingAsync("checkout");
        return ck["fees_refund_on_cancel"] is null || J.Truthy(ck["fees_refund_on_cancel"]);
    }

    private static async Task NotifyAsync(AiDAL dal, AppSettings env, OrderModel order, SubOrderModel sub, string src, string actor, string reason, long refunded)
    {
        if (src == "pending_payment") return;
        var item = await dal.FirstTitleAsync(sub.Id, sub.Number);
        var refundText = refunded > 0 ? $"A refund of ₹{(refunded / 100.0).ToString("#,##0.00", System.Globalization.CultureInfo.InvariantCulture)} has been started."
            : order.PaymentMethod == "cod" ? "Nothing was charged for it." : "";
        await AiShared.NotifyAsync(dal, env, await dal.GetUserAsync(order.UserId), "order_cancelled",
            new() { ["order_number"] = order.Number, ["item"] = item, ["reason"] = reason, ["refund_text"] = refundText }, $"/orders/{order.Id}", ["inapp", "email"]);
        if (actor != "seller" && await dal.GetSellerAsync(sub.SellerId) is { } seller)
            await AiShared.NotifyAsync(dal, env, await dal.GetUserAsync(seller.UserId), "seller_order_cancelled",
                new() { ["order_number"] = sub.Number, ["reason"] = reason }, $"/seller/orders/{sub.Id}", ["inapp", "email"]);
    }

    /// <summary>Staff cancel one package (any status that can still become cancelled). Returns the refund id, if any.</summary>
    public static async Task<Guid?> AdminCancelAsync(AiDAL dal, AppSettings env, Guid subId, string reason, Guid adminId)
    {
        var feesBack = await FeesBackAsync(dal);
        SubOrderModel sub;
        OrderModel order;
        (Guid? RefundId, long Refunded) res;
        await using (var uow = await dal.BeginAsync())
        {
            sub = await dal.LockSubAsync(uow, subId) ?? throw new NotFoundException("Order part");
            if (!Transitions.GetValueOrDefault(sub.Status, []).Contains("cancelled")) throw new ConflictException("This order can no longer be cancelled", "not_cancellable");
            order = (await dal.LockOrderAsync(uow, sub.OrderId))!;
            res = await dal.CancelSubOrderAsync(uow, sub, order, "admin", reason, feesBack);
            await dal.AuditAsync(adminId, "suborder.admin_cancel", "sub_order", sub.Id, reason, uow);
            await uow.CommitAsync();
        }
        await NotifyAsync(dal, env, order, sub, sub.Status, "admin", reason, res.Refunded);
        return res.RefundId;
    }

    /// <summary>The customer cancels their cancellable packages of an order (all, or one). Ownership is the caller's check.</summary>
    public static async Task<List<Guid>> CustomerCancelAsync(AiDAL dal, AppSettings env, Guid orderId, Guid? subId, string reason)
    {
        var allowed = await CustomerCancellableAsync(dal);
        var feesBack = await FeesBackAsync(dal);
        var refunds = new List<Guid>();
        var done = new List<(SubOrderModel Sub, long Refunded)>();
        OrderModel order;
        await using (var uow = await dal.BeginAsync())
        {
            var subs = await dal.LockOrderSubsAsync(uow, orderId);
            var targets = subs.Where(s => subId is null || s.Id == subId).ToList();
            if (subId.HasValue && targets.Count == 0) throw new NotFoundException("Order part");
            var cancellable = targets.Where(s => allowed.Contains(s.Status) || s.Status == "pending_payment").ToList();
            if (cancellable.Count == 0) throw new AppException("This order can no longer be cancelled. You can return it after delivery.", "not_cancellable");
            order = (await dal.LockOrderAsync(uow, orderId))!;
            foreach (var s in cancellable)
            {
                var res = await dal.CancelSubOrderAsync(uow, s, order, "customer", reason, feesBack);
                if (res.RefundId is { } rid) refunds.Add(rid);
                done.Add((s, res.Refunded));
                order = (await dal.LockOrderAsync(uow, orderId))!; // refunded totals changed
            }
            await uow.CommitAsync();
        }
        foreach (var (s, refunded) in done) await NotifyAsync(dal, env, order, s, s.Status, "customer", reason, refunded);
        return refunds;
    }
}
