using System.Globalization;
using System.Text.Json.Nodes;
using BAL.AI;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.Assistant;

/// <summary>
/// Read-only business figures behind the assistant's tools, computed in SQL (AssistantDAL). Definitions match the
/// dashboard: sales = package totals of placed orders excluding cancelled packages; orders = distinct orders with at
/// least one such package; net sales = sales minus returned value; average order value = sales ÷ orders. Amounts are
/// integer paise; dates are IST calendar days.
/// </summary>
public sealed class AssistantQueries(AssistantDAL dal, AiDAL ai)
{
    public static readonly string[] Breakdowns = ["day", "week", "month", "hour", "seller", "category", "product", "state", "payment_method", "status"];
    public static readonly string[] PackageStatuses = ["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"];
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static double Pct(double a, double b) => b != 0 ? Math.Round(a * 100 / b, 1) : 0.0;

    private static string State(string code) => RefData.States.Value.GetValueOrDefault(code ?? "", "");

    // ---------------------------------------------------------------- sales

    public async Task<JsonObject> SalesSummaryAsync(Period p, Guid? sellerId = null, Guid? categoryId = null, string? paymentMethod = null, string? stateCode = null)
    {
        var (t, units, mix) = await dal.SalesAsync(p.StartUtc, p.EndUtc, sellerId, categoryId, paymentMethod, stateCode);
        long orders = t.L("orders"), packages = t.L("packages"), gmv = t.L("gmv"), cancelled = t.L("cancelled");
        var outp = J.O(("period", p.AsDict()), ("sales", gmv), ("orders", orders), ("packages", packages), ("units", units),
            ("average_order_value", orders > 0 ? gmv / orders : 0), ("net_sales", gmv - t.L("returned")), ("returned_value", t.L("returned")),
            ("cancelled_packages", cancelled), ("cancelled_value", t.L("cancelled_value")), ("cancellation_rate_pct", Pct(cancelled, packages)),
            ("commission", t.L("commission")), ("discounts", t.L("discounts")), ("delivery_fees", t.L("shipping")), ("tcs_collected", t.L("tcs")),
            ("delivered_packages", t.L("delivered")), ("cod_orders", mix.GetValueOrDefault("cod")), ("online_orders", mix.GetValueOrDefault("online")));
        if (sellerId is null && categoryId is null && string.IsNullOrEmpty(paymentMethod) && string.IsNullOrEmpty(stateCode))
        {
            var (nc, rp, ap) = await dal.SalesExtrasAsync(p.StartUtc, p.EndUtc);
            outp["new_customers"] = nc;
            outp["refunds_paid"] = rp;
            outp["awaiting_payment_orders"] = ap;
        }
        return outp;
    }

    public async Task<JsonObject> SalesBreakdownAsync(Period p, string by, Guid? sellerId = null, Guid? categoryId = null, string? paymentMethod = null, int limit = 20)
    {
        if (!Breakdowns.Contains(by)) throw new ArgumentException($"Group by one of: {string.Join(", ", Breakdowns)}");
        limit = Math.Clamp(limit, 1, 100);
        var rows = await dal.BreakdownAsync(by, p.StartUtc, p.EndUtc, sellerId, categoryId, paymentMethod, limit);
        var items = new JsonArray();
        if (by is "day" or "week" or "month" or "hour")
        {
            if (by == "hour")
            {
                var got = rows.ToDictionary(r => (int)r.L("k"), r => (r.L("sales"), r.L("orders")));
                for (var h = 0; h < 24; h++)
                {
                    var (s, o) = got.GetValueOrDefault(h);
                    items.Add(J.O(("label", $"{h:00}:00"), ("key", h.ToString(Inv)), ("sales", s), ("orders", o)));
                }
            }
            else
            {
                var got = rows.ToDictionary(r => DateOnly.FromDateTime(Convert.ToDateTime(r["k"], Inv)), r => (r.L("sales"), r.L("orders")));
                if (by == "day")
                {
                    for (var i = 0; i < p.Days; i++)
                    {
                        var d = p.FirstDay.AddDays(i);
                        var (s, o) = got.GetValueOrDefault(d);
                        items.Add(J.O(("label", d.ToString("dd MMM", Inv)), ("key", d.ToString("yyyy-MM-dd", Inv)), ("sales", s), ("orders", o)));
                    }
                }
                else
                {
                    foreach (var (k, (s, o)) in got.OrderBy(x => x.Key))
                        items.Add(J.O(("label", by == "month" ? k.ToString("MMM yyyy", Inv) : "Week of " + k.ToString("dd MMM", Inv)), ("key", k.ToString("yyyy-MM-dd", Inv)),
                            ("sales", s), ("orders", o)));
                }
            }
            return J.O(("period", p.AsDict()), ("by", by), ("items", items));
        }
        if (by is "category" or "product")
        {
            foreach (var r in rows) items.Add(J.O(("label", r.S("k") is { Length: > 0 } l ? l : "—"), ("sales", r.L("sales")), ("units", r.L("units"))));
            return J.O(("period", p.AsDict()), ("by", by), ("items", items));
        }
        foreach (var r in rows)
        {
            var k = r.S("k");
            var label = by == "state" ? RefData.States.Value.GetValueOrDefault(k, k.Length > 0 ? k : "Unknown")
                : by == "payment_method" ? (k == "cod" ? "Cash on delivery" : k == "online" ? "Paid online" : k) : k;
            items.Add(J.O(("label", string.IsNullOrEmpty(label) ? "—" : label), ("sales", r.L("sales")), ("orders", r.L("orders"))));
        }
        return J.O(("period", p.AsDict()), ("by", by), ("items", items));
    }

