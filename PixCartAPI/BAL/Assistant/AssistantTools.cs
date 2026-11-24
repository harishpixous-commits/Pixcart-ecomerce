using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.AI;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.Assistant;

/// <summary>What a tool runs with: the person (their permissions are re-checked on every call) and the services it reads.</summary>
public sealed class ToolContext
{
    public required AssistantQueries Q { get; init; }
    public required AssistantDAL Dal { get; init; }
    public required AiDAL Ai { get; init; }
    public required IAiBAL AiBal { get; init; }
    public required AssistantActions Actions { get; init; }
    public required AnthropicKeyDAL AnthropicKey { get; init; }
    public required UserModel User { get; init; }
    public required HashSet<string> Permissions { get; init; }
    public required Guid ConversationId { get; init; }
    public bool ShareContacts { get; init; }
    public List<string> UploadIds { get; init; } = [];
}

/// <summary>A tool's result: exact data for the model, and the cards the screen shows (built from the same data).</summary>
public sealed record ToolOutput(JsonNode? Data, List<JsonObject> Cards)
{
    public ToolOutput(JsonNode? data) : this(data, []) { }
    public static ToolOutput Error(string message) => new(J.O(("error", message)));
}

public sealed record ToolDef(string Name, string Label, string Description, JsonObject Schema, string[] AnyOf, string Group)
{
    public JsonObject Spec() => J.O(("name", Name), ("description", Description), ("input_schema", J.Merge(J.O(("type", "object")), Schema)));
}

