namespace DAL;

using System.Text.Json.Nodes;

using Model.Constants;
using Utils;
using Utils.Interface;

/// <summary>
/// Assistant lookup queries continued (reference: app/assistant/queries.py — customers, catalogue, sellers,
/// returns, refunds, tickets, payouts, coupons).
/// </summary>
public partial class AssistantQueriesDAL
{
    /// <summary>Reference: queries.find_customers.</summary>
    public async Task<JsonObject> FindCustomersAsync(string? q, AssistantPeriods.Period? period = null, string sort = "recent", int limit = 25)
    {
        var aggWhere = "o.status = 'placed'";
        var prm = new Dictionary<string, object?>();
        if (period is not null)
        {
            aggWhere += " AND o.placed_at >= @Start AND o.placed_at < @End";
            prm["Start"] = period.Start; prm["End"] = period.End;
        }
        var where = "u.is_admin = 0 AND u.deleted_at IS NULL";
        if (q is not null)
        {
            where += " AND (u.name LIKE @Q OR u.phone LIKE @Q OR u.email LIKE @Q)";
            prm["Q"] = Like(q);
        }
        var orderBy = "u.created_at DESC";
        if (sort == "top_spenders" || period is not null)
        {
            where += " AND agg.n IS NOT NULL";
            orderBy = "agg.spent DESC";
        }
        var from = "FROM users u LEFT JOIN (SELECT o.user_id, COUNT(*) AS n, COALESCE(SUM(o.grand_total - o.refunded_total), 0) AS spent," +
                   $" MAX(o.placed_at) AS last FROM orders o WHERE {aggWhere} GROUP BY o.user_id) agg ON agg.user_id = u.id";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from} WHERE {where}", prm);
        var rows = await db.QueryAsync<CustomerRow>(
            "SELECT CAST(u.id AS CHAR) AS Id, u.name AS Name, u.phone AS Phone, u.email AS Email, u.created_at AS JoinedAt," +
            " u.is_active AS Active, COALESCE(agg.n, 0) AS Orders, agg.spent AS Spent, agg.last AS LastOrder" +
            $" {from} WHERE {where} ORDER BY {orderBy} LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["id"] = r.Id, ["name"] = r.Name ?? "", ["phone"] = r.Phone ?? "", ["email"] = r.Email ?? "",
                ["joined"] = IstDay(r.JoinedAt), ["orders"] = r.Orders, ["spent"] = r.Spent ?? 0,
                ["last_order"] = IstDay(r.LastOrder), ["active"] = r.Active,
            });
        return new JsonObject { ["period"] = PeriodOrNull(period), ["total"] = total, ["items"] = items };
    }

    private sealed class CustomerRow
    {
        public string Id { get; set; } = "";
        public string? Name { get; set; }
        public string? Phone { get; set; }
        public string? Email { get; set; }
        public DateTime JoinedAt { get; set; }
        public bool Active { get; set; }
        public long Orders { get; set; }
        public long? Spent { get; set; }
        public DateTime? LastOrder { get; set; }
    }

    /// <summary>Reference: queries.customer_detail — finds by email, phone digits, id or unique name match.</summary>
    public async Task<JsonObject?> CustomerDetailAsync(string reference)
    {
        var cref = reference.Trim();
        var digits = new string(cref.Where(char.IsDigit).ToArray());
        var conds = new List<string> { "u.email = @Email" };
        var prm = new Dictionary<string, object?> { ["Email"] = cref.ToLowerInvariant() };
        if (digits.Length >= 10) { conds.Add("u.phone = @Phone"); prm["Phone"] = digits[^10..]; }
        if (Guid.TryParse(cref, out var uid)) { conds.Add("u.id = @Id"); prm["Id"] = uid.ToString(); }
        var u = await db.QueryFirstOrDefaultAsync<CustomerDetailRow>(
            "SELECT CAST(u.id AS CHAR) AS Id, u.name AS Name, u.phone AS Phone, u.email AS Email, u.created_at AS JoinedAt," +
            " u.is_active AS Active, u.marketing_opt_in AS MarketingConsent, u.last_login_at AS LastLoginAt" +
            $" FROM users u WHERE ({string.Join(" OR ", conds)}) AND u.is_admin = 0 LIMIT 1", prm);
        if (u is null)
        {
            var byName = (await db.QueryAsync<CustomerDetailRow>(
                "SELECT CAST(u.id AS CHAR) AS Id, u.name AS Name, u.phone AS Phone, u.email AS Email, u.created_at AS JoinedAt," +
                " u.is_active AS Active, u.marketing_opt_in AS MarketingConsent, u.last_login_at AS LastLoginAt" +
                " FROM users u WHERE u.name LIKE @Q AND u.is_admin = 0 LIMIT 2", new { Q = Like(cref) })).ToList();
            if (byName.Count != 1) return null;
            u = byName[0];
        }
        var o = await db.QueryFirstOrDefaultAsync<CustomerOrderAgg>(
            "SELECT COUNT(*) AS Orders, COALESCE(SUM(grand_total - refunded_total), 0) AS NetSpend, MIN(placed_at) AS FirstOrder, MAX(placed_at) AS LastOrder" +
            " FROM orders WHERE user_id = @Id AND status = 'placed'", new { Id = u.Id }) ?? new CustomerOrderAgg();
        var recent = new JsonArray();
        foreach (var r in await db.QueryAsync<RecentOrderRow>(
            "SELECT number AS Number, COALESCE(placed_at, created_at) AS PlacedAt, status AS Status, payment_method AS Payment, grand_total AS Total" +
            " FROM orders WHERE user_id = @Id ORDER BY created_at DESC LIMIT 10", new { Id = u.Id }))
            recent.Add(new JsonObject
            {
                ["number"] = r.Number, ["placed"] = IstDay(r.PlacedAt), ["status"] = r.Status, ["payment"] = r.Payment, ["total"] = r.Total,
            });
        var returns = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM return_requests rr JOIN sub_orders s ON s.id = rr.sub_order_id JOIN orders o ON o.id = s.order_id WHERE o.user_id = @Id",
            new { Id = u.Id });
        var cancelled = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE o.user_id = @Id AND s.status = 'cancelled'",
            new { Id = u.Id });
        var tickets = new JsonArray();
        foreach (var t in await db.QueryAsync<TicketRow>(
            "SELECT number AS Number, subject AS Subject, status AS Status FROM support_tickets WHERE user_id = @Id ORDER BY created_at DESC LIMIT 5",
            new { Id = u.Id }))
            tickets.Add(new JsonObject { ["number"] = t.Number, ["subject"] = t.Subject, ["status"] = t.Status });
        return new JsonObject
        {
            ["id"] = u.Id, ["name"] = u.Name ?? "", ["phone"] = u.Phone ?? "", ["email"] = u.Email ?? "",
            ["joined"] = IstDay(u.JoinedAt), ["active"] = u.Active, ["marketing_consent"] = u.MarketingConsent,
            ["last_login"] = IstFmt(u.LastLoginAt),
            ["orders"] = o.Orders, ["net_spend"] = o.NetSpend, ["first_order"] = IstDay(o.FirstOrder), ["last_order"] = IstDay(o.LastOrder),
            ["average_order_value"] = o.Orders > 0 ? o.NetSpend / o.Orders : 0,
            ["returns"] = returns, ["cancelled_packages"] = cancelled,
            ["recent_orders"] = recent, ["tickets"] = tickets,
        };
    }

    private sealed class CustomerDetailRow
    {
        public string Id { get; set; } = "";
        public string? Name { get; set; }
        public string? Phone { get; set; }
        public string? Email { get; set; }
        public DateTime JoinedAt { get; set; }
        public bool Active { get; set; }
        public bool MarketingConsent { get; set; }
        public DateTime? LastLoginAt { get; set; }
    }

    private sealed class CustomerOrderAgg
    {
        public long Orders { get; set; }
        public long NetSpend { get; set; }
        public DateTime? FirstOrder { get; set; }
        public DateTime? LastOrder { get; set; }
    }

    private sealed class RecentOrderRow
    {
        public string Number { get; set; } = "";
        public DateTime PlacedAt { get; set; }
        public string Status { get; set; } = "";
        public string Payment { get; set; } = "";
        public long Total { get; set; }
    }

    private sealed class TicketRow
    {
        public string Number { get; set; } = "";
        public string Subject { get; set; } = "";
        public string Status { get; set; } = "";
    }

    // ----------------------------------------------------------------------------- catalogue and stock

    /// <summary>Reference: queries.find_products.</summary>
    public async Task<JsonObject> FindProductsAsync(string? q = null, string? status = null, Guid? sellerId = null,
        Guid? categoryId = null, int? maxStock = null, string sort = "recent", int limit = 25)
    {
        var where = "1=1";
        var having = "";
        var prm = new Dictionary<string, object?>();
        if (status is not null) { where += " AND p.status = @Status"; prm["Status"] = status; }
        if (sellerId is not null) { where += " AND p.seller_id = @SellerId"; prm["SellerId"] = sellerId; }
        if (categoryId is not null) { where += " AND p.category_id = @CategoryId"; prm["CategoryId"] = categoryId; }
        if (q is not null)
        {
            where += " AND (p.title LIKE @Q OR p.brand LIKE @Q OR p.id IN (SELECT v2.product_id FROM variants v2 WHERE v2.sku LIKE @Q))";
            prm["Q"] = Like(q);
        }
        if (maxStock is not null) having = "HAVING stock <= @MaxStock";
        if (maxStock is not null) prm["MaxStock"] = maxStock.Value;
        var orderBy = sort switch
        {
            "best_selling" => "p.sold_count DESC",
            "rating" => "p.rating_avg DESC",
            "price_high" => "p.price_from DESC",
            "price_low" => "p.price_from ASC",
            "stock_low" => "stock ASC",
            _ => "p.updated_at DESC",
        };
        var from = "FROM products p JOIN sellers se ON se.id = p.seller_id JOIN categories c ON c.id = p.category_id" +
                   " LEFT JOIN variants v ON v.product_id = p.id AND v.is_active = 1";
        var select = "SELECT CAST(p.id AS CHAR) AS Id, p.title AS Title, MIN(v.sku) AS Sku, se.display_name AS Seller, c.name AS Category," +
                     " p.status AS Status, p.price_from AS Price, p.mrp_from AS Mrp, COALESCE(SUM(v.stock), 0) AS Stock," +
                     " p.sold_count AS Sold, p.rating_avg AS Rating, p.rating_count AS Reviews";
        var group = " GROUP BY p.id, se.display_name, c.name";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM ({select} {from} WHERE {where}{group} {having}) x", prm);
        var rows = await db.QueryAsync<ProductRow>(
            $"{select} {from} WHERE {where}{group} {having} ORDER BY {orderBy} LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["id"] = r.Id, ["title"] = r.Title, ["sku"] = r.Sku ?? "", ["seller"] = r.Seller, ["category"] = r.Category,
                ["status"] = r.Status, ["price"] = r.Price, ["mrp"] = r.Mrp, ["stock"] = r.Stock, ["sold"] = r.Sold,
                ["rating"] = (double)(r.Rating ?? 0), ["reviews"] = r.Reviews,
            });
        return new JsonObject { ["total"] = total, ["items"] = items };
    }

    private sealed class ProductRow
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string? Sku { get; set; }
        public string Seller { get; set; } = "";
        public string Category { get; set; } = "";
        public string Status { get; set; } = "";
        public long Price { get; set; }
        public long Mrp { get; set; }
        public long Stock { get; set; }
        public int Sold { get; set; }
        public decimal? Rating { get; set; }
        public int Reviews { get; set; }
    }

    /// <summary>Reference: queries.stock_alerts.</summary>
    public async Task<JsonObject> StockAlertsAsync(int threshold = 5, Guid? sellerId = null, int limit = 50)
    {
        var where = "p.status = 'approved' AND v.is_active = 1";
        var prm = new Dictionary<string, object?> { ["Threshold"] = threshold };
        if (sellerId is not null) { where += " AND v.seller_id = @SellerId"; prm["SellerId"] = sellerId; }
        var from = "FROM variants v JOIN products p ON p.id = v.product_id JOIN sellers se ON se.id = v.seller_id" +
                   " LEFT JOIN inventory_levels il ON il.variant_id = v.id";
        var select = "SELECT v.sku AS Sku, p.title AS Title, v.options AS Options, se.display_name AS Seller," +
                     " COALESCE(SUM(il.quantity), 0) AS Qty, p.sold_count AS Sold";
        var group = $" GROUP BY v.id, p.title, se.display_name, p.sold_count HAVING Qty <= {threshold}";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM ({select} {from} WHERE {where}{group}) x", prm);
        var rows = (await db.QueryAsync<StockRow>(
            $"{select} {from} WHERE {where}{group} ORDER BY Qty ASC, Sold DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm)).ToList();
        var items = new JsonArray();
        foreach (var r in rows)
        {
            var opts = string.IsNullOrEmpty(r.Options) ? new JsonObject() : JsonNode.Parse(r.Options)!.AsObject();
            items.Add(new JsonObject
            {
                ["sku"] = r.Sku, ["product"] = r.Title,
                ["option"] = string.Join(", ", opts.Select(kv => $"{kv.Key}: {kv.Value}")),
                ["seller"] = r.Seller, ["stock"] = r.Qty, ["sold"] = r.Sold,
            });
        }
        return new JsonObject
        {
            ["threshold"] = threshold, ["total"] = total, ["out_of_stock"] = rows.Count(r => r.Qty <= 0), ["items"] = items,
        };
    }

    private sealed class StockRow
    {
        public string Sku { get; set; } = "";
        public string Title { get; set; } = "";
        public string? Options { get; set; }
        public string Seller { get; set; } = "";
        public long Qty { get; set; }
        public int Sold { get; set; }
    }

    // ----------------------------------------------------------------------------- sellers

    /// <summary>Reference: queries.find_sellers.</summary>
    public async Task<JsonObject> FindSellersAsync(string? q = null, string? status = null, AssistantPeriods.Period? period = null, int limit = 25)
    {
        var salesWhere = "s.status != 'pending_payment'";
        var prm = new Dictionary<string, object?>();
        if (period is not null)
        {
            salesWhere += " AND s.created_at >= @Start AND s.created_at < @End";
            prm["Start"] = period.Start; prm["End"] = period.End;
        }
        var where = "1=1";
        if (status is not null) { where += " AND se.status = @Status"; prm["Status"] = status; }
        if (q is not null)
        {
            where += " AND (se.display_name LIKE @Q OR se.legal_name LIKE @Q OR se.gstin LIKE @Q OR se.pickup_city LIKE @Q)";
            prm["Q"] = Like(q);
        }
        var from = "FROM sellers se" +
                   $" LEFT JOIN (SELECT s.seller_id, COALESCE(SUM(s.total), 0) AS sales, COUNT(s.id) AS packages FROM sub_orders s WHERE {salesWhere} GROUP BY s.seller_id) sq ON sq.seller_id = se.id" +
                   " LEFT JOIN (SELECT p.seller_id, COUNT(*) AS n FROM products p WHERE p.status = 'approved' GROUP BY p.seller_id) live ON live.seller_id = se.id";
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {from} WHERE {where}", prm);
        var rows = await db.QueryAsync<SellerRow>(
            "SELECT CAST(se.id AS CHAR) AS Id, se.display_name AS Store, se.legal_name AS LegalName, se.status AS Status, se.pickup_city AS City," +
            " se.gstin AS Gstin, COALESCE(sq.sales, 0) AS Sales, COALESCE(sq.packages, 0) AS Packages, COALESCE(live.n, 0) AS LiveListings," +
            " se.rating_avg AS Rating, se.contact_phone AS Phone, se.contact_email AS Email" +
            $" {from} WHERE {where} ORDER BY sq.sales IS NULL, sq.sales DESC, se.created_at DESC LIMIT {Math.Max(1, Math.Min(limit, 200))}", prm);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["id"] = r.Id, ["store"] = r.Store, ["legal_name"] = r.LegalName, ["status"] = r.Status, ["city"] = r.City,
                ["gstin"] = r.Gstin ?? "", ["sales"] = r.Sales, ["packages"] = r.Packages, ["live_listings"] = r.LiveListings,
                ["rating"] = (double)(r.Rating ?? 0), ["phone"] = r.Phone, ["email"] = r.Email,
            });
        return new JsonObject { ["period"] = PeriodOrNull(period), ["total"] = total, ["items"] = items };
    }

    private sealed class SellerRow
    {
        public string Id { get; set; } = "";
        public string Store { get; set; } = "";
        public string? LegalName { get; set; }
        public string Status { get; set; } = "";
        public string? City { get; set; }
        public string? Gstin { get; set; }
        public long Sales { get; set; }
        public long Packages { get; set; }
        public long LiveListings { get; set; }
        public decimal? Rating { get; set; }
        public string? Phone { get; set; }
        public string? Email { get; set; }
    }

    /// <summary>Reference: queries.resolve_seller — by id, exact display name / GSTIN / legal name, or unique partial name.</summary>
    public async Task<string?> ResolveSellerIdAsync(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        var trimmed = reference.Trim();
        if (Guid.TryParse(trimmed, out var id))
        {
            var found = await db.ExecuteScalarAsync<string?>("SELECT CAST(id AS CHAR) FROM sellers WHERE id = @Id", new { Id = id.ToString() });
            if (found is not null) return found;
        }
        var exact = (await db.QueryAsync<string>(
            "SELECT CAST(id AS CHAR) FROM sellers WHERE display_name LIKE @R OR gstin = @G OR legal_name LIKE @R",
            new { R = trimmed, G = trimmed.ToUpperInvariant() })).ToList();
        if (exact.Count == 1) return exact[0];
        var partial = (await db.QueryAsync<string>("SELECT CAST(id AS CHAR) FROM sellers WHERE display_name LIKE @Q LIMIT 2", new { Q = Like(trimmed) })).ToList();
        return partial.Count == 1 ? partial[0] : null;
    }

    /// <summary>Reference: queries.resolve_category — by id, exact name / slug, or unique partial name.</summary>
    public async Task<string?> ResolveCategoryIdAsync(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        var trimmed = reference.Trim();
        if (Guid.TryParse(trimmed, out var id))
        {
            var found = await db.ExecuteScalarAsync<string?>("SELECT CAST(id AS CHAR) FROM categories WHERE id = @Id", new { Id = id.ToString() });
            if (found is not null) return found;
        }
        var exact = (await db.QueryAsync<string>(
            "SELECT CAST(id AS CHAR) FROM categories WHERE name LIKE @R OR slug = @S",
            new { R = trimmed, S = trimmed.ToLowerInvariant() })).ToList();
        if (exact.Count == 1) return exact[0];
        var partial = (await db.QueryAsync<string>("SELECT CAST(id AS CHAR) FROM categories WHERE name LIKE @Q LIMIT 2", new { Q = Like(trimmed) })).ToList();
        return partial.Count == 1 ? partial[0] : null;
    }

    /// <summary>Reference: queries.seller_detail.</summary>
    public async Task<JsonObject?> SellerDetailAsync(string sellerId, AssistantPeriods.Period period, JsonObject brief)
    {
        var s = await db.QueryFirstOrDefaultAsync<SellerDetailRow>(
            "SELECT CAST(id AS CHAR) AS Id, display_name AS Store, legal_name AS LegalName, status AS Status, gstin AS Gstin," +
            " pickup_city AS City, pickup_state_code AS StateCode, contact_phone AS Phone, contact_email AS Email, created_at AS JoinedAt," +
            " rating_avg AS Rating, rating_count AS RatingCount, holiday_mode AS HolidayMode, commission_bps_override AS CommissionBps" +
            " FROM sellers WHERE id = @Id", new { Id = sellerId });
        if (s is null) return null;
        var summary = await SalesSummaryAsync(period, Guid.Parse(s.Id));
        var now = DateTimeFunctions.UtcNow();
        var due = await db.ExecuteScalarAsync<long>(
            "SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE seller_id = @Id AND payout_id IS NULL AND available_at <= @Now",
            new { Id = s.Id, Now = now });
        var onHold = await db.ExecuteScalarAsync<long>(
            "SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE seller_id = @Id AND payout_id IS NULL AND available_at > @Now",
            new { Id = s.Id, Now = now });
        var counts = (await db.QueryAsync<StatusCountRow>(
            "SELECT status AS Status, COUNT(*) AS C FROM products WHERE seller_id = @Id GROUP BY status", new { Id = s.Id }))
            .ToDictionary(x => x.Status, x => x.C);
        var late = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders WHERE seller_id = @Id AND status IN ('placed','confirmed','packed') AND created_at < @Late",
            new { Id = s.Id, Late = now.AddHours(-48) });
        var listings = new JsonObject();
        foreach (var (k, v) in counts) listings[k] = v;
        var healthFactors = new JsonArray();
        if (brief["factors"] is JsonArray bf)
            foreach (var f in bf.Take(5)) healthFactors.Add(f?.DeepClone());
        return new JsonObject
        {
            ["id"] = s.Id, ["store"] = s.Store, ["legal_name"] = s.LegalName, ["status"] = s.Status, ["gstin"] = s.Gstin ?? "",
            ["city"] = s.City, ["state"] = IndianStates.Name(s.StateCode), ["phone"] = s.Phone, ["email"] = s.Email,
            ["joined"] = IstDay(s.JoinedAt), ["rating"] = (double)(s.Rating ?? 0), ["rating_count"] = s.RatingCount,
            ["holiday_mode"] = s.HolidayMode,
            ["commission_override_pct"] = s.CommissionBps is not null ? s.CommissionBps.Value / 100.0 : null,
            ["listings"] = listings, ["payout_due_now"] = due, ["payout_on_hold"] = onHold, ["packages_late_to_ship"] = late,
            ["sales"] = summary,
            ["health"] = new JsonObject
            {
                ["score"] = brief["score"]?.DeepClone(), ["level"] = brief["level"]?.DeepClone(),
                ["headline"] = brief["headline"]?.DeepClone(), ["factors"] = healthFactors,
            },
        };
    }

    private sealed class StatusCountRow
    {
        public string Status { get; set; } = "";
        public long C { get; set; }
    }

    private sealed class SellerDetailRow
    {
        public string Id { get; set; } = "";
        public string Store { get; set; } = "";
        public string? LegalName { get; set; }
        public string Status { get; set; } = "";
        public string? Gstin { get; set; }
        public string? City { get; set; }
        public string? StateCode { get; set; }
        public string? Phone { get; set; }
        public string? Email { get; set; }
        public DateTime JoinedAt { get; set; }
        public decimal? Rating { get; set; }
        public int RatingCount { get; set; }
        public bool HolidayMode { get; set; }
        public int? CommissionBps { get; set; }
    }
}