    // ---------------------------------------------------------------- orders

    public async Task<JsonObject> FindPackagesAsync(Period? p, string? status, string? q, Guid? sellerId, string? paymentMethod, int? lateHours, int limit)
    {
        if (!string.IsNullOrEmpty(status) && !PackageStatuses.Contains(status))
            throw new ArgumentException($"Package status is one of: {string.Join(", ", PackageStatuses)}");
        var (total, value, rows) = await dal.PackagesAsync(p?.StartUtc, p?.EndUtc, status, q, sellerId, paymentMethod, lateHours, Math.Clamp(limit, 1, 200));
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(J.O(("package", r.S("number")), ("order", r.S("order_number")), ("order_id", r.S("order_id")), ("placed", AiShared.IstText(r.T("created_at"))),
                ("status", r.S("status")), ("seller", r.S("seller")), ("customer", r.S("customer")), ("phone", r.S("phone")),
                ("payment", r.S("payment_method") == "cod" ? "COD" : "Online"), ("total", r.L("total")), ("city", r.S("city")), ("state", State(r.S("state_code"))),
                ("awb", r.S("tracking_number"))));
        return J.O(("period", p?.AsDict()), ("total", total), ("total_value", value), ("items", items));
    }

    public async Task<JsonObject?> OrderDetailAsync(string reference)
    {
        var refU = reference.Trim().ToUpperInvariant();
        var o = await dal.OrderByNumberAsync(refU);
        if (o is null)
        {
            var sub = await dal.SubByNumberOrAwbAsync(refU);
            if (sub is null) o = Guid.TryParse(refU, out var id) ? await dal.OrderAsync(id) : null;
            else o = await dal.OrderAsync(sub.OrderId);
        }
        if (o is null) return null;
        var u = await dal.UserAsync(o.UserId);
        var subs = await dal.OrderSubsAsync(o.Id);
        var subIds = subs.Select(s => s.G("id")).ToList();
        var items = await dal.ItemsForSubsAsync(subIds);
        var pays = await dal.PaymentsAsync(o.Id);
        var refunds = await dal.RefundsForOrderAsync(o.Id);
        var events = await dal.EventsAsync(o.Id);
        var returns = await dal.ReturnsForSubsAsync(subIds);
        var ship = J.Obj(o.ShipTo);
        return J.O(("order_id", o.Id.ToString()), ("number", o.Number), ("status", o.Status), ("placed", AiShared.IstText(o.PlacedAt ?? o.CreatedAt)),
            ("payment_method", o.PaymentMethod), ("payment_status", o.PaymentStatus), ("grand_total", o.GrandTotal), ("items_total", o.ItemsTotal),
            ("shipping_total", o.ShippingTotal), ("discount_total", o.DiscountTotal), ("coupon", o.CouponCode), ("refunded_total", o.RefundedTotal),
            ("customer", J.O(("id", u?.Id.ToString() ?? ""), ("name", u?.Name ?? ""), ("phone", u?.Phone ?? ""), ("email", u?.Email ?? ""))),
            ("ship_to", J.O(("name", J.S(ship["full_name"])), ("city", J.S(ship["city"])), ("state", J.S(ship["state"])), ("pincode", J.S(ship["pincode"])),
                ("address", string.Join(", ", new[] { J.S(ship["line1"]), J.S(ship["line2"]), J.S(ship["landmark"]) }.Where(x => x.Length > 0))))),
            ("packages", J.A(subs.Select(s => (object?)J.O(("package", s.S("number")), ("seller", s.S("seller")), ("status", s.S("status")), ("total", s.L("total")),
                ("commission", s.L("commission_paise")), ("seller_payout", s.L("seller_payout_paise")), ("courier", s.S("courier_name")), ("awb", s.S("tracking_number")),
                ("shipped", AiShared.IstText(s.T("shipped_at"))), ("delivered", AiShared.IstText(s.T("delivered_at"))), ("cancel_reason", s.S("cancel_reason")),
                ("invoice", s.S("invoice_number")))))),
            ("items", J.A(items.Select(i => (object?)J.O(("sku", i.Sku), ("title", i.Title), ("option", i.VariantLabel), ("qty", i.Qty), ("unit_price", i.UnitPrice),
                ("line_total", i.LineTotal), ("returned_qty", i.ReturnedQty))))),
            ("payments", J.A(pays.Select(x => (object?)J.O(("status", x.Status), ("method", x.Method), ("amount", x.AmountPaise), ("gateway_payment_id", x.ProviderPaymentId ?? ""))))),
            ("refunds", J.A(refunds.Select(x => (object?)J.O(("id", x.Id.ToString()), ("amount", x.AmountPaise), ("status", x.Status), ("reason", x.Reason), ("attempts", x.Attempts))))),
            ("returns", J.A(returns.Select(x => (object?)J.O(("number", x.Number), ("status", x.Status), ("reason", x.Reason), ("refund_amount", x.RefundAmount))))),
            ("timeline", J.A(events.Select(e => (object?)J.O(("at", AiShared.IstText(e.CreatedAt)), ("change", $"{(string.IsNullOrEmpty(e.FromStatus) ? "new" : e.FromStatus)} → {e.ToStatus}"),
                ("by", e.Actor), ("note", J.Cut(e.Note, 160)))))));
    }

