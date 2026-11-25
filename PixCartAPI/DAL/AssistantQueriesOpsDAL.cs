namespace DAL;

using System.Text.Json.Nodes;

using Utils;
using Utils.Interface;

/// <summary>
/// Assistant lookup queries continued (reference: app/assistant/queries.py — returns, refunds, support tickets,
/// payouts, coupons).
/// </summary>
public partial class AssistantQueriesDAL
{
    /// <summary>Reference: queries.find_returns.</summary>
    public async Task<JsonObject> FindReturnsAsync(AssistantPeriods.Period? period, string? status = null, Guid? sellerId = null, int limit = 25)
    {
        var where = "1=1";
        var countsWhere = "1=1";
        var prm = new Dictionary<string, object?>();
        if (period is not null)
        {
            where += " AND r.created_at >= @Start AND r.created_at < @End";
            countsWhere += " AND created_at >= @Start AND created_at < @End";
            prm["Start"] = period.Start; prm["End"] = period.End;
        }
        if (status is not null) { where += " AND r.status = @Status"; prm["Status"] = status; }
        if (sellerId is not null) { where += " AND r.seller_id = @SellerId"; prm["SellerId"] = sellerId; }
        var from = "FROM return_requests r JOIN sub_orders s ON s.id = r.sub_order_id JOIN sellers se ON se.id = r.seller_id";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from} WHERE {where}", prm);
        var counts = (await db.QueryAsync<StatusCRow>(
            $"SELECT status AS Status, COUNT(*) AS C FROM return_requests WHERE {countsWhere} GROUP BY status", prm))
            .ToDictionary(x => x.Status, x => x.C);
        var reasons = (await db.QueryAsync<ReasonCRow>(
            $"SELECT reason AS Reason, COUNT(*) AS C FROM return_requests WHERE {countsWhere} GROUP BY reason", prm))
            .ToDictionary(x => x.Reason ?? "", x => x.C);
        var rows = await db.QueryAsync<ReturnItemRow>(
            "SELECT CAST(r.id AS CHAR) AS Id, r.number AS Number, s.number AS Package, se.display_name AS Seller, r.created_at AS CreatedAt," +
            $" r.status AS Status, r.reason AS Reason, r.refund_amount AS RefundAmount {from} WHERE {where} ORDER BY r.created_at DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["id"] = r.Id, ["number"] = r.Number, ["package"] = r.Package, ["seller"] = r.Seller,
                ["requested"] = IstFmt(r.CreatedAt), ["status"] = r.Status, ["reason"] = r.Reason, ["refund_amount"] = r.RefundAmount,
            });
        var byStatus = new JsonObject();
        foreach (var (k, v) in counts) byStatus[k] = v;
        var byReason = new JsonObject();
        foreach (var (k, v) in reasons) byReason[k] = v;
        return new JsonObject { ["period"] = PeriodOrNull(period), ["total"] = total, ["by_status"] = byStatus, ["by_reason"] = byReason, ["items"] = items };
    }

    private sealed class ReturnItemRow
    {
        public string Id { get; set; } = "";
        public string Number { get; set; } = "";
        public string Package { get; set; } = "";
        public string Seller { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public string Status { get; set; } = "";
        public string? Reason { get; set; }
        public long RefundAmount { get; set; }
    }

    /// <summary>Reference: queries.find_refunds.</summary>
    public async Task<JsonObject> FindRefundsAsync(string? status = null, AssistantPeriods.Period? period = null, int limit = 25)
    {
        var where = "1=1";
        var prm = new Dictionary<string, object?>();
        if (status is not null) { where += " AND r.status = @Status"; prm["Status"] = status; }
        if (period is not null)
        {
            where += " AND r.created_at >= @Start AND r.created_at < @End";
            prm["Start"] = period.Start; prm["End"] = period.End;
        }
        var from = "FROM refunds r JOIN orders o ON o.id = r.order_id";
        var counts = (await db.QueryAsync<StatusCRow>(
            "SELECT status AS Status, COUNT(*) AS C FROM refunds GROUP BY status")).ToDictionary(x => x.Status, x => x.C);
        var totalValue = await db.ExecuteScalarAsync<long>($"SELECT COALESCE(SUM(r.amount_paise), 0) {from} WHERE {where}", prm);
        var rows = await db.QueryAsync<RefundItemRow>(
            $"SELECT CAST(r.id AS CHAR) AS Id, o.number AS OrderNumber, r.amount_paise AS Amount, r.status AS Status, r.reason AS Reason," +
            $" r.attempts AS Attempts, r.last_error AS LastError, r.created_at AS CreatedAt {from} WHERE {where} ORDER BY r.created_at DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["id"] = r.Id, ["order"] = r.OrderNumber, ["amount"] = r.Amount, ["status"] = r.Status, ["reason"] = r.Reason,
                ["attempts"] = r.Attempts,
                ["last_error"] = r.LastError is { Length: > 120 } e ? e[..120] : r.LastError ?? "",
                ["created"] = IstFmt(r.CreatedAt),
            });
        var byStatus = new JsonObject();
        foreach (var (k, v) in counts) byStatus[k] = v;
        return new JsonObject { ["by_status"] = byStatus, ["total_value"] = totalValue, ["items"] = items };
    }

    private sealed class RefundItemRow
    {
        public string Id { get; set; } = "";
        public string OrderNumber { get; set; } = "";
        public long Amount { get; set; }
        public string Status { get; set; } = "";
        public string? Reason { get; set; }
        public int Attempts { get; set; }
        public string? LastError { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    /// <summary>Reference: queries.find_tickets.</summary>
    public async Task<JsonObject> FindTicketsAsync(string? status = null, bool overdueOnly = false, string? q = null, int limit = 25)
    {
        var where = "1=1";
        var prm = new Dictionary<string, object?>();
        if (status is not null) { where += " AND t.status = @Status"; prm["Status"] = status; }
        if (overdueOnly)
            where += " AND t.status NOT IN ('resolved','closed') AND ((t.acknowledged_at IS NULL AND t.ack_due_at < UTC_TIMESTAMP(6)) OR t.resolve_due_at < UTC_TIMESTAMP(6))";
        if (q is not null) { where += " AND (t.number LIKE @Q OR t.subject LIKE @Q)"; prm["Q"] = Like(q); }
        var from = "FROM support_tickets t LEFT JOIN orders o ON o.id = t.order_id";
        var counts = (await db.QueryAsync<StatusCRow>(
            "SELECT status AS Status, COUNT(*) AS C FROM support_tickets GROUP BY status")).ToDictionary(x => x.Status, x => x.C);
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from} WHERE {where}", prm);
        var rows = await db.QueryAsync<TicketItemRow>(
            "SELECT CAST(t.id AS CHAR) AS Id, t.number AS Number, t.subject AS Subject, t.category AS Category, t.status AS Status," +
            " t.priority AS Priority, t.is_grievance AS Grievance, t.created_at AS CreatedAt, o.number AS OrderNumber," +
            $" t.ack_due_at AS ReplyDue, t.acknowledged_at AS Replied, t.resolve_due_at AS ResolveDue {from} WHERE {where}" +
            $" ORDER BY t.created_at DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var t in rows)
            items.Add(new JsonObject
            {
                ["id"] = t.Id, ["number"] = t.Number, ["subject"] = t.Subject, ["category"] = t.Category, ["status"] = t.Status,
                ["priority"] = t.Priority, ["grievance"] = t.Grievance, ["opened"] = IstFmt(t.CreatedAt),
                ["order"] = t.OrderNumber ?? "", ["reply_due"] = IstFmt(t.ReplyDue), ["replied"] = IstFmt(t.Replied),
                ["resolve_due"] = IstFmt(t.ResolveDue),
            });
        var byStatus = new JsonObject();
        foreach (var (k, v) in counts) byStatus[k] = v;
        return new JsonObject { ["by_status"] = byStatus, ["total"] = total, ["items"] = items };
    }

    private sealed class TicketItemRow
    {
        public string Id { get; set; } = "";
        public string Number { get; set; } = "";
        public string Subject { get; set; } = "";
        public string Category { get; set; } = "";
        public string Status { get; set; } = "";
        public string Priority { get; set; } = "";
        public bool Grievance { get; set; }
        public DateTime CreatedAt { get; set; }
        public string? OrderNumber { get; set; }
        public DateTime? ReplyDue { get; set; }
        public DateTime? Replied { get; set; }
        public DateTime? ResolveDue { get; set; }
    }

    /// <summary>Reference: queries.payouts_overview.</summary>
    public async Task<JsonObject> PayoutsOverviewAsync(string? status = null, int limit = 25)
    {
        var due = (await db.QueryAsync<SellerAmountRow>(
            "SELECT se.display_name AS Seller, SUM(le.amount) AS Amount FROM seller_ledger le JOIN sellers se ON se.id = le.seller_id" +
            " WHERE le.payout_id IS NULL AND le.available_at <= UTC_TIMESTAMP(6) GROUP BY se.display_name HAVING Amount > 0 ORDER BY Amount DESC")).ToList();
        var onHold = await db.ExecuteScalarAsync<long>(
            "SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE payout_id IS NULL AND available_at > UTC_TIMESTAMP(6)");
        var where = "1=1";
        var prm = new Dictionary<string, object?>();
        if (status is not null) { where += " AND p.status = @Status"; prm["Status"] = status; }
        var counts = (await db.QueryAsync<StatusCRow>(
            "SELECT status AS Status, COUNT(*) AS C FROM payouts GROUP BY status")).ToDictionary(x => x.Status, x => x.C);
        var rows = await db.QueryAsync<PayoutRow>(
            "SELECT p.number AS Number, se.display_name AS Seller, p.amount AS Amount, p.status AS Status, p.mode AS Mode, p.utr AS Utr," +
            " p.created_at AS CreatedAt, p.paid_at AS PaidAt, p.failure_reason AS Failure" +
            $" FROM payouts p JOIN sellers se ON se.id = p.seller_id WHERE {where} ORDER BY p.created_at DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var dueNow = new JsonArray();
        foreach (var d in due.Take(50))
            dueNow.Add(new JsonObject { ["seller"] = d.Seller, ["amount"] = d.Amount });
        var items = new JsonArray();
        foreach (var p in rows)
            items.Add(new JsonObject
            {
                ["number"] = p.Number, ["seller"] = p.Seller, ["amount"] = p.Amount, ["status"] = p.Status, ["mode"] = p.Mode,
                ["utr"] = p.Utr, ["created"] = IstDay(p.CreatedAt), ["paid"] = IstDay(p.PaidAt), ["failure"] = p.Failure,
            });
        var byStatus = new JsonObject();
        foreach (var (k, v) in counts) byStatus[k] = v;
        return new JsonObject
        {
            ["due_now_total"] = due.Sum(d => d.Amount), ["due_now"] = dueNow, ["on_hold_total"] = onHold,
            ["by_status"] = byStatus, ["items"] = items,
        };
    }

    private sealed class PayoutRow
    {
        public string Number { get; set; } = "";
        public string Seller { get; set; } = "";
        public long Amount { get; set; }
        public string Status { get; set; } = "";
        public string? Mode { get; set; }
        public string? Utr { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? PaidAt { get; set; }
        public string? Failure { get; set; }
    }

    /// <summary>Reference: queries.coupons_overview.</summary>
    public async Task<JsonObject> CouponsOverviewAsync(bool activeOnly = false)
    {
        var rows = await db.QueryAsync<CouponRow>(
            "SELECT code AS Code, kind AS Kind, value AS Value, min_order_paise AS MinOrder, max_discount_paise AS MaxDiscount," +
            " is_active AS Active, used_count AS Used, usage_limit AS UsageLimit, ends_at AS EndsAt, funded_by AS FundedBy" +
            $" FROM coupons {(activeOnly ? "WHERE is_active = 1 " : "")}ORDER BY created_at DESC LIMIT 100");
        var items = new JsonArray();
        foreach (var c in rows)
            items.Add(new JsonObject
            {
                ["code"] = c.Code, ["kind"] = c.Kind, ["value"] = c.Value, ["min_order"] = c.MinOrder,
                ["max_discount"] = c.MaxDiscount, ["active"] = c.Active, ["used"] = c.Used, ["usage_limit"] = c.UsageLimit,
                ["ends"] = IstDay(c.EndsAt), ["funded_by"] = c.FundedBy,
            });
        return new JsonObject { ["items"] = items };
    }

    private sealed class StatusCRow
    {
        public string Status { get; set; } = "";
        public long C { get; set; }
    }

    private sealed class ReasonCRow
    {
        public string? Reason { get; set; }
        public long C { get; set; }
    }

    private sealed class SellerAmountRow
    {
        public string Seller { get; set; } = "";
        public long Amount { get; set; }
    }

    private sealed class CouponRow
    {
        public string Code { get; set; } = "";
        public string Kind { get; set; } = "";
        public long Value { get; set; }
        public long MinOrder { get; set; }
        public long? MaxDiscount { get; set; }
        public bool Active { get; set; }
        public int Used { get; set; }
        public int? UsageLimit { get; set; }
        public DateTime? EndsAt { get; set; }
        public string FundedBy { get; set; } = "";
    }
}
