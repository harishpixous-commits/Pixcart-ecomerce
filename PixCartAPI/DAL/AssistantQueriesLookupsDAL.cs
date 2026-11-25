namespace DAL;

using System.Text.Json.Nodes;

using Model.Constants;
using Utils;
using Utils.Interface;

/// <summary>
/// Assistant lookup queries continued (reference: app/assistant/queries.py — packages, orders, customers,
/// catalogue, sellers, returns/refunds/tickets, payouts, coupons).
/// </summary>
public partial class AssistantQueriesDAL
{
    public static readonly string[] PackageStatuses = ["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"];

    private static JsonObject PeriodOrNull(AssistantPeriods.Period? period) =>
        period?.AsDict() as JsonObject ?? new JsonObject();

    /// <summary>Reference: queries.find_packages.</summary>
    public async Task<JsonObject> FindPackagesAsync(AssistantPeriods.Period? period, string? status = null, string? q = null,
        Guid? sellerId = null, string? paymentMethod = null, int? lateToShipHours = null, int limit = 25)
    {
        var where = "s.status != 'pending_payment'";
        var prm = new Dictionary<string, object?>();
        if (period is not null)
        {
            where += " AND s.created_at >= @Start AND s.created_at < @End";
            prm["Start"] = period.Start; prm["End"] = period.End;
        }
        if (status is not null)
        {
            if (!PackageStatuses.Contains(status))
                throw new AppException($"Package status is one of: {string.Join(", ", PackageStatuses)}", "bad_status");
            where += " AND s.status = @Status"; prm["Status"] = status;
        }
        if (sellerId is not null) { where += " AND s.seller_id = @SellerId"; prm["SellerId"] = sellerId; }
        if (paymentMethod is not null) { where += " AND o.payment_method = @PaymentMethod"; prm["PaymentMethod"] = paymentMethod; }
        if (lateToShipHours is not null)
        {
            where += " AND s.status IN ('placed','confirmed','packed') AND s.created_at < @Late";
            prm["Late"] = DateTimeFunctions.UtcNow().AddHours(-lateToShipHours.Value);
        }
        if (q is not null)
        {
            where += " AND (s.number LIKE @Q OR o.number LIKE @Q OR u.phone LIKE @Q OR u.name LIKE @Q OR s.tracking_number LIKE @Q)";
            prm["Q"] = Like(q);
        }
        var from = "FROM sub_orders s JOIN orders o ON o.id = s.order_id JOIN sellers se ON se.id = s.seller_id JOIN users u ON u.id = o.user_id";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from} WHERE {where}", prm);
        var value = await db.ExecuteScalarAsync<long>($"SELECT COALESCE(SUM(s.total), 0) {from} WHERE {where}", prm);
        var rows = await db.QueryAsync<PackageRow>(
            $"SELECT s.number AS Package, o.number AS OrderNumber, CAST(s.order_id AS CHAR) AS OrderId, s.created_at AS CreatedAt, s.status AS Status," +
            " se.display_name AS Seller, u.name AS Customer, u.phone AS Phone, o.payment_method AS Payment, s.total AS Total," +
            " o.ship_to->>'$.city' AS City, o.ship_to->>'$.state_code' AS StateCode, s.tracking_number AS Awb" +
            $" {from} WHERE {where} ORDER BY s.created_at DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["package"] = r.Package, ["order"] = r.OrderNumber, ["order_id"] = r.OrderId, ["placed"] = IstFmt(r.CreatedAt),
                ["status"] = r.Status, ["seller"] = r.Seller, ["customer"] = r.Customer ?? "", ["phone"] = r.Phone ?? "",
                ["payment"] = r.Payment == "cod" ? "COD" : "Online", ["total"] = r.Total,
                ["city"] = r.City ?? "", ["state"] = IndianStates.Name(r.StateCode), ["awb"] = r.Awb,
            });
        return new JsonObject { ["period"] = PeriodOrNull(period), ["total"] = total, ["total_value"] = value, ["items"] = items };
    }

    private sealed class PackageRow
    {
        public string Package { get; set; } = "";
        public string OrderNumber { get; set; } = "";
        public string OrderId { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public string Status { get; set; } = "";
        public string Seller { get; set; } = "";
        public string? Customer { get; set; }
        public string? Phone { get; set; }
        public string Payment { get; set; } = "";
        public long Total { get; set; }
        public string? City { get; set; }
        public string? StateCode { get; set; }
        public string? Awb { get; set; }
    }

    /// <summary>Reference: queries.order_detail — looks up by order number, package number, AWB or order id.</summary>
    public async Task<JsonObject?> OrderDetailAsync(string reference)
    {
        var oref = reference.Trim().ToUpperInvariant();
        var order = await db.QueryFirstOrDefaultAsync<OrderRow>("SELECT CAST(id AS CHAR) AS Id, number AS Number, status AS Status," +
            " payment_method AS PaymentMethod, payment_status AS PaymentStatus, grand_total AS GrandTotal, items_total AS ItemsTotal," +
            " shipping_total AS ShippingTotal, discount_total AS DiscountTotal, coupon_code AS Coupon, refunded_total AS RefundedTotal," +
            " CAST(user_id AS CHAR) AS UserId, ship_to AS ShipTo, COALESCE(placed_at, created_at) AS PlacedAt FROM orders WHERE number = @R", new { R = oref });
        if (order is null)
        {
            var orderId = await db.ExecuteScalarAsync<string?>(
                "SELECT CAST(order_id AS CHAR) FROM sub_orders WHERE number = @R OR tracking_number = @R LIMIT 1", new { R = oref });
            if (orderId is null && Guid.TryParse(oref.ToLowerInvariant(), out var gid))
            {
                orderId = gid.ToString();
                order = await db.QueryFirstOrDefaultAsync<OrderRow>("SELECT CAST(id AS CHAR) AS Id, number AS Number, status AS Status," +
                    " payment_method AS PaymentMethod, payment_status AS PaymentStatus, grand_total AS GrandTotal, items_total AS ItemsTotal," +
                    " shipping_total AS ShippingTotal, discount_total AS DiscountTotal, coupon_code AS Coupon, refunded_total AS RefundedTotal," +
                    " CAST(user_id AS CHAR) AS UserId, ship_to AS ShipTo, COALESCE(placed_at, created_at) AS PlacedAt FROM orders WHERE id = @Id", new { Id = orderId });
            }
            else if (orderId is not null)
                order = await db.QueryFirstOrDefaultAsync<OrderRow>("SELECT CAST(id AS CHAR) AS Id, number AS Number, status AS Status," +
                    " payment_method AS PaymentMethod, payment_status AS PaymentStatus, grand_total AS GrandTotal, items_total AS ItemsTotal," +
                    " shipping_total AS ShippingTotal, discount_total AS DiscountTotal, coupon_code AS Coupon, refunded_total AS RefundedTotal," +
                    " CAST(user_id AS CHAR) AS UserId, ship_to AS ShipTo, COALESCE(placed_at, created_at) AS PlacedAt FROM orders WHERE id = @Id", new { Id = orderId });
        }
        if (order is null) return null;
        var u = await db.QueryFirstOrDefaultAsync<UserRow>(
            "SELECT CAST(id AS CHAR) AS Id, name AS Name, phone AS Phone, email AS Email FROM users WHERE id = @Id", new { Id = order.UserId });
        var ship = string.IsNullOrEmpty(order.ShipTo) ? new JsonObject() : JsonNode.Parse(order.ShipTo)!.AsObject();
        var packages = new JsonArray();
        var subIds = new List<string>();
        foreach (var s in await db.QueryAsync<PackageDetailRow>(
            "SELECT CAST(s.id AS CHAR) AS Id, s.number AS Package, se.display_name AS Seller, s.status AS Status, s.total AS Total," +
            " s.commission_paise AS Commission, s.seller_payout_paise AS SellerPayout, s.courier_name AS Courier, s.tracking_number AS Awb," +
            " s.shipped_at AS ShippedAt, s.delivered_at AS DeliveredAt, s.cancel_reason AS CancelReason, s.invoice_number AS Invoice" +
            " FROM sub_orders s JOIN sellers se ON se.id = s.seller_id WHERE s.order_id = @Id ORDER BY s.number", new { Id = order.Id }))
        {
            subIds.Add(s.Id);
            packages.Add(new JsonObject
            {
                ["package"] = s.Package, ["seller"] = s.Seller, ["status"] = s.Status, ["total"] = s.Total,
                ["commission"] = s.Commission, ["seller_payout"] = s.SellerPayout, ["courier"] = s.Courier, ["awb"] = s.Awb,
                ["shipped"] = IstFmt(s.ShippedAt), ["delivered"] = IstFmt(s.DeliveredAt),
                ["cancel_reason"] = s.CancelReason, ["invoice"] = s.Invoice,
            });
        }
        var items = new JsonArray();
        if (subIds.Count > 0)
            foreach (var i in await db.QueryAsync<ItemRow>(
                "SELECT sku AS Sku, title AS Title, variant_label AS VariantLabel, qty AS Qty, unit_price AS UnitPrice, line_total AS LineTotal, returned_qty AS ReturnedQty" +
                " FROM order_items WHERE sub_order_id IN @Ids", new { Ids = subIds }))
                items.Add(new JsonObject
                {
                    ["sku"] = i.Sku, ["title"] = i.Title, ["option"] = i.VariantLabel, ["qty"] = i.Qty,
                    ["unit_price"] = i.UnitPrice, ["line_total"] = i.LineTotal, ["returned_qty"] = i.ReturnedQty,
                });
        var payments = new JsonArray();
        foreach (var p in await db.QueryAsync<PaymentRow>(
            "SELECT status AS Status, method AS Method, amount_paise AS Amount, provider_payment_id AS GatewayId FROM payments WHERE order_id = @Id ORDER BY created_at",
            new { Id = order.Id }))
            payments.Add(new JsonObject { ["status"] = p.Status, ["method"] = p.Method, ["amount"] = p.Amount, ["gateway_payment_id"] = p.GatewayId ?? "" });
        var refunds = new JsonArray();
        foreach (var r in await db.QueryAsync<RefundRow>(
            "SELECT CAST(id AS CHAR) AS Id, amount_paise AS Amount, status AS Status, reason AS Reason, attempts AS Attempts FROM refunds WHERE order_id = @Id ORDER BY created_at",
            new { Id = order.Id }))
            refunds.Add(new JsonObject { ["id"] = r.Id, ["amount"] = r.Amount, ["status"] = r.Status, ["reason"] = r.Reason, ["attempts"] = r.Attempts });
        var returns = new JsonArray();
        if (subIds.Count > 0)
            foreach (var r in await db.QueryAsync<ReturnRow>(
                "SELECT number AS Number, status AS Status, reason AS Reason, refund_amount AS RefundAmount FROM return_requests WHERE sub_order_id IN @Ids",
                new { Ids = subIds }))
                returns.Add(new JsonObject { ["number"] = r.Number, ["status"] = r.Status, ["reason"] = r.Reason, ["refund_amount"] = r.RefundAmount });
        var timeline = new JsonArray();
        foreach (var e in await db.QueryAsync<EventRow>(
            "SELECT created_at AS At, from_status AS FromStatus, to_status AS ToStatus, actor AS Actor, note AS Note" +
            " FROM order_events WHERE order_id = @Id ORDER BY created_at LIMIT 40", new { Id = order.Id }))
            timeline.Add(new JsonObject
            {
                ["at"] = IstFmt(e.At), ["change"] = $"{e.FromStatus ?? "new"} → {e.ToStatus}", ["by"] = e.Actor,
                ["note"] = e.Note is { Length: > 160 } n ? n[..160] : e.Note,
            });
        return new JsonObject
        {
            ["order_id"] = order.Id, ["number"] = order.Number, ["status"] = order.Status, ["placed"] = IstFmt(order.PlacedAt),
            ["payment_method"] = order.PaymentMethod, ["payment_status"] = order.PaymentStatus, ["grand_total"] = order.GrandTotal,
            ["items_total"] = order.ItemsTotal, ["shipping_total"] = order.ShippingTotal, ["discount_total"] = order.DiscountTotal,
            ["coupon"] = order.Coupon, ["refunded_total"] = order.RefundedTotal,
            ["customer"] = new JsonObject
            {
                ["id"] = u?.Id ?? "", ["name"] = u?.Name ?? "", ["phone"] = u?.Phone ?? "", ["email"] = u?.Email ?? "",
            },
            ["ship_to"] = new JsonObject
            {
                ["name"] = ship["full_name"]?.GetValue<string>() ?? "", ["city"] = ship["city"]?.GetValue<string>() ?? "",
                ["state"] = ship["state"]?.GetValue<string>() ?? "", ["pincode"] = ship["pincode"]?.GetValue<string>() ?? "",
                ["address"] = string.Join(", ", new[] { "line1", "line2", "landmark" }.Select(k => ship[k]?.GetValue<string>()).Where(v => !string.IsNullOrEmpty(v))),
            },
            ["packages"] = packages, ["items"] = items, ["payments"] = payments, ["refunds"] = refunds,
            ["returns"] = returns, ["timeline"] = timeline,
        };
    }

    private sealed class OrderRow
    {
        public string Id { get; set; } = "";
        public string Number { get; set; } = "";
        public string Status { get; set; } = "";
        public string PaymentMethod { get; set; } = "";
        public string PaymentStatus { get; set; } = "";
        public long GrandTotal { get; set; }
        public long ItemsTotal { get; set; }
        public long ShippingTotal { get; set; }
        public long DiscountTotal { get; set; }
        public string? Coupon { get; set; }
        public long RefundedTotal { get; set; }
        public string UserId { get; set; } = "";
        public string? ShipTo { get; set; }
        public DateTime PlacedAt { get; set; }
    }

    private sealed class UserRow
    {
        public string Id { get; set; } = "";
        public string? Name { get; set; }
        public string? Phone { get; set; }
        public string? Email { get; set; }
    }

    private sealed class PackageDetailRow
    {
        public string Id { get; set; } = "";
        public string Package { get; set; } = "";
        public string Seller { get; set; } = "";
        public string Status { get; set; } = "";
        public long Total { get; set; }
        public long Commission { get; set; }
        public long SellerPayout { get; set; }
        public string? Courier { get; set; }
        public string? Awb { get; set; }
        public DateTime? ShippedAt { get; set; }
        public DateTime? DeliveredAt { get; set; }
        public string? CancelReason { get; set; }
        public string? Invoice { get; set; }
    }

    private sealed class ItemRow
    {
        public string Sku { get; set; } = "";
        public string Title { get; set; } = "";
        public string? VariantLabel { get; set; }
        public int Qty { get; set; }
        public long UnitPrice { get; set; }
        public long LineTotal { get; set; }
        public int ReturnedQty { get; set; }
    }

    private sealed class PaymentRow
    {
        public string Status { get; set; } = "";
        public string Method { get; set; } = "";
        public long Amount { get; set; }
        public string? GatewayId { get; set; }
    }

    private sealed class RefundRow
    {
        public string Id { get; set; } = "";
        public long Amount { get; set; }
        public string Status { get; set; } = "";
        public string? Reason { get; set; }
        public int Attempts { get; set; }
    }

    private sealed class ReturnRow
    {
        public string Number { get; set; } = "";
        public string Status { get; set; } = "";
        public string? Reason { get; set; }
        public long RefundAmount { get; set; }
    }

    private sealed class EventRow
    {
        public DateTime At { get; set; }
        public string? FromStatus { get; set; }
        public string ToStatus { get; set; } = "";
        public string? Actor { get; set; }
        public string? Note { get; set; }
    }
}