    // ---------------------------------------------------------------- customers

    public async Task<JsonObject> FindCustomersAsync(string? q, Period? p, string sort, int limit)
    {
        var (total, rows) = await dal.CustomersAsync(q, p?.StartUtc, p?.EndUtc, sort == "top_spenders", Math.Clamp(limit, 1, 200));
        var items = J.A(rows.Select(r => (object?)J.O(("id", r.S("id")), ("name", r.S("name")), ("phone", r.S("phone")), ("email", r.S("email")),
            ("joined", AiShared.IstDay(r.T("created_at"))), ("orders", r.L("n")), ("spent", r.L("spent")), ("last_order", AiShared.IstDay(r.T("last"))), ("active", r.B("is_active")))));
        return J.O(("period", p?.AsDict()), ("total", total), ("items", items));
    }

    public async Task<JsonObject?> CustomerDetailAsync(string reference)
    {
        reference = reference.Trim();
        var digits = new string(reference.Where(char.IsDigit).ToArray());
        var u = await dal.CustomerByRefAsync(reference.ToLowerInvariant(), digits.Length >= 10 ? digits[^10..] : null, Guid.TryParse(reference, out var id) ? id : null);
        if (u is null)
        {
            var byName = await dal.CustomersByNameAsync(reference);
            if (byName.Count != 1) return null;
            u = byName[0];
        }
        var (agg, recent, returns, cancelled, tickets) = await dal.CustomerDetailAsync(u.Id);
        var n = agg.L("n");
        return J.O(("id", u.Id.ToString()), ("name", u.Name), ("phone", u.Phone ?? ""), ("email", u.Email ?? ""), ("joined", AiShared.IstDay(u.CreatedAt)), ("active", u.IsActive),
            ("marketing_consent", u.MarketingOptIn), ("last_login", AiShared.IstText(u.LastLoginAt)), ("orders", n), ("net_spend", agg.L("spent")),
            ("first_order", AiShared.IstDay(agg.T("first"))), ("last_order", AiShared.IstDay(agg.T("last"))), ("average_order_value", n > 0 ? agg.L("spent") / n : 0),
            ("returns", returns), ("cancelled_packages", cancelled),
            ("recent_orders", J.A(recent.Select(o => (object?)J.O(("number", o.Number), ("placed", AiShared.IstDay(o.PlacedAt ?? o.CreatedAt)), ("status", o.Status),
                ("payment", o.PaymentMethod), ("total", o.GrandTotal))))),
            ("tickets", J.A(tickets.Select(t => (object?)J.O(("number", t.S("number")), ("subject", t.S("subject")), ("status", t.S("status")))))));
    }

