using BAL.Interface;
using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>Customer-safe views of records (reference: shop_assistant/views.py). Every field is listed explicitly: a
/// new column on a model never reaches the chat by accident. Commission, TCS/TDS, payouts, settlement, seller KYC,
/// SKUs, tax splits and staff-only ticket notes are deliberately absent.</summary>
public partial class ShopAssistantBAL
{
    private static readonly Dictionary<string, string> PackageStatus = new()
    {
        ["pending_payment"] = "Waiting for payment", ["placed"] = "Order placed", ["confirmed"] = "Confirmed by the seller",
        ["packed"] = "Packed", ["shipped"] = "Shipped", ["delivered"] = "Delivered", ["cancelled"] = "Cancelled",
    };
    private static readonly string[] Steps = ["placed", "confirmed", "packed", "shipped", "delivered"];
    private static readonly Dictionary<string, string> PaymentLabels = new() { ["cod"] = "Cash on delivery", ["online"] = "Paid online" };
    private static readonly Dictionary<string, string> PaymentStatusLabels = new()
    {
        ["pending"] = "Payment pending", ["paid"] = "Paid", ["cod"] = "Pay on delivery", ["failed"] = "Payment failed",
        ["refunded"] = "Refunded", ["partially_refunded"] = "Partly refunded",
    };
    private static readonly Dictionary<string, string> RefundStatusLabels = new()
    {
        ["pending"] = "Being processed", ["processed"] = "Refunded", ["failed"] = "Retrying",
    };
    private static readonly Dictionary<string, string> ReturnStatusLabels = new()
    {
        ["requested"] = "Requested", ["approved"] = "Approved, pickup pending", ["picked_up"] = "Picked up",
        ["received"] = "Received by seller", ["refunded"] = "Refunded", ["rejected"] = "Rejected", ["cancelled"] = "Cancelled",
    };
    private static readonly Dictionary<string, string> TicketStatusLabels = new()
    {
        ["open"] = "Open, with our team", ["awaiting_customer"] = "Waiting for your reply",
        ["resolved"] = "Resolved", ["closed"] = "Closed",
    };

    private static string? D(DateTime? dt) => dt?.ToString("o");

    private static string OrderStatus(IReadOnlyList<SubOrderModel> subs)
    {
        var st = subs.Select(s => s.Status).ToList();
        if (st.Count == 0) return "Order placed";
        if (st.All(s => s == "cancelled")) return "Cancelled";
        var live = st.Where(s => s != "cancelled").ToList();
        if (live.All(s => s == "delivered")) return "Delivered";
        if (live.Any(s => s == "pending_payment")) return "Waiting for payment";
        if (live.Any(s => s is "shipped" or "delivered"))
            return live.Any(s => s == "delivered") ? "Partly delivered" : "Shipped";
        return PackageStatus.GetValueOrDefault(live[0], "In progress");
    }

    private async Task<List<JsonObject>> OrderCardsAsync(IReadOnlyList<OrderModel> orderRows)
    {
        if (orderRows.Count == 0) return [];
        var subs = (await orders.SubOrdersForOrdersAsync(orderRows.Select(o => o.Id).ToList()))
            .OrderBy(s => s.Number).ToList();
        var items = subs.Count > 0 ? await orders.ItemsAsync(subs.Select(s => s.Id).ToList()) : [];
        var outp = new List<JsonObject>();
        foreach (var o in orderRows)
        {
            var os = subs.Where(s => s.OrderId == o.Id).ToList();
            var ids = os.Select(s => s.Id).ToHashSet();
            var its = items.Where(i => ids.Contains(i.SubOrderId)).ToList();
            outp.Add(new JsonObject
            {
                ["id"] = o.Id.ToString(), ["number"] = o.Number,
                ["placed_at"] = D(o.PlacedAt == default ? o.CreatedAt : o.PlacedAt),
                ["status"] = OrderStatus(os), ["total"] = o.GrandTotal, ["total_text"] = ShopAssistant.ShopKb.Inr(o.GrandTotal),
                ["payment"] = PaymentLabels.GetValueOrDefault(o.PaymentMethod, o.PaymentMethod),
                ["item_count"] = its.Sum(i => i.Qty),
                ["items"] = new JsonArray(its.Take(3).Select(i => (JsonNode)new JsonObject
                {
                    ["title"] = i.Title, ["image"] = i.ImageUrl, ["qty"] = i.Qty,
                }).ToArray()),
                ["link"] = $"/orders/{o.Id}",
            });
        }
        return outp;
    }