/// <summary>
/// The admin assistant's tools: what it can look up, export, analyse and propose. Each tool declares the permissions it
/// needs (any of); a person only gets the tools their role allows, and the check is repeated when a tool runs. Contact
/// details are masked for the model unless the admin allows sharing; the cards on screen keep them.
/// </summary>
public static class AssistantTools
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static readonly Dictionary<string, ToolDef> Tools = RefData.Arr("assistant_tools").OfType<JsonObject>()
        .Select(t => new ToolDef(J.S(t["name"]), J.S(t["label"]), J.S(t["description"]), (JsonObject)t["schema"]!.DeepClone(),
            (t["any_of"] as JsonArray ?? []).Select(J.S).ToArray(), J.S(t["group"])))
        .ToDictionary(t => t.Name);

    public static readonly Dictionary<string, (string Label, string Href, string Permission)> Pages = RefData.Obj("assistant_pages")
        .ToDictionary(kv => kv.Key, kv => (J.S(kv.Value![0]), J.S(kv.Value![1]), J.S(kv.Value![2])));

    public static List<ToolDef> Available(ISet<string> perms) => Tools.Values.Where(t => t.AnyOf.Any(perms.Contains)).ToList();

    // ---------------------------------------------------------------- helpers

    private static string? A(JsonObject a, string k) => a[k] is null ? null : J.S(a[k]) is { Length: > 0 } s ? s : null;

    private static Period PeriodOf(JsonObject a, string fallback = "today") =>
        Period.Resolve(A(a, "period") ?? (A(a, "date_from") != null || A(a, "date_to") != null ? null : fallback), A(a, "date_from"), A(a, "date_to"));

    private static int Limit(JsonObject a, int def = 25, int hi = 200)
    {
        var v = J.Long(a["limit"]);
        if (a["limit"] is null || v is null || v == 0) return def;
        return (int)Math.Max(1, Math.Min(v.Value, hi));
    }

    /// <summary>Hides phone numbers, emails and street addresses from the model (screen cards keep them).</summary>
    public static JsonNode? Mask(JsonNode? value)
    {
        switch (value)
        {
            case JsonObject o:
            {
                var outp = new JsonObject();
                foreach (var (k, v) in o)
                {
                    var lk = k.ToLowerInvariant();
                    var s = v is JsonValue jv && jv.GetValueKind() == System.Text.Json.JsonValueKind.String ? J.S(v) : null;
                    if (!string.IsNullOrEmpty(s) && (lk.Contains("phone") || lk is "contact" or "mobile"))
                    {
                        var digits = new string(s.Where(char.IsDigit).ToArray());
                        outp[k] = digits.Length >= 6 ? $"{digits[..2]}••••••{digits[^2..]}" : "••••";
                    }
                    else if (!string.IsNullOrEmpty(s) && lk.Contains("email"))
                    {
                        var at = s.IndexOf('@');
                        outp[k] = at >= 0 && at < s.Length - 1 ? $"{(at > 0 ? s[..1] : "")}•••@{s[(at + 1)..]}" : "•••";
                    }
                    else if (lk is "address" or "line1" or "line2" or "landmark" && s != null) outp[k] = "(hidden)";
                    else outp[k] = Mask(v);
                }
                return outp;
            }
            case JsonArray arr: return new JsonArray(arr.Select(Mask).ToArray());
            default: return value?.DeepClone();
        }
    }

    public static JsonObject Metrics(string title, IEnumerable<(string Label, string Value, string? Hint)> items, string note = "") =>
        J.O(("type", "metrics"), ("title", title), ("note", note), ("items", J.A(items.Select(i => (object?)J.O(("label", i.Label), ("value", i.Value), ("hint", i.Hint ?? ""))))));

    public static JsonObject Table(string title, IEnumerable<string> columns, IEnumerable<IEnumerable<object?>> rows, long? total = null, string note = "", string link = "")
    {
        var rs = new JsonArray(rows.Select(r => (JsonNode?)new JsonArray(r.Select(c => J.Node(c ?? "")).ToArray())).ToArray());
        return J.O(("type", "table"), ("title", title), ("columns", J.Strings(columns)), ("rows", rs), ("total_rows", total ?? rs.Count), ("note", note), ("link", link));
    }

    public static JsonObject Chart(string title, string kind, IEnumerable<string> labels, IEnumerable<(string Name, IEnumerable<double> Values)> series, string unit = "") =>
        J.O(("type", "chart"), ("title", title), ("kind", kind), ("labels", J.Strings(labels)), ("unit", unit),
            ("series", J.A(series.Select(s => (object?)J.O(("name", s.Name), ("values", J.A(s.Values.Select(v => (object?)v))))))));

    private static string? Delta(long cur, long prev)
    {
        if (prev == 0) return null; // nothing to compare with
        var change = (cur - prev) * 100.0 / Math.Abs(prev);
        return $"{(change >= 0 ? "+" : "")}{change.ToString("0.0", Inv)}% vs previous";
    }

    private static string Inr(JsonNode? n) => AiShared.Inr(J.Double(n) ?? 0);
    private static string Num(JsonNode? n) => AiShared.Num(J.Double(n) ?? 0);
    private static long L(JsonNode? n) => J.Long(n) ?? 0;
    private static IEnumerable<JsonObject> Items(JsonNode? d, string key = "items") => (d?[key] as JsonArray ?? []).OfType<JsonObject>();

    private static bool PageAllowed(string href, ISet<string> perms)
    {
        var path = href.Split('?')[0];
        foreach (var (_, h, p) in Pages.Values)
            if (h == path) return perms.Contains(p);
        return true;
    }

    // ---------------------------------------------------------------- handlers

    private delegate Task<ToolOutput> Handler(ToolContext ctx, JsonObject a);

    private static readonly Dictionary<string, Handler> Handlers = new()
    {
        ["business_overview"] = BusinessOverview, ["sales_breakdown"] = SalesBreakdown, ["work_queue"] = WorkQueue, ["find_orders"] = FindOrders,
        ["order_details"] = OrderDetails, ["find_customers"] = FindCustomers, ["customer_profile"] = CustomerProfile, ["find_products"] = FindProducts,
        ["stock_alerts"] = StockAlerts, ["find_sellers"] = FindSellers, ["seller_profile"] = SellerProfile, ["returns_report"] = ReturnsReport,
        ["refunds_report"] = RefundsReport, ["support_tickets"] = SupportTickets, ["payouts_report"] = PayoutsReport, ["coupons"] = Coupons,
        ["gst_tcs_report"] = GstTcsReport, ["marketplace_settings"] = MarketplaceSettings, ["prepare_export"] = PrepareExport, ["file_overview"] = FileOverview,
        ["file_query"] = FileQuery, ["file_compare"] = FileCompare, ["propose_action"] = ProposeAction, ["open_page"] = OpenPage, ["remember"] = Remember,
    };

    private static async Task<ToolOutput> BusinessOverview(ToolContext ctx, JsonObject a)
    {
        var p = PeriodOf(a);
        var seller = A(a, "seller") != null ? await ctx.Q.ResolveSellerAsync(A(a, "seller")) : null;
        var cat = A(a, "category") != null ? await ctx.Q.ResolveCategoryAsync(A(a, "category")) : null;
        if (A(a, "seller") != null && seller is null) return ToolOutput.Error($"No single seller matches '{A(a, "seller")}'. Use find_sellers first.");
        if (A(a, "category") != null && cat is null) return ToolOutput.Error($"No single category matches '{A(a, "category")}'.");
        var pm = A(a, "payment_method");
        var cur = await ctx.Q.SalesSummaryAsync(p, seller?.Id, cat?.Id, pm, A(a, "state_code"));
        var compare = a["compare"] is null || J.Truthy(a["compare"]);
        var prev = compare ? await ctx.Q.SalesSummaryAsync(p.Previous(), seller?.Id, cat?.Id, pm, A(a, "state_code")) : null;
        var scope = string.Join(" · ", new[] { seller?.DisplayName ?? "", cat?.Name ?? "", pm == "cod" ? "Cash on delivery" : pm == "online" ? "Paid online" : "" }.Where(x => x.Length > 0));
        string? D(string k) => prev != null ? Delta(L(cur[k]), L(prev[k])) : null;
        var items = new List<(string, string, string?)>
        {
            ("Sales", Inr(cur["sales"]), D("sales")), ("Orders", Num(cur["orders"]), D("orders")), ("Average order", Inr(cur["average_order_value"]), D("average_order_value")),
            ("Units sold", Num(cur["units"]), D("units")), ("Net after returns", Inr(cur["net_sales"]), null), ("Commission earned", Inr(cur["commission"]), D("commission")),
            ("Cancelled packages", $"{Num(cur["cancelled_packages"])} ({J.S(cur["cancellation_rate_pct"])}%)", null),
            ("COD / online orders", $"{L(cur["cod_orders"])} / {L(cur["online_orders"])}", null),
        };
        if (cur.ContainsKey("new_customers")) items.Add(("New customers", Num(cur["new_customers"]), D("new_customers")));
        var data = J.O(("current", cur), ("previous", prev), ("definitions", J.O(("sales", "package totals excluding cancelled ones and unpaid online orders"),
            ("orders", "orders with at least one package placed"), ("amounts", "integer paise; divide by 100 for rupees"))));
        return new ToolOutput(data, [Metrics($"{p.Label}{(scope.Length > 0 ? " · " + scope : "")}", items,
            prev != null ? "IST calendar days. Compared with the previous period of the same length." : "")]);
    }

    private static async Task<ToolOutput> SalesBreakdown(ToolContext ctx, JsonObject a)
    {
        var p = PeriodOf(a, "last_7_days");
        var seller = A(a, "seller") != null ? await ctx.Q.ResolveSellerAsync(A(a, "seller")) : null;
        var cat = A(a, "category") != null ? await ctx.Q.ResolveCategoryAsync(A(a, "category")) : null;
        var outp = await ctx.Q.SalesBreakdownAsync(p, A(a, "by") ?? "day", seller?.Id, cat?.Id, A(a, "payment_method"), Limit(a, 10, 100));
        var by = J.S(outp["by"]);
        var items = Items(outp).ToList();
        var second = by is "category" or "product" ? "units" : "orders";
        var kind = by is "day" or "week" or "month" or "hour" && items.Count > 2 ? "line" : "bar";
        var title = by.Replace('_', ' ');
        return new ToolOutput(outp,
        [
            Chart($"Sales by {title} · {p.Label}", kind, items.Select(i => J.S(i["label"])), [("Sales (₹)", items.Select(i => Math.Round(L(i["sales"]) / 100.0, 2)))], "₹"),
            Table($"Sales by {title}", [char.ToUpperInvariant(title[0]) + title[1..], "Sales", char.ToUpperInvariant(second[0]) + second[1..]],
                items.Select(i => new object?[] { J.S(i["label"]), Inr(i["sales"]), Num(i[second]) })),
        ]);
    }

    private static readonly (string Key, string Label, string Href)[] QueueLabels =
    [
        ("sellers_to_review", "Sellers to review", "/admin/sellers?status=submitted"), ("listings_to_review", "Listings to review", "/admin/products"),
        ("packages_late_to_ship_48h", "Packages not shipped in 48 h", "/admin/orders"), ("returns_waiting", "Returns waiting", "/admin/returns"),
        ("refunds_failed", "Failed refunds", "/admin/refunds"), ("tickets_reply_overdue", "Tickets past reply time", "/admin/support"),
        ("tickets_open", "Open tickets", "/admin/support"), ("reviews_to_moderate", "Reviews to moderate", "/admin/reviews"),
        ("payouts_failed", "Failed payouts", "/admin/payouts"), ("out_of_stock_options", "Options out of stock", "/admin/products"),
    ];

    private static async Task<ToolOutput> WorkQueue(ToolContext ctx, JsonObject a)
    {
        var q = await ctx.Q.PendingWorkAsync();
        var metrics = Metrics("Waiting for you", QueueLabels.Select(l => (l.Label, Num(q[l.Key]), (string?)null)));
        var links = QueueLabels.Where(l => L(q[l.Key]) > 0 && PageAllowed(l.Href, ctx.Permissions)).Select(l => (object?)J.O(("label", l.Label), ("href", l.Href))).ToList();
        return new ToolOutput(q, links.Count > 0 ? [metrics, J.O(("type", "links"), ("title", "Open"), ("items", J.A(links)))] : [metrics]);
    }

    private static async Task<ToolOutput> FindOrders(ToolContext ctx, JsonObject a)
    {
        var allTime = J.Truthy(a["all_time"]) || (A(a, "q") != null && A(a, "period") == null) || J.Truthy(a["late_to_ship_hours"]);
        var p = allTime ? null : PeriodOf(a, "last_30_days");
        var seller = A(a, "seller") != null ? await ctx.Q.ResolveSellerAsync(A(a, "seller")) : null;
        var late = J.Long(a["late_to_ship_hours"]);
        var outp = await ctx.Q.FindPackagesAsync(p, A(a, "status"), A(a, "q"), seller?.Id, A(a, "payment_method"), late is > 0 ? (int)late : null, Limit(a));
        var rows = Items(outp).Select(i => new object?[] { J.S(i["package"]), J.S(i["order"]), J.S(i["placed"]), J.S(i["status"]), J.S(i["seller"]), J.S(i["customer"]),
            J.S(i["payment"]), Inr(i["total"]), J.S(i["city"]) }).ToList();
        var title = $"Packages{(p != null ? " · " + p.Label : "")}{(A(a, "status") is { } st ? " · " + st : "")}";
        var total = L(outp["total"]);
        var note = total > rows.Count ? $"Showing {rows.Count} of {total} (total value {Inr(outp["total_value"])})." : $"Total value {Inr(outp["total_value"])}.";
        return new ToolOutput(outp, [Table(title, ["Package", "Order", "Placed", "Status", "Seller", "Customer", "Payment", "Total", "City"], rows, total, note, "/admin/orders")]);
    }

    private static async Task<ToolOutput> OrderDetails(ToolContext ctx, JsonObject a)
    {
        var d = await ctx.Q.OrderDetailAsync(J.S(a["reference"]));
        if (d is null) return ToolOutput.Error("No order, package or AWB with that number.");
        var c = (JsonObject)d["customer"]!;
        var cards = new List<JsonObject>
        {
            Metrics($"Order {J.S(d["number"])}", [("Status", J.S(d["status"]), null), ("Placed", J.S(d["placed"]), null),
                ("Payment", $"{J.S(d["payment_method"]).ToUpperInvariant()} · {J.S(d["payment_status"])}", null), ("Total", Inr(d["grand_total"]), null),
                ("Refunded", Inr(d["refunded_total"]), null), ("Customer", J.S(c["name"]) is { Length: > 0 } n ? n : J.S(c["phone"]), null)]),
            Table("Items", ["SKU", "Item", "Option", "Qty", "Unit price", "Line total", "Returned"],
                Items(d).Select(i => new object?[] { J.S(i["sku"]), J.S(i["title"]), J.S(i["option"]), L(i["qty"]), Inr(i["unit_price"]), Inr(i["line_total"]), L(i["returned_qty"]) })),
            Table("Packages", ["Package", "Seller", "Status", "Total", "Courier", "AWB", "Delivered"],
                Items(d, "packages").Select(p => new object?[] { J.S(p["package"]), J.S(p["seller"]), J.S(p["status"]), Inr(p["total"]), J.S(p["courier"]), J.S(p["awb"]), J.S(p["delivered"]) }),
                link: $"/admin/orders/{J.S(d["order_id"])}"),
        };
        if (Items(d, "timeline").Any())
            cards.Add(Table("Timeline", ["When", "Change", "By", "Note"], Items(d, "timeline").Select(t => new object?[] { J.S(t["at"]), J.S(t["change"]), J.S(t["by"]), J.S(t["note"]) })));
        return new ToolOutput(d, cards);
    }

    private static async Task<ToolOutput> FindCustomers(ToolContext ctx, JsonObject a)
    {
        var p = A(a, "period") != null || A(a, "date_from") != null ? PeriodOf(a) : null;
        var outp = await ctx.Q.FindCustomersAsync(A(a, "q"), p, A(a, "sort") ?? "recent", Limit(a));
        return new ToolOutput(outp, [Table($"Customers{(p != null ? " · " + p.Label : "")}", ["Name", "Mobile", "Email", "Joined", "Orders", "Spent", "Last order", "Active"],
            Items(outp).Select(c => new object?[] { J.S(c["name"]), J.S(c["phone"]), J.S(c["email"]), J.S(c["joined"]), L(c["orders"]), Inr(c["spent"]), J.S(c["last_order"]),
                J.Truthy(c["active"]) ? "yes" : "blocked" }), L(outp["total"]), link: "/admin/customers")]);
    }

    private static async Task<ToolOutput> CustomerProfile(ToolContext ctx, JsonObject a)
    {
        var d = await ctx.Q.CustomerDetailAsync(J.S(a["reference"]));
        if (d is null) return ToolOutput.Error("No single customer matches. Try the mobile number or email.");
        var cards = new List<JsonObject>
        {
            Metrics(J.S(d["name"]) is { Length: > 0 } n ? n : J.S(d["phone"]), [("Mobile", J.S(d["phone"]), null), ("Email", J.S(d["email"]) is { Length: > 0 } e ? e : "—", null),
                ("Joined", J.S(d["joined"]), null), ("Orders", Num(d["orders"]), null), ("Net spend", Inr(d["net_spend"]), null), ("Average order", Inr(d["average_order_value"]), null),
                ("Returns", Num(d["returns"]), null), ("Cancelled packages", Num(d["cancelled_packages"]), null), ("Account", J.Truthy(d["active"]) ? "active" : "blocked", null)]),
            Table("Recent orders", ["Order", "Placed", "Status", "Payment", "Total"],
                Items(d, "recent_orders").Select(o => new object?[] { J.S(o["number"]), J.S(o["placed"]), J.S(o["status"]), J.S(o["payment"]), Inr(o["total"]) })),
        };
        if (Items(d, "tickets").Any())
            cards.Add(Table("Support tickets", ["Ticket", "Subject", "Status"], Items(d, "tickets").Select(t => new object?[] { J.S(t["number"]), J.S(t["subject"]), J.S(t["status"]) })));
        return new ToolOutput(d, cards);
    }

    private static async Task<ToolOutput> FindProducts(ToolContext ctx, JsonObject a)
    {
        var seller = A(a, "seller") != null ? await ctx.Q.ResolveSellerAsync(A(a, "seller")) : null;
        var cat = A(a, "category") != null ? await ctx.Q.ResolveCategoryAsync(A(a, "category")) : null;
        var maxStock = a["max_stock"] is null ? null : (int?)J.Long(a["max_stock"]);
        var outp = await ctx.Q.FindProductsAsync(A(a, "q"), A(a, "status"), seller?.Id, cat?.Id, maxStock, A(a, "sort") ?? "recent", Limit(a));
        return new ToolOutput(outp, [Table("Listings", ["Product", "SKU", "Seller", "Category", "Status", "Price", "MRP", "Stock", "Sold", "Rating"],
            Items(outp).Select(p => new object?[] { J.S(p["title"]), J.S(p["sku"]), J.S(p["seller"]), J.S(p["category"]), J.S(p["status"]), Inr(p["price"]), Inr(p["mrp"]),
                L(p["stock"]), L(p["sold"]), $"{(J.Double(p["rating"]) ?? 0).ToString("0.0", Inv)} ({L(p["reviews"])})" }), L(outp["total"]), link: "/admin/products")]);
    }

    private static async Task<ToolOutput> StockAlerts(ToolContext ctx, JsonObject a)
    {
        var seller = A(a, "seller") != null ? await ctx.Q.ResolveSellerAsync(A(a, "seller")) : null;
        var threshold = a["threshold"] is null ? 5 : (int)(J.Long(a["threshold"]) ?? 5);
        var outp = await ctx.Q.StockAlertsAsync(threshold, seller?.Id, Limit(a, 50));
        return new ToolOutput(outp, [Table($"Stock at or below {threshold}", ["SKU", "Product", "Option", "Seller", "Stock", "Sold so far"],
            Items(outp).Select(i => new object?[] { J.S(i["sku"]), J.S(i["product"]), J.S(i["option"]), J.S(i["seller"]), L(i["stock"]), L(i["sold"]) }), L(outp["total"]),
            $"{L(outp["out_of_stock"])} out of stock in this list.")]);
    }

    private static async Task<ToolOutput> FindSellers(ToolContext ctx, JsonObject a)
    {
        var p = PeriodOf(a, "last_30_days");
        var outp = await ctx.Q.FindSellersAsync(A(a, "q"), A(a, "status"), p, Limit(a));
        return new ToolOutput(outp, [Table($"Sellers · sales {p.Label}", ["Store", "Status", "City", "GSTIN", "Sales", "Packages", "Live listings", "Rating"],
            Items(outp).Select(s => new object?[] { J.S(s["store"]), J.S(s["status"]), J.S(s["city"]), J.S(s["gstin"]), Inr(s["sales"]), L(s["packages"]), L(s["live_listings"]),
                (J.Double(s["rating"]) ?? 0).ToString("0.0", Inv) }), L(outp["total"]), link: "/admin/sellers")]);
    }

    private static async Task<ToolOutput> SellerProfile(ToolContext ctx, JsonObject a)
    {
        var s = await ctx.Q.ResolveSellerAsync(A(a, "seller"));
        if (s is null) return ToolOutput.Error("No single seller matches. Use find_sellers.");
        var p = PeriodOf(a, "last_30_days");
        var d = await ctx.Q.SellerDetailAsync(s, p, ctx.AiBal);
        var sm = (JsonObject)d["sales"]!;
        var health = (JsonObject)d["health"]!;
        return new ToolOutput(d,
        [
            Metrics($"{J.S(d["store"])} · {p.Label}", [("Status", J.S(d["status"]), null), ("Sales", Inr(sm["sales"]), null), ("Orders", Num(sm["orders"]), null),
                ("Payout due now", Inr(d["payout_due_now"]), null), ("On hold (return window)", Inr(d["payout_on_hold"]), null), ("Late to ship", Num(d["packages_late_to_ship"]), null),
                ("Rating", $"{(J.Double(d["rating"]) ?? 0).ToString("0.0", Inv)} ({L(d["rating_count"])})", null),
                ("Health", $"{J.S(health["level"])} · {J.S(health["score"])}", J.S(health["headline"]))]),
            Table("Why", ["Weight", "Reason"], Items(health, "factors").Select(f => new object?[] { L(f["weight"]), J.S(f["text"]) }), link: $"/admin/sellers/{J.S(d["id"])}"),
        ]);
    }

    private static async Task<ToolOutput> ReturnsReport(ToolContext ctx, JsonObject a)
    {
        var p = PeriodOf(a, "last_30_days");
        var seller = A(a, "seller") != null ? await ctx.Q.ResolveSellerAsync(A(a, "seller")) : null;
        var outp = await ctx.Q.FindReturnsAsync(p, A(a, "status"), seller?.Id, Limit(a));
        var byStatus = (JsonObject)outp["by_status"]!;
        var mets = byStatus.Select(kv => (char.ToUpperInvariant(kv.Key.Replace('_', ' ')[0]) + kv.Key.Replace('_', ' ')[1..], Num(kv.Value), (string?)null)).ToList();
        if (mets.Count == 0) mets.Add(("Returns", "0", null));
        var cards = new List<JsonObject>
        {
            Metrics($"Returns · {p.Label}", mets),
            Table("Returns", ["Return", "Package", "Seller", "Requested", "Status", "Reason", "Refund"],
                Items(outp).Select(r => new object?[] { J.S(r["number"]), J.S(r["package"]), J.S(r["seller"]), J.S(r["requested"]), J.S(r["status"]), J.S(r["reason"]), Inr(r["refund_amount"]) }),
                L(outp["total"]), link: "/admin/returns"),
        };
        var byReason = (JsonObject)outp["by_reason"]!;
        if (byReason.Count > 0) cards.Add(Chart("Return reasons", "bar", byReason.Select(kv => kv.Key), [("Returns", byReason.Select(kv => (double)L(kv.Value)))]));
        return new ToolOutput(outp, cards);
    }

    private static async Task<ToolOutput> RefundsReport(ToolContext ctx, JsonObject a)
    {
        var p = A(a, "period") != null || A(a, "date_from") != null ? PeriodOf(a) : null;
        var outp = await ctx.Q.FindRefundsAsync(A(a, "status"), p, Limit(a));
        return new ToolOutput(outp, [Table($"Refunds{(A(a, "status") is { } st ? " · " + st : "")}", ["Refund id", "Order", "Amount", "Status", "Reason", "Attempts", "Last error", "Created"],
            Items(outp).Select(r => new object?[] { J.S(r["id"]), J.S(r["order"]), Inr(r["amount"]), J.S(r["status"]), J.S(r["reason"]), L(r["attempts"]), J.S(r["last_error"]), J.S(r["created"]) }),
            note: $"Total {Inr(outp["total_value"])}", link: "/admin/refunds")]);
    }

    private static async Task<ToolOutput> SupportTickets(ToolContext ctx, JsonObject a)
    {
        var outp = await ctx.Q.FindTicketsAsync(A(a, "status"), J.Truthy(a["overdue_only"]), A(a, "q"), Limit(a));
        return new ToolOutput(outp, [Table("Support tickets", ["Ticket", "Subject", "Category", "Status", "Priority", "Opened", "Reply due", "Replied"],
            Items(outp).Select(t => new object?[] { J.S(t["number"]), J.S(t["subject"]), J.S(t["category"]), J.S(t["status"]), J.S(t["priority"]), J.S(t["opened"]), J.S(t["reply_due"]),
                J.S(t["replied"]) is { Length: > 0 } r ? r : "—" }), L(outp["total"]), link: "/admin/support")]);
    }

    private static async Task<ToolOutput> PayoutsReport(ToolContext ctx, JsonObject a)
    {
        var outp = await ctx.Q.PayoutsOverviewAsync(A(a, "status"), Limit(a));
        var mets = new List<(string, string, string?)>
        {
            ("Due now", Inr(outp["due_now_total"]), $"{(outp["due_now"] as JsonArray)!.Count} sellers"), ("On hold", Inr(outp["on_hold_total"]), "inside return windows"),
        };
        mets.AddRange(((JsonObject)outp["by_status"]!).Select(kv => (char.ToUpperInvariant(kv.Key[0]) + kv.Key[1..], Num(kv.Value), (string?)null)));
        return new ToolOutput(outp,
        [
            Metrics("Seller payouts", mets),
            Table("Recent payouts", ["Payout", "Seller", "Amount", "Status", "Method", "UTR", "Created", "Paid"],
                Items(outp).Select(p => new object?[] { J.S(p["number"]), J.S(p["seller"]), Inr(p["amount"]), J.S(p["status"]), J.S(p["mode"]), J.S(p["utr"]), J.S(p["created"]), J.S(p["paid"]) }),
                link: "/admin/payouts"),
        ]);
    }

    private static async Task<ToolOutput> Coupons(ToolContext ctx, JsonObject a)
    {
        var outp = await ctx.Q.CouponsOverviewAsync(J.Truthy(a["active_only"]));
        return new ToolOutput(outp, [Table("Coupons", ["Code", "Discount", "Min order", "Cap", "Used", "Limit", "Ends", "Active", "Paid by"],
            Items(outp).Select(c => new object?[] { J.S(c["code"]), J.S(c["kind"]) == "percent" ? $"{L(c["value"])}%" : Inr(c["value"]), Inr(c["min_order"]),
                c["max_discount"] is null || L(c["max_discount"]) == 0 ? "—" : Inr(c["max_discount"]), L(c["used"]), c["usage_limit"] is null || L(c["usage_limit"]) == 0 ? "∞" : J.S(c["usage_limit"]),
                J.S(c["ends"]) is { Length: > 0 } e ? e : "—", J.Truthy(c["active"]) ? "yes" : "no", J.S(c["funded_by"]) }), link: "/admin/coupons")]);
    }

    private static async Task<ToolOutput> GstTcsReport(ToolContext ctx, JsonObject a)
    {
        var month = J.S(a["month"]);
        if (!Regex.IsMatch(month, @"^\d{4}-(0[1-9]|1[0-2])$")) return ToolOutput.Error("month must look like 2026-10");
        var data = await ctx.Q.TcsReportAsync(month);
        return new ToolOutput(data, [Table($"GST TCS {month}", ["GSTIN", "Legal name", "Packages", "Returned", "Net taxable", "IGST TCS", "CGST TCS", "SGST TCS"],
            Items(data).Select(i => new object?[] { J.S(i["gstin"]), J.S(i["legal_name"]), L(i["sub_orders"]), Inr(i["returned_value"]), Inr(i["net_taxable_value"]), Inr(i["igst_tcs"]),
                Inr(i["cgst_tcs"]), Inr(i["sgst_tcs"]) }), link: "/admin/reports")]);
    }

    private static async Task<ToolOutput> MarketplaceSettings(ToolContext ctx, JsonObject a)
    {
        var cfg = await AiShared.MarketplaceAsync(ctx.Ai);
        var show = cfg.Select(kv =>
        {
            var v = kv.Value;
            var text = kv.Key.EndsWith("_paise") ? Inr(v) : kv.Key.EndsWith("_bps") ? $"{((J.Double(v) ?? 0) / 100).ToString("0.##", Inv)}%"
                : J.IsBool(v) ? (J.Truthy(v) ? "on" : "off") : J.S(v);
            return new object?[] { kv.Key.Replace('_', ' '), text };
        }).ToList();
        // integration status belongs to the integrations module: only the AI provider's state is known here
        var integ = new JsonArray();
        if (ctx.Permissions.Contains("integrations"))
        {
            var key = await ctx.AnthropicKey.GetAsync();
            integ.Add(J.O(("name", "AI provider (Claude by Anthropic)"), ("on", key.ApiKey.Length > 0), ("mode", "")));
        }
        var cards = new List<JsonObject> { Table("Marketplace settings", ["Setting", "Value"], show, link: "/admin/settings") };
        if (integ.Count > 0)
            cards.Add(Table("Integrations", ["Integration", "Connected", "Mode"], integ.OfType<JsonObject>().Select(i => new object?[] { J.S(i["name"]), J.Truthy(i["on"]) ? "yes" : "no", J.S(i["mode"]) }),
                link: "/admin/integrations"));
        return new ToolOutput(J.O(("settings", cfg), ("integrations", integ), ("setting_keys_note", "*_paise are paise, *_bps are basis points (100 = 1%)")), cards);
    }

    // ---------------------------------------------------------------- exports

    private static readonly Lazy<Dictionary<string, JsonObject>> Exports = new(() =>
        RefData.Arr("exports").OfType<JsonObject>().ToDictionary(e => J.S(e["name"])));

    private static async Task<ToolOutput> PrepareExport(ToolContext ctx, JsonObject a)
    {
        if (!Exports.Value.TryGetValue(J.S(a["name"]), out var spec)) return ToolOutput.Error($"Unknown export. Choose from: {string.Join(", ", Exports.Value.Keys)}");
        if (!ctx.Permissions.Contains(J.S(spec["permission"]))) return ToolOutput.Error($"Your role cannot download {J.S(spec["label"])}.");
        var fmt = A(a, "format") ?? "xlsx";
        var filters = (spec["filters"] as JsonArray ?? []).Select(J.S).ToHashSet();
        var headers = (spec["headers"] as JsonArray ?? []).Select(J.S).ToList();
        var q = new List<(string, string)>();
        var needsMonth = J.Truthy(spec["needs_month"]);
        var dateLabel = J.S(spec["date_label"]);
        Period? period = null;
        try
        {
            if (needsMonth) q.Add(("month", J.S(a["month"])));
            else if (dateLabel.Length > 0)
            {
                period = PeriodOf(a, "last_30_days");
                q.Add(("from", period.FirstDay.ToString("yyyy-MM-dd", Inv)));
                q.Add(("to", period.LastDay.ToString("yyyy-MM-dd", Inv)));
            }
            foreach (var k in new[] { "status", "q", "payment_method", "low_stock" })
                if (a[k] is { } v && J.S(v) != "" && (k == "status" || filters.Contains(k))) q.Add((k, J.S(v)));
            if (A(a, "seller") is { } sref && filters.Contains("seller") && await ctx.Q.ResolveSellerAsync(sref) is { } s) q.Add(("seller", s.Id.ToString()));
            foreach (var c in (a["columns"] as JsonArray ?? []).Select(J.S))
                if (headers.Contains(c)) q.Add(("columns", c));
            // the export's own checks (reference exports.parse_context and pick_columns)
            var status = q.FirstOrDefault(x => x.Item1 == "status").Item2;
            var statuses = (spec["statuses"] as JsonArray ?? []).OfType<JsonArray>().ToDictionary(x => J.S(x[0]), x => J.S(x[1]));
            if (!string.IsNullOrEmpty(status) && !statuses.ContainsKey(status)) throw new ArgumentException("That status cannot be used for this export");
            if (q.FirstOrDefault(x => x.Item1 == "payment_method").Item2 is { } pm && pm is not ("cod" or "online")) throw new ArgumentException("Payment must be cod or online");
            if (q.FirstOrDefault(x => x.Item1 == "low_stock").Item2 is { } ls && (!int.TryParse(ls, out var n) || n < 0 || n > 100_000))
                throw new ArgumentException("Low stock must be a whole number");
            if (needsMonth && !Regex.IsMatch(q.First(x => x.Item1 == "month").Item2, @"^\d{4}-(0[1-9]|1[0-2])$")) throw new ArgumentException("Choose a month");
            var wanted = q.Where(x => x.Item1 == "columns").Select(x => x.Item2).ToList();
            var pdfCols = (spec["pdf_columns"] as JsonArray ?? []).Select(J.S).ToList();
            var chosen = wanted.Count > 0 ? wanted : fmt == "pdf" ? (pdfCols.Count > 0 ? pdfCols : headers.Take(DocGen.PdfMaxColumns).ToList()) : headers;
            if (fmt == "pdf" && headers.Count(chosen.Contains) > DocGen.PdfMaxColumns)
                throw new ArgumentException($"A PDF fits at most {DocGen.PdfMaxColumns} columns. Choose fewer, or download Excel for all of them.");
            var summary = new List<string>();
            if (needsMonth) summary.Add($"Month: {q.First(x => x.Item1 == "month").Item2}");
            else if (period != null) summary.Add($"Dates ({dateLabel}): {period.FirstDay.ToString("dd MMM yyyy", Inv)} to {period.LastDay.ToString("dd MMM yyyy", Inv)}");
            if (!string.IsNullOrEmpty(status)) summary.Add($"Status: {statuses.GetValueOrDefault(status, status)}");
            var filterLabels = RefData.Obj("export_filters");
            foreach (var (k, v) in q.Where(x => x.Item1 is not ("from" or "to" or "month" or "columns" or "status")))
            {
                var label = J.S(filterLabels[k]?["label"]);
                summary.Add($"{label}: {(k == "payment_method" ? (v == "cod" ? "Cash on delivery" : "Paid online") : v)}");
            }
            var path = $"/api/admin/exports/{J.S(spec["name"])}.{fmt}?" + string.Join("&", q.Select(x => $"{Uri.EscapeDataString(x.Item1)}={Uri.EscapeDataString(x.Item2).Replace("%20", "+")}"));
            var detail = string.Join(" · ", summary);
            var card = J.O(("type", "file"), ("title", J.S(spec["label"])), ("format", fmt), ("path", path), ("filename", $"{J.S(spec["name"])}.{fmt}"), ("detail", detail));
            return new ToolOutput(J.O(("ready", true), ("export", J.S(spec["label"])), ("format", fmt), ("filters", detail)), [card]);
        }
        catch (ArgumentException exc)
        {
            return ToolOutput.Error(exc.Message);
        }
    }

    // ---------------------------------------------------------------- files

    private static async Task<AssistantUploadModel?> UploadOf(ToolContext ctx, JsonObject a)
    {
        var refId = A(a, "file_id") ?? (ctx.UploadIds.Count > 0 ? ctx.UploadIds[^1] : null);
        if (refId is null || !Guid.TryParse(refId, out var id)) return null;
        var up = await ctx.Dal.UploadAsync(id);
        return up != null && up.UserId == ctx.User.Id ? up : null;
    }

    private static async Task<ToolOutput> FileOverview(ToolContext ctx, JsonObject a)
    {
        var up = await UploadOf(ctx, a);
        if (up is null) return ToolOutput.Error("No uploaded file found. Ask the person to attach one.");
        var prof = Uploads.Profile(up);
        if (J.S(prof["kind"]) == "text") return new ToolOutput(prof);
        var cols = Items(prof, "columns").Select(c => new object?[] { J.S(c["name"]), J.S(c["type"]), L(c["filled"]), L(c["distinct"]), J.S(c["sum"]), J.S(c["min"]), J.S(c["max"]) });
        return new ToolOutput(prof, [Table($"{up.Filename} · {up.RowCount.ToString("N0", Inv)} rows", ["Column", "Type", "Filled", "Distinct", "Sum", "Min", "Max"], cols,
            note: up.Truncated ? "Only the first 50,000 rows were read." : "")]);
    }

    private static async Task<ToolOutput> FileQuery(ToolContext ctx, JsonObject a)
    {
        var up = await UploadOf(ctx, a);
        if (up is null) return ToolOutput.Error("No uploaded file found.");
        JsonObject outp;
        try
        {
            outp = Uploads.Query(up, a["filters"] as JsonArray, A(a, "group_by"), A(a, "metric") ?? "count", A(a, "value_column"), A(a, "sort") ?? "desc", Limit(a, 50, 500));
        }
        catch (ArgumentException exc)
        {
            return ToolOutput.Error(exc.Message);
        }
        var label = $"{J.S(outp["metric"])}{(J.S(outp["value_column"]).Length > 0 ? " of " + J.S(outp["value_column"]) : "")}";
        if (outp.ContainsKey("items"))
        {
            var items = Items(outp).ToList();
            var gb = J.S(a["group_by"]);
            return new ToolOutput(outp,
            [
                Table($"{up.Filename}: {label} by {gb}", [gb, label, "Rows"], items.Select(i => new object?[] { J.S(i["group"]), J.S(i["value"]), L(i["rows"]) }),
                    note: $"{L(outp["matched_rows"]).ToString("N0", Inv)} rows matched."),
                Chart($"{label} by {gb}", "bar", items.Take(20).Select(i => J.S(i["group"])), [(label, items.Take(20).Select(i => double.Parse(J.S(i["value"]), Inv)))]),
            ]);
        }
        return new ToolOutput(outp, [Metrics(up.Filename, [(char.ToUpperInvariant(label[0]) + label[1..], J.S(outp["value"]), null),
            ("Rows matched", L(outp["matched_rows"]).ToString("N0", Inv), null)])]);
    }

    private static async Task<ToolOutput> FileCompare(ToolContext ctx, JsonObject a)
    {
        var up = await UploadOf(ctx, a);
        if (up is null) return ToolOutput.Error("No uploaded file found.");
        var entity = J.S(a["entity"]);
        var need = entity switch { "orders" or "packages" => "orders", "products" => "catalog", "payouts" => "payouts", "customers" => "customers", "sellers" => "sellers", _ => "" };
        if (need.Length > 0 && !ctx.Permissions.Contains(need)) return ToolOutput.Error($"Your role cannot read live {entity}.");
        JsonObject outp;
        try
        {
            outp = await Uploads.CompareAsync(ctx.Dal, up, entity, A(a, "key_column"), a["columns"] as JsonObject);
        }
        catch (ArgumentException exc)
        {
            return ToolOutput.Error(exc.Message);
        }
        var mets = new List<(string, string, string?)>
        {
            ("Rows with a key", Num(outp["rows_with_key"]), null), ("Matched", Num(outp["matched"]), null), ("Identical", Num(outp["rows_identical"]), null),
            ("Different", Num(outp["rows_with_differences"]), null), ("Not found live", Num(outp["not_found_in_live"]), null),
        };
        mets.AddRange(((JsonObject)outp["totals"]!).Select(kv => ($"{kv.Key} total (file / live)", $"{J.S(kv.Value!["file"])} / {J.S(kv.Value!["live"])}",
            (string?)$"difference {J.S(kv.Value!["difference"])}")));
        var compared = ((JsonObject)outp["compared_columns"]!).Select(kv => $"{kv.Key} ← {J.S(kv.Value)}").ToList();
        var cards = new List<JsonObject>
        {
            Metrics($"{up.Filename} vs live {J.S(outp["entity"])}", mets,
                $"Matched on column “{J.S(outp["key_column"])}”. Compared: {(compared.Count > 0 ? string.Join(", ", compared) : "presence only")}."),
        };
        var diffs = Items(outp, "differences").ToList();
        if (diffs.Count > 0)
            cards.Add(Table("Differences", ["Key", "Field", "In file", "Live"],
                diffs.SelectMany(d => Items(d, "differences").Select(x => new object?[] { J.S(d["key"]), J.S(x["field"]), J.S(x["file"]), J.S(x["live"]) }))));
        if (outp["not_found"] is JsonArray nf && nf.Count > 0) cards.Add(Table("Not found in live data", ["Key"], nf.Select(k => new object?[] { J.S(k) })));
        return new ToolOutput(outp, cards);
    }

    // ---------------------------------------------------------------- actions, navigation, memory

    private static async Task<ToolOutput> ProposeAction(ToolContext ctx, JsonObject a)
    {
        var kind = J.S(a["kind"]);
        try
        {
            var act = await ctx.Actions.PrepareAsync(ctx.User, ctx.ConversationId, kind, a["params"] as JsonObject ?? []);
            var result = J.Obj(act.Result);
            var card = J.O(("type", "action"), ("action_id", act.Id.ToString()), ("kind", act.Kind), ("summary", act.Summary), ("details", result["details"]?.DeepClone() ?? new JsonArray()),
                ("status", "pending"));
            return new ToolOutput(J.O(("prepared", true), ("summary", act.Summary), ("note", "Waiting for the person to press Confirm. Do not say it is done.")), [card]);
        }
        catch (ActionException exc)
        {
            return new ToolOutput(J.O(("error", exc.Message), ("params_needed", AssistantActions.Defs.TryGetValue(kind, out var def) ? def["params"]?.DeepClone() : null)));
        }
    }

    private static Task<ToolOutput> OpenPage(ToolContext ctx, JsonObject a)
    {
        if (!Pages.TryGetValue(J.S(a["page"]), out var page) || !ctx.Permissions.Contains(page.Permission))
            return Task.FromResult(ToolOutput.Error("That page is not available for your role."));
        return Task.FromResult(new ToolOutput(J.O(("link", page.Href)),
            [J.O(("type", "links"), ("title", "Open"), ("items", new JsonArray(J.O(("label", page.Label), ("href", page.Href)))))]));
    }

    private static async Task<ToolOutput> Remember(ToolContext ctx, JsonObject a)
    {
        var notes = await AssistantSettings.MemoriesAsync(ctx.Ai, ctx.User.Id);
        if (J.Long(a["forget"]) is { } f and not 0)
        {
            var i = (int)f - 1;
            if (i >= 0 && i < notes.Count) notes.RemoveAt(i);
        }
        if (A(a, "note") is { } note) notes.Add(note);
        notes = await AssistantSettings.SetMemoriesAsync(ctx.Ai, ctx.User.Id, notes);
        return new ToolOutput(J.O(("saved_notes", J.Strings(notes))));
    }

    // ---------------------------------------------------------------- execution

    public static string ModelView(JsonNode? data, bool shareContacts, int limit = 14000)
    {
        var text = J.Dumps(shareContacts ? data : Mask(data));
        if (text.Length > limit) text = text[..limit] + "…\" (truncated: the screen shows the full table; summarise what is here)";
        return text;
    }

    /// <summary>Runs a tool after re-checking the permission. Returns (output, is_error).</summary>
    public static async Task<(ToolOutput Output, bool IsError)> ExecuteAsync(ToolContext ctx, string name, JsonObject? args)
    {
        if (!Tools.TryGetValue(name, out var t) || !Handlers.TryGetValue(name, out var h)) return (ToolOutput.Error($"Unknown tool {name}"), true);
        if (!t.AnyOf.Any(ctx.Permissions.Contains)) return (ToolOutput.Error("Your role does not allow this."), true);
        try
        {
            var outp = await h(ctx, args ?? []);
            return (outp, outp.Data is JsonObject o && o.ContainsKey("error"));
        }
        catch (ArgumentException exc)
        {
            return (ToolOutput.Error(exc.Message), true);
        }
    }
}