    // ---------------------------------------------------------------- catalogue and stock

    public async Task<JsonObject> FindProductsAsync(string? q, string? status, Guid? sellerId, Guid? categoryId, int? maxStock, string sort, int limit)
    {
        var (total, rows) = await dal.ProductsAsync(q, status, sellerId, categoryId, maxStock, sort, Math.Clamp(limit, 1, 200));
        return J.O(("total", total), ("items", J.A(rows.Select(r => (object?)J.O(("id", r.S("id")), ("title", r.S("title")), ("sku", r.S("sku")), ("seller", r.S("seller")),
            ("category", r.S("category")), ("status", r.S("status")), ("price", r.L("price_from")), ("mrp", r.L("mrp_from")), ("stock", r.L("stock")), ("sold", r.L("sold_count")),
            ("rating", r.F("rating_avg")), ("reviews", r.L("rating_count")))))));
    }

    public async Task<JsonObject> StockAlertsAsync(int threshold, Guid? sellerId, int limit)
    {
        var (total, rows) = await dal.StockAlertsAsync(threshold, sellerId, Math.Clamp(limit, 1, 200));
        var items = J.A(rows.Select(r => (object?)J.O(("sku", r.S("sku")), ("product", r.S("title")),
            ("option", string.Join(", ", J.Obj(r.S("options")).Select(kv => $"{kv.Key}: {J.S(kv.Value)}"))), ("seller", r.S("seller")), ("stock", r.L("qty")), ("sold", r.L("sold_count")))));
        return J.O(("threshold", threshold), ("total", total), ("out_of_stock", rows.Count(r => r.L("qty") <= 0)), ("items", items));
    }

    // ---------------------------------------------------------------- sellers

    public async Task<JsonObject> FindSellersAsync(string? q, string? status, Period? p, int limit)
    {
        var (total, rows) = await dal.SellersAsync(q, status, p?.StartUtc, p?.EndUtc, Math.Clamp(limit, 1, 200));
        return J.O(("period", p?.AsDict()), ("total", total), ("items", J.A(rows.Select(r => (object?)J.O(("id", r.S("id")), ("store", r.S("display_name")),
            ("legal_name", r.S("legal_name")), ("status", r.S("status")), ("city", r.S("pickup_city")), ("gstin", r.S("gstin")), ("sales", r.L("sales")),
            ("packages", r.L("packages")), ("live_listings", r.L("n")), ("rating", r.F("rating_avg")), ("phone", r.S("contact_phone")), ("email", r.S("contact_email")))))));
    }

    public async Task<SellerModel?> ResolveSellerAsync(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        if (Guid.TryParse(reference, out var id) && await dal.SellerAsync(id) is { } s) return s;
        var exact = await dal.SellersExactAsync(reference.Trim());
        if (exact.Count == 1) return exact[0];
        var like = await dal.SellersLikeAsync(reference);
        return like.Count == 1 ? like[0] : null;
    }

    public async Task<CategoryModel?> ResolveCategoryAsync(string? reference)
    {
        if (string.IsNullOrEmpty(reference)) return null;
        if (Guid.TryParse(reference, out var id) && await dal.CategoryAsync(id) is { } c) return c;
        var exact = await dal.CategoriesExactAsync(reference.Trim());
        if (exact.Count == 1) return exact[0];
        var like = await dal.CategoriesLikeAsync(reference);
        return like.Count == 1 ? like[0] : null;
    }