    /// <summary>One order of the signed-in customer (the caller has checked ownership). Reference: views.order_view.</summary>
    private async Task<JsonObject> OrderViewAsync(OrderModel o)
    {
        var subs = (await orders.SubOrdersAsync(o.Id)).OrderBy(s => s.Number).ToList();
        var items = subs.Count > 0 ? await orders.ItemsAsync(subs.Select(s => s.Id).ToList()) : [];
        var sellers = subs.Count > 0
            ? (await orders.SellersAsync(subs.Select(s => s.SellerId).Distinct().ToList())).ToDictionary(s => s.Id, s => s.DisplayName)
            : [];
        var refunds = await orders.RefundsAsync(o.Id);
        var rets = subs.Count > 0 ? await returns.ReturnsForSubsAsync(subs.Select(s => s.Id).ToList()) : [];
        var canCancelAt = OrdersBAL.CustomerCancellableAt(await platform.GetAsync());
        var packages = new JsonArray();
        await using (var uow = await db.BeginAsync())
        {
            foreach (var s in subs)
            {
                var returnable = await returnsBal.ReturnableItemsAsync(s, uow);
                var reached = Array.IndexOf(Steps, s.Status);
                packages.Add(new JsonObject
                {
                    ["id"] = s.Id.ToString(), ["number"] = s.Number, ["status"] = s.Status,
                    ["status_label"] = PackageStatus.GetValueOrDefault(s.Status, s.Status),
                    ["seller"] = sellers.GetValueOrDefault(s.SellerId, ""),
                    ["steps"] = new JsonArray(Steps.Select((k, i) => (JsonNode)new JsonObject
                    {
                        ["key"] = k, ["label"] = PackageStatus[k],
                        ["done"] = s.Status != "cancelled" && i <= reached,
                    }).ToArray()),
                    ["items"] = new JsonArray(items.Where(i => i.SubOrderId == s.Id).Select(i => (JsonNode)new JsonObject
                    {
                        ["title"] = i.Title, ["variant"] = i.VariantLabel, ["image"] = i.ImageUrl, ["qty"] = i.Qty,
                        ["amount"] = ShopAssistant.ShopKb.Inr(i.LineTotal),
                        ["return_window_days"] = i.ReturnWindowDays,
                    }).ToArray()),
                    ["expected_delivery_at"] = D(s.ExpectedDeliveryAt), ["shipped_at"] = D(s.ShippedAt),
                    ["delivered_at"] = D(s.DeliveredAt), ["cancelled_at"] = D(s.CancelledAt),
                    ["cancel_reason"] = s.Status == "cancelled" ? s.CancelReason : "",
                    ["courier"] = s.CourierName, ["tracking_number"] = s.TrackingNumber, ["tracking_url"] = s.TrackingUrl,
                    ["can_cancel"] = canCancelAt.Contains(s.Status),
                    ["can_return"] = returnable.Any(r => r.Bool("eligible")),
                    ["return_by"] = returnable.Where(r => r.Bool("eligible")).Select(r => r.Str("return_by")).DefaultIfEmpty().Min(),
                    ["invoice_ready"] = s.InvoiceNumber.Length > 0,
                });
            }
        }
        return new JsonObject
        {
            ["id"] = o.Id.ToString(), ["number"] = o.Number,
            ["placed_at"] = D(o.PlacedAt == default ? o.CreatedAt : o.PlacedAt),
            ["status"] = OrderStatus(subs),
            ["payment"] = PaymentLabels.GetValueOrDefault(o.PaymentMethod, o.PaymentMethod),
            ["payment_status"] = PaymentStatusLabels.GetValueOrDefault(o.PaymentStatus, o.PaymentStatus),
            ["items_total"] = ShopAssistant.ShopKb.Inr(o.ItemsTotal),
            ["delivery"] = ShopAssistant.ShopKb.Inr(o.ShippingTotal + o.CodFee),
            ["discount"] = o.DiscountTotal > 0 ? ShopAssistant.ShopKb.Inr(o.DiscountTotal) : "",
            ["total"] = ShopAssistant.ShopKb.Inr(o.GrandTotal),
            ["refunded"] = o.RefundedTotal > 0 ? ShopAssistant.ShopKb.Inr(o.RefundedTotal) : "",
            ["packages"] = packages,
            ["refunds"] = new JsonArray(refunds.Select(r => (JsonNode)new JsonObject
            {
                ["amount"] = ShopAssistant.ShopKb.Inr(r.AmountPaise),
                ["status"] = RefundStatusLabels.GetValueOrDefault(r.Status, r.Status), ["at"] = D(r.CreatedAt),
            }).ToArray()),
            ["returns"] = new JsonArray(rets.Select(r => (JsonNode)new JsonObject
            {
                ["number"] = r.Number, ["status"] = ReturnStatusLabels.GetValueOrDefault(r.Status, r.Status),
                ["reason"] = PlatformSettingsBAL.ReturnReasons.GetValueOrDefault(r.Reason, r.Reason),
                ["refund_amount"] = r.RefundAmount > 0 ? ShopAssistant.ShopKb.Inr(r.RefundAmount) : "",
                ["at"] = D(r.CreatedAt),
            }).ToArray()),
            ["link"] = $"/orders/{o.Id}",
        };
    }

