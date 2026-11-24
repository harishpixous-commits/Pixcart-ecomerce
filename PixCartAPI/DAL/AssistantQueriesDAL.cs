namespace DAL;

using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

using Model.Constants;
using Utils;
using Utils.Interface;

/// <summary>
/// The assistant's read-only data lookups (reference: app/assistant/queries.py). Every amount is in paise;
/// display helpers format with Indian digit grouping exactly like the reference.
/// </summary>
public partial class AssistantQueriesDAL(IMySqlDapperHelper db)
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    /// <summary>Reference: queries.inr — ₹ with Indian digit grouping (1234567.5 → ₹12,34,567.50).</summary>
    public static string Inr(double paise)
    {
        var value = paise / 100;
        var sign = value < 0 ? "-" : "";
        var parts = Math.Abs(value).ToString("0.00", CultureInfo.InvariantCulture).Split('.');
        var whole = parts[0];
        if (whole.Length > 3)
        {
            var head = whole[..^3];
            var tail = whole[^3..];
            var groups = new List<string>();
            while (head.Length > 2)
            {
                groups.Insert(0, head[^2..]);
                head = head[..^2];
            }
            if (head.Length > 0) groups.Insert(0, head);
            whole = string.Join(",", groups) + "," + tail;
        }
        return $"{sign}₹{whole}.{parts[1]}";
    }

    public static string Num(double n) => n == Math.Floor(n) ? Inr(n * 100)[1..^3] : n.ToString("#,0.00", CultureInfo.InvariantCulture);

    public static double Pct(double a, double b) => b != 0 ? Math.Round(a * 100 / b, 1) : 0.0;

    public static string IstFmt(DateTime? dt) =>
        dt is null ? "" : (dt.Value + Ist).ToString("dd MMM yyyy, hh:mm tt", CultureInfo.InvariantCulture);

    public static string IstDay(DateTime? dt) =>
        dt is null ? "" : (dt.Value + Ist).ToString("dd MMM yyyy", CultureInfo.InvariantCulture);

    /// <summary>Reference: queries._like — escapes LIKE wildcards (used with ESCAPE '\').</summary>
    public static string Like(string text) =>
        "%" + Regex.Replace(text.Trim(), @"([\\%_])", "\\$1") + "%";

    private const string LivePackage = "s.status != 'pending_payment'";

    // ----------------------------------------------------------------------------- sales

    /// <summary>Period + filter WHERE over sub_orders s (reference: queries._sub_filters).</summary>
    private static string SubFilters(AssistantPeriods.Period period, Guid? sellerId, Guid? categoryId, string? paymentMethod, string? stateCode, out object param)
    {
        var where = $"{LivePackage} AND s.created_at >= @Start AND s.created_at < @End";
        if (sellerId is not null) where += " AND s.seller_id = @SellerId";
        if (paymentMethod is not null) where += " AND s.order_id IN (SELECT id FROM orders WHERE payment_method = @PaymentMethod)";
        if (stateCode is not null) where += " AND s.order_id IN (SELECT id FROM orders WHERE ship_to->>'$.state_code' = @StateCode)";
        if (categoryId is not null) where += " AND s.id IN (SELECT oi.sub_order_id FROM order_items oi JOIN products pr ON pr.id = oi.product_id WHERE pr.category_id = @CategoryId)";
        param = new { Start = period.Start, End = period.End, SellerId = sellerId, CategoryId = categoryId, PaymentMethod = paymentMethod, StateCode = stateCode };
        return where;
    }

    private sealed class SalesRow
    {
        public long Orders { get; set; }
        public long Packages { get; set; }
        public long Gmv { get; set; }
        public long Cancelled { get; set; }
        public long CancelledValue { get; set; }
        public long Commission { get; set; }
        public long Discounts { get; set; }
        public long Returned { get; set; }
        public long Tcs { get; set; }
        public long Shipping { get; set; }
        public long Delivered { get; set; }
    }

    /// <summary>Reference: queries.sales_summary.</summary>
    public async Task<JsonObject> SalesSummaryAsync(AssistantPeriods.Period period, Guid? sellerId = null, Guid? categoryId = null,
        string? paymentMethod = null, string? stateCode = null)
    {
        var where = SubFilters(period, sellerId, categoryId, paymentMethod, stateCode, out var p);
        var r = await db.QueryFirstOrDefaultAsync<SalesRow>(
            "SELECT COUNT(DISTINCT s.order_id) AS Orders, COUNT(s.id) AS Packages," +
            " COALESCE(SUM(IF(s.status != 'cancelled', s.total, 0)), 0) AS Gmv," +
            " COALESCE(SUM(IF(s.status = 'cancelled', 1, 0)), 0) AS Cancelled," +
            " COALESCE(SUM(IF(s.status = 'cancelled', s.total, 0)), 0) AS CancelledValue," +
            " COALESCE(SUM(IF(s.status != 'cancelled', s.commission_paise, 0)), 0) AS Commission," +
            " COALESCE(SUM(IF(s.status != 'cancelled', s.platform_discount + s.seller_discount, 0)), 0) AS Discounts," +
            " COALESCE(SUM(s.returned_total), 0) AS Returned," +
            " COALESCE(SUM(IF(s.status != 'cancelled', s.tcs_paise, 0)), 0) AS Tcs," +
            " COALESCE(SUM(IF(s.status != 'cancelled', s.shipping_fee, 0)), 0) AS Shipping," +
            " COALESCE(SUM(IF(s.status = 'delivered', 1, 0)), 0) AS Delivered" +
            $" FROM sub_orders s WHERE {where}", p) ?? new SalesRow();
        var units = await db.ExecuteScalarAsync<long>(
            "SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN sub_orders s ON s.id = oi.sub_order_id" +
            $" WHERE {where} AND s.status != 'cancelled'", p);
        var mix = (await db.QueryAsync<CountByRow>(
            $"SELECT o.payment_method AS K, COUNT(DISTINCT o.id) AS C FROM orders o JOIN sub_orders s ON s.order_id = o.id WHERE {where} GROUP BY o.payment_method", p))
            .ToDictionary(x => x.K, x => x.C);
        var o = new JsonObject
        {
            ["period"] = period.AsDict(),
            ["sales"] = r.Gmv, ["orders"] = r.Orders, ["packages"] = r.Packages, ["units"] = units,
            ["average_order_value"] = r.Orders > 0 ? r.Gmv / r.Orders : 0,
            ["net_sales"] = r.Gmv - r.Returned, ["returned_value"] = r.Returned,
            ["cancelled_packages"] = r.Cancelled, ["cancelled_value"] = r.CancelledValue,
            ["cancellation_rate_pct"] = Pct(r.Cancelled, r.Packages),
            ["commission"] = r.Commission, ["discounts"] = r.Discounts, ["delivery_fees"] = r.Shipping,
            ["tcs_collected"] = r.Tcs, ["delivered_packages"] = r.Delivered,
            ["cod_orders"] = mix.GetValueOrDefault("cod"), ["online_orders"] = mix.GetValueOrDefault("online"),
        };
        if (sellerId is null && categoryId is null && paymentMethod is null && stateCode is null)
        {
            o["new_customers"] = await db.ExecuteScalarAsync<long>(
                "SELECT COUNT(*) FROM users WHERE created_at >= @Start AND created_at < @End AND is_admin = 0", p);
            o["refunds_paid"] = await db.ExecuteScalarAsync<long>(
                "SELECT COALESCE(SUM(amount_paise), 0) FROM refunds WHERE status = 'processed' AND updated_at >= @Start AND updated_at < @End", p);
            o["awaiting_payment_orders"] = await db.ExecuteScalarAsync<long>(
                "SELECT COUNT(*) FROM orders WHERE status = 'pending_payment' AND created_at >= @Start AND created_at < @End", p);
        }
        return o;
    }

    public static readonly string[] Breakdowns = ["day", "week", "month", "hour", "seller", "category", "product", "state", "payment_method", "status"];

    private sealed class CountByRow
    {
        public string K { get; set; } = "";
        public long C { get; set; }
    }

    private sealed class KeySalesRow
    {
        public string K { get; set; } = "";
        public long Sales { get; set; }
        public long Orders { get; set; }
    }

    /// <summary>Reference: queries.sales_breakdown.</summary>
    public async Task<JsonObject> SalesBreakdownAsync(AssistantPeriods.Period period, string by, Guid? sellerId = null,
        Guid? categoryId = null, string? paymentMethod = null, int limit = 20)
    {
        if (!Breakdowns.Contains(by))
            throw new AppException($"Group by one of: {string.Join(", ", Breakdowns)}", "bad_breakdown");
        var where = SubFilters(period, sellerId, categoryId, paymentMethod, null, out var p);
        limit = Math.Max(1, Math.Min(limit, 100));
        const string sales = "COALESCE(SUM(IF(s.status != 'cancelled', s.total, 0)), 0)";
        const string orders = "COUNT(DISTINCT s.order_id)";
        const string local = "CONVERT_TZ(s.created_at, '+00:00', '+05:30')";
        var items = new JsonArray();
        if (by is "day" or "week" or "month" or "hour")
        {
            var trunc = by switch
            {
                "day" => $"DATE({local})",
                "week" => $"DATE(DATE_SUB({local}, INTERVAL WEEKDAY({local}) DAY))",
                "month" => $"DATE_FORMAT({local}, '%Y-%m-01')",
                _ => $"HOUR({local})",
            };
            var rows = await db.QueryAsync<KeySalesRow>(
                $"SELECT CAST({trunc} AS CHAR) AS K, {sales} AS Sales, {orders} AS Orders FROM sub_orders s WHERE {where} GROUP BY K ORDER BY K", p);
            var got = rows.ToDictionary(r => r.K, r => (r.Sales, r.Orders));
            if (by == "day")
                for (var i = 0; i < period.Days; i++)
                {
                    var d = period.FirstDay.AddDays(i);
                    var (s, oc) = got.GetValueOrDefault(d.ToString("yyyy-MM-dd"));
                    items.Add(new JsonObject { ["label"] = d.ToString("dd MMM", CultureInfo.InvariantCulture), ["key"] = d.ToString("yyyy-MM-dd"), ["sales"] = s, ["orders"] = oc });
                }
            else if (by == "hour")
                for (var h = 0; h < 24; h++)
                {
                    var (s, oc) = got.GetValueOrDefault(h.ToString(CultureInfo.InvariantCulture));
                    items.Add(new JsonObject { ["label"] = $"{h:D2}:00", ["key"] = h.ToString(CultureInfo.InvariantCulture), ["sales"] = s, ["orders"] = oc });
                }
            else
                foreach (var (k, (s, oc)) in got.OrderBy(kv => kv.Key))
                {
                    var d = DateOnly.ParseExact(k, "yyyy-MM-dd", CultureInfo.InvariantCulture);
                    items.Add(new JsonObject
                    {
                        ["label"] = by == "month" ? d.ToString("MMM yyyy", CultureInfo.InvariantCulture) : "Week of " + d.ToString("dd MMM", CultureInfo.InvariantCulture),
                        ["key"] = k, ["sales"] = s, ["orders"] = oc,
                    });
                }
            return new JsonObject { ["period"] = period.AsDict(), ["by"] = by, ["items"] = items };
        }
        if (by is "category" or "product")
        {
            var nameCol = by == "category" ? "c.name" : "oi.title";
            var join = by == "category" ? "JOIN products pr ON pr.id = oi.product_id JOIN categories c ON c.id = pr.category_id" : "";
            var rows = await db.QueryAsync<NameSalesUnitsRow>(
                $"SELECT {nameCol} AS N, COALESCE(SUM(oi.line_total - oi.seller_discount), 0) AS S, COALESCE(SUM(oi.qty), 0) AS U" +
                $" FROM order_items oi JOIN sub_orders s ON s.id = oi.sub_order_id {join} WHERE {where} AND s.status != 'cancelled'" +
                $" GROUP BY {nameCol} ORDER BY S DESC LIMIT {limit}", p);
            foreach (var r in rows)
                items.Add(new JsonObject { ["label"] = r.N ?? "—", ["sales"] = r.S, ["units"] = r.U });
            return new JsonObject { ["period"] = period.AsDict(), ["by"] = by, ["items"] = items };
        }
        var sql = by switch
        {
            "seller" => $"SELECT se.display_name AS K, {sales} AS Sales, {orders} AS Orders FROM sub_orders s JOIN sellers se ON se.id = s.seller_id WHERE {where} GROUP BY se.display_name ORDER BY Sales DESC LIMIT {limit}",
            "status" => $"SELECT s.status AS K, COALESCE(SUM(s.total), 0) AS Sales, {orders} AS Orders FROM sub_orders s WHERE {where} GROUP BY s.status ORDER BY Orders DESC LIMIT {limit}",
            "payment_method" => $"SELECT o.payment_method AS K, {sales} AS Sales, {orders} AS Orders FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE {where} GROUP BY o.payment_method ORDER BY Sales DESC LIMIT {limit}",
            _ => $"SELECT o.ship_to->>'$.state_code' AS K, {sales} AS Sales, {orders} AS Orders FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE {where} GROUP BY K ORDER BY Sales DESC LIMIT {limit}",
        };
        foreach (var r in await db.QueryAsync<KeySalesRow>(sql, p))
        {
            var label = by == "state" ? (IndianStates.Names.GetValueOrDefault(r.K ?? "", string.IsNullOrEmpty(r.K) ? "Unknown" : r.K))
                : by == "payment_method" ? (r.K == "cod" ? "Cash on delivery" : r.K == "online" ? "Paid online" : r.K)
                : r.K;
            items.Add(new JsonObject { ["label"] = string.IsNullOrEmpty(label) ? "—" : label, ["sales"] = r.Sales, ["orders"] = r.Orders });
        }
        return new JsonObject { ["period"] = period.AsDict(), ["by"] = by, ["items"] = items };
    }

    private sealed class NameSalesUnitsRow
    {
        public string? N { get; set; }
        public long S { get; set; }
        public long U { get; set; }
    }

    // ----------------------------------------------------------------------------- work queue

    /// <summary>Reference: queries.pending_work — the queue of things waiting for staff.</summary>
    public async Task<JsonObject> PendingWorkAsync()
    {
        var now = DateTimeFunctions.UtcNow();
        Task<long> Count(string sql, object? prm = null) => db.ExecuteScalarAsync<long>(sql, prm);
        return new JsonObject
        {
            ["sellers_to_review"] = await Count("SELECT COUNT(*) FROM sellers WHERE status = 'submitted'"),
            ["listings_to_review"] = await Count("SELECT COUNT(*) FROM products WHERE status = 'pending'"),
            ["packages_late_to_ship_48h"] = await Count(
                "SELECT COUNT(*) FROM sub_orders WHERE status IN ('placed','confirmed','packed') AND created_at < @Late", new { Late = now.AddHours(-48) }),
            ["returns_waiting"] = await Count("SELECT COUNT(*) FROM return_requests WHERE status IN ('requested','received')"),
            ["refunds_failed"] = await Count("SELECT COUNT(*) FROM refunds WHERE status = 'failed'"),
            ["tickets_reply_overdue"] = await Count(
                "SELECT COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed') AND acknowledged_at IS NULL AND ack_due_at < UTC_TIMESTAMP(6)"),
            ["tickets_open"] = await Count("SELECT COUNT(*) FROM support_tickets WHERE status = 'open'"),
            ["reviews_to_moderate"] = await Count("SELECT COUNT(*) FROM reviews WHERE status = 'pending'"),
            ["payouts_failed"] = await Count("SELECT COUNT(*) FROM payouts WHERE status = 'failed'"),
            ["out_of_stock_options"] = await Count(
                "SELECT COUNT(*) FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'approved' AND v.is_active = 1 AND v.stock <= 0"),
        };
    }
}