    public async Task<JsonObject> SellerDetailAsync(SellerModel s, Period p, BAL.Interface.IAiBAL risk)
    {
        var summary = await SalesSummaryAsync(p, s.Id);
        var (due, hold, listings, late) = await dal.SellerMoneyAsync(s.Id);
        var brief = await risk.SellerRiskAsync(s);
        var factors = new JsonArray((brief["factors"] as JsonArray ?? []).Take(5).Select(f => f?.DeepClone()).ToArray());
        var lst = new JsonObject();
        foreach (var (k, v) in listings) lst[k] = v;
        return J.O(("id", s.Id.ToString()), ("store", s.DisplayName), ("legal_name", s.LegalName), ("status", s.Status), ("gstin", s.Gstin ?? ""), ("city", s.PickupCity),
            ("state", State(s.PickupStateCode)), ("phone", s.ContactPhone), ("email", s.ContactEmail), ("joined", AiShared.IstDay(s.CreatedAt)), ("rating", (double)s.RatingAvg),
            ("rating_count", s.RatingCount), ("holiday_mode", s.HolidayMode), ("commission_override_pct", s.CommissionBpsOverride.HasValue ? s.CommissionBpsOverride.Value / 100.0 : null),
            ("listings", lst), ("payout_due_now", due), ("payout_on_hold", hold), ("packages_late_to_ship", late), ("sales", summary),
            ("health", J.O(("score", brief["score"]?.DeepClone()), ("level", brief["level"]?.DeepClone()), ("headline", brief["headline"]?.DeepClone()), ("factors", factors))));
    }

    // ---------------------------------------------------------------- returns, refunds, support, payouts, coupons, tax

    private static JsonObject Counts(IEnumerable<AssistantDAL.Row> rows)
    {
        var o = new JsonObject();
        foreach (var r in rows) o[r.S("k")] = r.L("n");
        return o;
    }

    public async Task<JsonObject> FindReturnsAsync(Period? p, string? status, Guid? sellerId, int limit)
    {
        var (total, byStatus, byReason, rows) = await dal.ReturnsAsync(p?.StartUtc, p?.EndUtc, status, sellerId, Math.Clamp(limit, 1, 200));
        return J.O(("period", p?.AsDict()), ("total", total), ("by_status", Counts(byStatus)), ("by_reason", Counts(byReason)),
            ("items", J.A(rows.Select(r => (object?)J.O(("id", r.S("id")), ("number", r.S("number")), ("package", r.S("package")), ("seller", r.S("seller")),
                ("requested", AiShared.IstText(r.T("created_at"))), ("status", r.S("status")), ("reason", r.S("reason")), ("refund_amount", r.L("refund_amount")))))));
    }

    public async Task<JsonObject> FindRefundsAsync(string? status, Period? p, int limit)
    {
        var (byStatus, value, rows) = await dal.RefundsAsync(status, p?.StartUtc, p?.EndUtc, Math.Clamp(limit, 1, 200));
        return J.O(("by_status", Counts(byStatus)), ("total_value", value), ("items", J.A(rows.Select(r => (object?)J.O(("id", r.S("id")), ("order", r.S("order_number")),
            ("amount", r.L("amount_paise")), ("status", r.S("status")), ("reason", r.S("reason")), ("attempts", r.L("attempts")), ("last_error", J.Cut(r.S("last_error"), 120)),
            ("created", AiShared.IstText(r.T("created_at"))))))));
    }

    public async Task<JsonObject> FindTicketsAsync(string? status, bool overdueOnly, string? q, int limit)
    {
        var (byStatus, total, rows) = await dal.TicketsAsync(status, overdueOnly, q, Math.Clamp(limit, 1, 200));
        return J.O(("by_status", Counts(byStatus)), ("total", total), ("items", J.A(rows.Select(t => (object?)J.O(("id", t.S("id")), ("number", t.S("number")),
            ("subject", t.S("subject")), ("category", t.S("category")), ("status", t.S("status")), ("priority", t.S("priority")), ("grievance", t.B("is_grievance")),
            ("opened", AiShared.IstText(t.T("created_at"))), ("order", t.S("order_number")), ("reply_due", AiShared.IstText(t.T("ack_due_at"))),
            ("replied", AiShared.IstText(t.T("acknowledged_at"))), ("resolve_due", AiShared.IstText(t.T("resolve_due_at"))))))));
    }