    private static JsonObject TicketView(SupportTicketModel t, IReadOnlyList<TicketMessageModel>? messages = null)
    {
        var outp = new JsonObject
        {
            ["id"] = t.Id.ToString(), ["number"] = t.Number, ["subject"] = t.Subject,
            ["category"] = SupportTicketBAL.CategoryLabels.GetValueOrDefault(t.Category, t.Category),
            ["status"] = t.Status, ["status_label"] = TicketStatusLabels.GetValueOrDefault(t.Status, t.Status),
            ["is_grievance"] = t.IsGrievance, ["created_at"] = D(t.CreatedAt), ["updated_at"] = D(t.UpdatedAt),
            ["link"] = $"/support/{t.Id}",
        };
        if (messages is not null)
        {
            var pub = messages.Where(m => !m.IsInternal).ToList(); // staff-only notes never leave the support desk
            var team = pub.Where(m => m.AuthorRole == "staff").ToList();
            outp["last_team_reply"] = team.Count > 0
                ? new JsonObject { ["text"] = team[^1].Body[..Math.Min(600, team[^1].Body.Length)], ["at"] = D(team[^1].CreatedAt) }
                : null;
            outp["message_count"] = pub.Count;
        }
        return outp;
    }

    private async Task<List<JsonObject>> ReturnListAsync(Guid userId, int limit = 10)
    {
        var rows = await returns.ReturnsForUserAsync(userId, limit);
        return rows.Select(r => new JsonObject
        {
            ["number"] = r.Ret.Number, ["status"] = ReturnStatusLabels.GetValueOrDefault(r.Ret.Status, r.Ret.Status),
            ["reason"] = PlatformSettingsBAL.ReturnReasons.GetValueOrDefault(r.Ret.Reason, r.Ret.Reason),
            ["refund_amount"] = r.Ret.RefundAmount > 0 ? ShopAssistant.ShopKb.Inr(r.Ret.RefundAmount) : "",
            ["package"] = r.SubNumber, ["at"] = D(r.Ret.CreatedAt), ["link"] = $"/orders/{r.OrderId}",
        }).ToList();
    }
}