    public async Task<JsonObject> PayoutsOverviewAsync(string? status, int limit)
    {
        var (due, hold, byStatus, rows) = await dal.PayoutsAsync(status, Math.Clamp(limit, 1, 200));
        return J.O(("due_now_total", due.Sum(d => d.L("amount"))), ("due_now", J.A(due.Take(50).Select(d => (object?)J.O(("seller", d.S("seller")), ("amount", d.L("amount")))))),
            ("on_hold_total", hold), ("by_status", Counts(byStatus)),
            ("items", J.A(rows.Select(p => (object?)J.O(("number", p.S("number")), ("seller", p.S("seller")), ("amount", p.L("amount")), ("status", p.S("status")),
                ("mode", p.S("mode")), ("utr", p.S("utr")), ("created", AiShared.IstDay(p.T("created_at"))), ("paid", AiShared.IstDay(p.T("paid_at"))), ("failure", p.S("failure_reason")))))));
    }

    public async Task<JsonObject> PendingWorkAsync()
    {
        var o = new JsonObject();
        foreach (var (k, v) in await dal.PendingWorkAsync()) o[k] = v;
        return o;
    }

    public async Task<JsonObject> CouponsOverviewAsync(bool activeOnly) =>
        J.O(("items", J.A((await dal.CouponsAsync(activeOnly)).Select(c => (object?)J.O(("code", c.Code), ("kind", c.Kind), ("value", c.Value), ("min_order", c.MinOrderPaise),
            ("max_discount", c.MaxDiscountPaise), ("active", c.IsActive), ("used", c.UsedCount), ("usage_limit", c.UsageLimit), ("ends", AiShared.IstDay(c.EndsAt)),
            ("funded_by", c.FundedBy))))));

    /// <summary>Supplier-wise net taxable value and TCS for GSTR-8 (reference reports.tcs_report_data).</summary>
    public async Task<JsonObject> TcsReportAsync(string month)
    {
        var y = int.Parse(month[..4], Inv);
        var m = int.Parse(month[5..], Inv);
        var start = DateTimeFunctions.IstToUtc(new DateTime(y, m, 1));
        var end = DateTimeFunctions.IstToUtc(new DateTime(y, m, 1).AddMonths(1));
        var cfg = await AiShared.MarketplaceAsync(ai);
        var (sales, rv, rt, subs) = await dal.TcsAsync(start, end);
        var rvMap = rv.ToDictionary(r => r.S("id"), r => r.L("v"));
        var rtMap = rt.ToDictionary(r => r.S("id"), r => r.L("v"));
        var rows = sales.Select(r => (Id: r.S("id"), Name: r.S("legal_name"), Gstin: r.S("gstin"), Inter: r.B("is_interstate"), Taxable: r.L("taxable"), Tcs: r.L("tcs"), N: r.L("n"))).ToList();
        rows.AddRange(subs.Select(s => (Id: s.S("id"), Name: s.S("legal_name"), Gstin: s.S("gstin"), Inter: s.B("is_interstate"), Taxable: -rvMap.GetValueOrDefault(s.S("sub_id")),
            Tcs: -rtMap.GetValueOrDefault(s.S("sub_id")), N: 0L)));
        var outp = new Dictionary<string, JsonObject>();
        foreach (var (id, name, gstin, inter, taxable, tcs, n) in rows)
        {
            if (!outp.TryGetValue(id, out var r))
                outp[id] = r = J.O(("seller_id", id), ("legal_name", name), ("gstin", gstin), ("net_taxable_value", 0L), ("igst_tcs", 0L), ("cgst_tcs", 0L), ("sgst_tcs", 0L),
                    ("sub_orders", 0L), ("returned_value", 0L));
            r["net_taxable_value"] = (J.Long(r["net_taxable_value"]) ?? 0) + taxable;
            if (taxable < 0) r["returned_value"] = (J.Long(r["returned_value"]) ?? 0) - taxable;
            r["sub_orders"] = (J.Long(r["sub_orders"]) ?? 0) + n;
            if (inter) r["igst_tcs"] = (J.Long(r["igst_tcs"]) ?? 0) + tcs;
            else
            {
                var half = tcs / 2; // towards zero, so returns split the same way as sales
                r["cgst_tcs"] = (J.Long(r["cgst_tcs"]) ?? 0) + half;
                r["sgst_tcs"] = (J.Long(r["sgst_tcs"]) ?? 0) + tcs - half;
            }
        }
        return J.O(("month", month), ("tcs_rate_bps", cfg["tcs_bps"]?.DeepClone()),
            ("note", "Basis for GSTR-8 (due by the 10th of the next month): packages placed in the month, less returns received in the month. Verify with your CA before filing."),
            ("items", new JsonArray(outp.Values.Select(v => (JsonNode)v).ToArray())));
    }
}
