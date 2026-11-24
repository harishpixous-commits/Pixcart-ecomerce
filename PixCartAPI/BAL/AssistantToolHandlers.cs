namespace BAL;

using System.Text.Json.Nodes;
using DAL;
using Utils;

/// <summary>
/// The assistant tool handlers whose backing queries are ported (reference: app/assistant/tools.py).
/// gst_tcs_report, marketplace_settings, prepare_export, file_overview/file_query/file_compare and
/// propose_action stay unregistered until their services (reports, settings/integrations, exports,
/// uploads, actions) are ported.
/// </summary>
public partial class AssistantToolsBAL
{
    private static readonly string[] Dashboard = ["dashboard"];

    private Dictionary<string, ExecutableTool> BuildRegistry() => new()
    {
        ["business_overview"] = new("business_overview", Dashboard, BusinessOverviewAsync),
        ["sales_breakdown"] = new("sales_breakdown", Dashboard, SalesBreakdownAsync),
        ["work_queue"] = new("work_queue", Dashboard, WorkQueueAsync),
        ["find_orders"] = new("find_orders", ["orders"], FindOrdersAsync),
        ["order_details"] = new("order_details", ["orders"], OrderDetailsAsync),
        ["find_customers"] = new("find_customers", ["customers"], FindCustomersAsync),
        ["customer_profile"] = new("customer_profile", ["customers"], CustomerProfileAsync),
        ["find_products"] = new("find_products", ["catalog"], FindProductsAsync),
        ["stock_alerts"] = new("stock_alerts", ["catalog", "sellers"], StockAlertsAsync),
        ["find_sellers"] = new("find_sellers", ["sellers"], FindSellersAsync),
        ["seller_profile"] = new("seller_profile", ["sellers"], SellerProfileAsync),
        ["returns_report"] = new("returns_report", ["orders", "refunds"], ReturnsReportAsync),
        ["refunds_report"] = new("refunds_report", ["refunds", "orders"], RefundsReportAsync),
        ["support_tickets"] = new("support_tickets", ["support"], SupportTicketsAsync),
        ["payouts_report"] = new("payouts_report", ["payouts"], PayoutsReportAsync),
        ["coupons"] = new("coupons", ["marketing"], CouponsAsync),
        ["open_page"] = new("open_page", Dashboard, OpenPageAsync),
        ["remember"] = new("remember", ["assistant"], RememberAsync),
    };

    // ----------------------------------------------------------------------------- business numbers

    private async Task<AssistantToolOutput> BusinessOverviewAsync(AssistantToolContext ctx, JsonObject a)
    {
        var p = PeriodArg(a);
        var sellerRef = Str(a, "seller");
        var catRef = Str(a, "category");
        var seller = sellerRef is not null ? await q.ResolveSellerAsync(sellerRef) : null;
        var cat = catRef is not null ? await q.ResolveCategoryAsync(catRef) : null;
        if (sellerRef is not null && seller is null)
            return new AssistantToolOutput(new JsonObject { ["error"] = $"No single seller matches '{sellerRef}'. Use find_sellers first." }, []);
        if (catRef is not null && cat is null)
            return new AssistantToolOutput(new JsonObject { ["error"] = $"No single category matches '{catRef}'." }, []);
        var sellerId = seller is not null ? Guid.Parse(seller.Id) : (Guid?)null;
        var catId = cat is not null ? Guid.Parse(cat.Id) : (Guid?)null;
        var cur = await q.SalesSummaryAsync(p, sellerId, catId, Str(a, "payment_method"), Str(a, "state_code"));
        var compare = a["compare"] is not JsonValue cjv || !cjv.TryGetValue<bool>(out var cb) || cb;
        var prev = compare ? await q.SalesSummaryAsync(p.Previous(), sellerId, catId, Str(a, "payment_method"), Str(a, "state_code")) : null;
        var scope = string.Join(" · ", new[]
        {
            seller?.DisplayName ?? "", cat?.Name ?? "",
            Str(a, "payment_method") == "cod" ? "Cash on delivery" : Str(a, "payment_method") == "online" ? "Paid online" : "",
        }.Where(x => x.Length > 0));

        string? D(string k) => prev is not null ? Delta(Lng(cur, k), Lng(prev, k)) : null;

        var items = new List<(string, string, string?)>
        {
            ("Sales", AssistantQueriesDAL.Inr(Lng(cur, "sales")), D("sales")),
            ("Orders", AssistantQueriesDAL.Num(Lng(cur, "orders")), D("orders")),
            ("Average order", AssistantQueriesDAL.Inr(Lng(cur, "average_order_value")), D("average_order_value")),
            ("Units sold", AssistantQueriesDAL.Num(Lng(cur, "units")), D("units")),
            ("Net after returns", AssistantQueriesDAL.Inr(Lng(cur, "net_sales")), null),
            ("Commission earned", AssistantQueriesDAL.Inr(Lng(cur, "commission")), D("commission")),
            ("Cancelled packages", $"{AssistantQueriesDAL.Num(Lng(cur, "cancelled_packages"))} ({(cur["cancellation_rate_pct"]?.GetValue<double>() ?? 0):0.#}%)", null),
            ("COD / online orders", $"{Lng(cur, "cod_orders")} / {Lng(cur, "online_orders")}", null),
        };
        if (cur.ContainsKey("new_customers"))
            items.Add(("New customers", AssistantQueriesDAL.Num(Lng(cur, "new_customers")), D("new_customers")));
        var data = new JsonObject
        {
            ["current"] = cur, ["previous"] = prev,
            ["definitions"] = new JsonObject
            {
                ["sales"] = "package totals excluding cancelled ones and unpaid online orders",
                ["orders"] = "orders with at least one package placed", ["amounts"] = "integer paise; divide by 100 for rupees",
            },
        };
        var note = prev is not null ? "IST calendar days. Compared with the previous period of the same length." : "";
        return new AssistantToolOutput(data,
            [MetricsCard($"{p.Label}{(scope.Length > 0 ? " · " + scope : "")}", items, note)]);
    }

    private async Task<AssistantToolOutput> SalesBreakdownAsync(AssistantToolContext ctx, JsonObject a)
    {
        var p = PeriodArg(a, "last_7_days");
        var seller = Str(a, "seller") is { } sr ? await q.ResolveSellerAsync(sr) : null;
        var cat = Str(a, "category") is { } cr ? await q.ResolveCategoryAsync(cr) : null;
        var output = await q.SalesBreakdownAsync(p, Str(a, "by") ?? "day",
            seller is not null ? Guid.Parse(seller.Id) : null, cat is not null ? Guid.Parse(cat.Id) : null,
            Str(a, "payment_method"), LimitArg(a, 10, 100));
        var by = Txt(output, "by");
        var items = output["items"]!.AsArray();
        var labels = items.Select(i => Txt(i!.AsObject(), "label")).ToList();
        var hasUnits = by is "category" or "product";
        var second = hasUnits ? "units" : "orders";
        var rows = items.Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "label"), AssistantQueriesDAL.Inr(Lng(o, "sales")), AssistantQueriesDAL.Num(Lng(o, second)));
        });
        var kind = by is "day" or "week" or "month" or "hour" && labels.Count > 2 ? "line" : "bar";
        var byLabel = System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(by.Replace('_', ' '));
        var cards = new List<JsonObject>
        {
            ChartCard($"Sales by {by.Replace('_', ' ')} · {p.Label}", kind, labels,
                [("Sales (₹)", items.Select(i => Math.Round(Lng(i!.AsObject(), "sales") / 100.0, 2)))], "₹"),
            TableCard($"Sales by {by.Replace('_', ' ')}", [byLabel, "Sales", hasUnits ? "Units" : "Orders"], rows),
        };
        return new AssistantToolOutput(output, cards);
    }

    private async Task<AssistantToolOutput> WorkQueueAsync(AssistantToolContext ctx, JsonObject a)
    {
        var queue = await q.PendingWorkAsync();
        var labels = new Dictionary<string, (string Label, string Href)>
        {
            ["sellers_to_review"] = ("Sellers to review", "/admin/sellers?status=submitted"),
            ["listings_to_review"] = ("Listings to review", "/admin/products"),
            ["packages_late_to_ship_48h"] = ("Packages not shipped in 48 h", "/admin/orders"),
            ["returns_waiting"] = ("Returns waiting", "/admin/returns"),
            ["refunds_failed"] = ("Failed refunds", "/admin/refunds"),
            ["tickets_reply_overdue"] = ("Tickets past reply time", "/admin/support"),
            ["tickets_open"] = ("Open tickets", "/admin/support"),
            ["reviews_to_moderate"] = ("Reviews to moderate", "/admin/reviews"),
            ["payouts_failed"] = ("Failed payouts", "/admin/payouts"),
            ["out_of_stock_options"] = ("Options out of stock", "/admin/products"),
        };
        var items = labels.Select(kv => ((string, string, string?))(kv.Value.Label, AssistantQueriesDAL.Num(Lng(queue, kv.Key)), null));
        var links = labels.Where(kv => Lng(queue, kv.Key) != 0 && PageAllowed(kv.Value.Href, ctx.Permissions))
            .Select(kv => (kv.Value.Label, kv.Value.Href)).ToList();
        var cards = new List<JsonObject> { MetricsCard("Waiting for you", items) };
        if (links.Count > 0) cards.Add(LinksCard(links));
        return new AssistantToolOutput(queue, cards);
    }

    // ----------------------------------------------------------------------------- orders and customers

    private async Task<AssistantToolOutput> FindOrdersAsync(AssistantToolContext ctx, JsonObject a)
    {
        AssistantPeriods.Period? p = BoolArg(a, "all_time") || (Str(a, "q") is not null && Str(a, "period") is null) || a.ContainsKey("late_to_ship_hours")
            ? null
            : PeriodArg(a, "last_30_days");
        var seller = Str(a, "seller") is { } sr ? await q.ResolveSellerAsync(sr) : null;
        int? lateHours = null;
        if (a["late_to_ship_hours"] is { } lv) lateHours = (int)lv.GetValue<long>();
        var output = await q.FindPackagesAsync(p, Str(a, "status"), Str(a, "q"),
            seller is not null ? Guid.Parse(seller.Id) : null, Str(a, "payment_method"), lateHours, LimitArg(a));
        var items = output["items"]!.AsArray();
        var rows = items.Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "package"), Txt(o, "order"), Txt(o, "placed"), Txt(o, "status"), Txt(o, "seller"),
                Txt(o, "customer"), Txt(o, "payment"), AssistantQueriesDAL.Inr(Lng(o, "total")), Txt(o, "city"));
        }).ToList();
        var title = $"Packages{(p is not null ? " · " + p.Label : "")}{(Str(a, "status") is { } st ? " · " + st : "")}";
        var total = Lng(output, "total");
        var note = total > rows.Count
            ? $"Showing {rows.Count} of {total} (total value {AssistantQueriesDAL.Inr(Lng(output, "total_value"))})."
            : $"Total value {AssistantQueriesDAL.Inr(Lng(output, "total_value"))}.";
        return new AssistantToolOutput(output,
            [TableCard(title, ["Package", "Order", "Placed", "Status", "Seller", "Customer", "Payment", "Total", "City"], rows, total, note, "/admin/orders")]);
    }

    private async Task<AssistantToolOutput> OrderDetailsAsync(AssistantToolContext ctx, JsonObject a)
    {
        var d = await q.OrderDetailAsync(Str(a, "reference") ?? "");
        if (d is null)
            return new AssistantToolOutput(new JsonObject { ["error"] = "No order, package or AWB with that number." }, []);
        var customer = d["customer"]!.AsObject();
        var cards = new List<JsonObject>
        {
            MetricsCard($"Order {Txt(d, "number")}",
            [
                ("Status", Txt(d, "status"), null), ("Placed", Txt(d, "placed"), null),
                ("Payment", $"{Txt(d, "payment_method").ToUpperInvariant()} · {Txt(d, "payment_status")}", null),
                ("Total", AssistantQueriesDAL.Inr(Lng(d, "grand_total")), null),
                ("Refunded", AssistantQueriesDAL.Inr(Lng(d, "refunded_total")), null),
                ("Customer", Txt(customer, "name").Length > 0 ? Txt(customer, "name") : Txt(customer, "phone"), null),
            ]),
            TableCard("Items", ["SKU", "Item", "Option", "Qty", "Unit price", "Line total", "Returned"],
                d["items"]!.AsArray().Select(i =>
                {
                    var o = i!.AsObject();
                    return Row(Txt(o, "sku"), Txt(o, "title"), Txt(o, "option"), Lng(o, "qty"),
                        AssistantQueriesDAL.Inr(Lng(o, "unit_price")), AssistantQueriesDAL.Inr(Lng(o, "line_total")), Lng(o, "returned_qty"));
                })),
            TableCard("Packages", ["Package", "Seller", "Status", "Total", "Courier", "AWB", "Delivered"],
                d["packages"]!.AsArray().Select(i =>
                {
                    var o = i!.AsObject();
                    return Row(Txt(o, "package"), Txt(o, "seller"), Txt(o, "status"), AssistantQueriesDAL.Inr(Lng(o, "total")),
                        Txt(o, "courier"), Txt(o, "awb"), Txt(o, "delivered"));
                }), link: $"/admin/orders/{Txt(d, "order_id")}"),
        };
        if (d["timeline"] is JsonArray tl && tl.Count > 0)
            cards.Add(TableCard("Timeline", ["When", "Change", "By", "Note"],
                tl.Select(t =>
                {
                    var o = t!.AsObject();
                    return Row(Txt(o, "at"), Txt(o, "change"), Txt(o, "by"), Txt(o, "note"));
                })));
        return new AssistantToolOutput(d, cards);
    }

    private async Task<AssistantToolOutput> FindCustomersAsync(AssistantToolContext ctx, JsonObject a)
    {
        AssistantPeriods.Period? p = Str(a, "period") is not null || Str(a, "date_from") is not null ? PeriodArg(a) : null;
        var output = await q.FindCustomersAsync(Str(a, "q"), p, Str(a, "sort") ?? "recent", LimitArg(a));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            var active = o["active"]?.GetValue<bool>() ?? false;
            return Row(Txt(o, "name"), Txt(o, "phone"), Txt(o, "email"), Txt(o, "joined"), Lng(o, "orders"),
                AssistantQueriesDAL.Inr(Lng(o, "spent")), Txt(o, "last_order"), active ? "yes" : "blocked");
        });
        return new AssistantToolOutput(output,
            [TableCard($"Customers{(p is not null ? " · " + p.Label : "")}", ["Name", "Mobile", "Email", "Joined", "Orders", "Spent", "Last order", "Active"],
                rows, Lng(output, "total"), link: "/admin/customers")]);
    }

    private async Task<AssistantToolOutput> CustomerProfileAsync(AssistantToolContext ctx, JsonObject a)
    {
        var d = await q.CustomerDetailAsync(Str(a, "reference") ?? "");
        if (d is null)
            return new AssistantToolOutput(new JsonObject { ["error"] = "No single customer matches. Try the mobile number or email." }, []);
        var name = Txt(d, "name").Length > 0 ? Txt(d, "name") : Txt(d, "phone");
        var cards = new List<JsonObject>
        {
            MetricsCard(name,
            [
                ("Mobile", Txt(d, "phone"), null), ("Email", Txt(d, "email").Length > 0 ? Txt(d, "email") : "—", null),
                ("Joined", Txt(d, "joined"), null), ("Orders", AssistantQueriesDAL.Num(Lng(d, "orders")), null),
                ("Net spend", AssistantQueriesDAL.Inr(Lng(d, "net_spend")), null),
                ("Average order", AssistantQueriesDAL.Inr(Lng(d, "average_order_value")), null),
                ("Returns", AssistantQueriesDAL.Num(Lng(d, "returns")), null),
                ("Cancelled packages", AssistantQueriesDAL.Num(Lng(d, "cancelled_packages")), null),
                ("Account", d["active"]?.GetValue<bool>() == true ? "active" : "blocked", null),
            ]),
            TableCard("Recent orders", ["Order", "Placed", "Status", "Payment", "Total"],
                d["recent_orders"]!.AsArray().Select(i =>
                {
                    var o = i!.AsObject();
                    return Row(Txt(o, "number"), Txt(o, "placed"), Txt(o, "status"), Txt(o, "payment"), AssistantQueriesDAL.Inr(Lng(o, "total")));
                })),
        };
        if (d["tickets"] is JsonArray tk && tk.Count > 0)
            cards.Add(TableCard("Support tickets", ["Ticket", "Subject", "Status"],
                tk.Select(t =>
                {
                    var o = t!.AsObject();
                    return Row(Txt(o, "number"), Txt(o, "subject"), Txt(o, "status"));
                })));
        return new AssistantToolOutput(d, cards);
    }

    // ----------------------------------------------------------------------------- catalogue and sellers

    private async Task<AssistantToolOutput> FindProductsAsync(AssistantToolContext ctx, JsonObject a)
    {
        var seller = Str(a, "seller") is { } sr ? await q.ResolveSellerAsync(sr) : null;
        var cat = Str(a, "category") is { } cr ? await q.ResolveCategoryAsync(cr) : null;
        int? maxStock = a["max_stock"] is { } mv ? (int)mv.GetValue<long>() : null;
        var output = await q.FindProductsAsync(Str(a, "q"), Str(a, "status"),
            seller is not null ? Guid.Parse(seller.Id) : null, cat is not null ? Guid.Parse(cat.Id) : null,
            maxStock, Str(a, "sort") ?? "recent", LimitArg(a));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "title"), Txt(o, "sku"), Txt(o, "seller"), Txt(o, "category"), Txt(o, "status"),
                AssistantQueriesDAL.Inr(Lng(o, "price")), AssistantQueriesDAL.Inr(Lng(o, "mrp")), Lng(o, "stock"), Lng(o, "sold"),
                $"{(o["rating"]?.GetValue<double>() ?? 0):0.0} ({Lng(o, "reviews")})");
        });
        return new AssistantToolOutput(output,
            [TableCard("Listings", ["Product", "SKU", "Seller", "Category", "Status", "Price", "MRP", "Stock", "Sold", "Rating"],
                rows, Lng(output, "total"), link: "/admin/products")]);
    }

    private async Task<AssistantToolOutput> StockAlertsAsync(AssistantToolContext ctx, JsonObject a)
    {
        var seller = Str(a, "seller") is { } sr ? await q.ResolveSellerAsync(sr) : null;
        var threshold = a["threshold"] is { } tv ? (int)tv.GetValue<long>() : 5;
        var output = await q.StockAlertsAsync(threshold, seller is not null ? Guid.Parse(seller.Id) : null, LimitArg(a, 50));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "sku"), Txt(o, "product"), Txt(o, "option"), Txt(o, "seller"), Lng(o, "stock"), Lng(o, "sold"));
        });
        return new AssistantToolOutput(output,
            [TableCard($"Stock at or below {Lng(output, "threshold")}", ["SKU", "Product", "Option", "Seller", "Stock", "Sold so far"],
                rows, Lng(output, "total"), note: $"{Lng(output, "out_of_stock")} out of stock in this list.")]);
    }

    private async Task<AssistantToolOutput> FindSellersAsync(AssistantToolContext ctx, JsonObject a)
    {
        var p = PeriodArg(a, "last_30_days");
        var output = await q.FindSellersAsync(Str(a, "q"), Str(a, "status"), p, LimitArg(a));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "store"), Txt(o, "status"), Txt(o, "city"), Txt(o, "gstin"), AssistantQueriesDAL.Inr(Lng(o, "sales")),
                Lng(o, "packages"), Lng(o, "live_listings"), $"{(o["rating"]?.GetValue<double>() ?? 0):0.0}");
        });
        return new AssistantToolOutput(output,
            [TableCard($"Sellers · sales {p.Label}", ["Store", "Status", "City", "GSTIN", "Sales", "Packages", "Live listings", "Rating"],
                rows, Lng(output, "total"), link: "/admin/sellers")]);
    }

    private async Task<AssistantToolOutput> SellerProfileAsync(AssistantToolContext ctx, JsonObject a)
    {
        var seller = await q.ResolveSellerAsync(Str(a, "seller"));
        if (seller is null)
            return new AssistantToolOutput(new JsonObject { ["error"] = "No single seller matches. Use find_sellers." }, []);
        var p = PeriodArg(a, "last_30_days");
        var brief = await ai.SellerRiskAsync(Guid.Parse(seller.Id));
        var d = await q.SellerDetailAsync(seller.Id, p, brief);
        if (d is null)
            return new AssistantToolOutput(new JsonObject { ["error"] = "No single seller matches. Use find_sellers." }, []);
        var sm = d["sales"]!.AsObject();
        var health = d["health"]!.AsObject();
        var cards = new List<JsonObject>
        {
            MetricsCard($"{Txt(d, "store")} · {p.Label}",
            [
                ("Status", Txt(d, "status"), null), ("Sales", AssistantQueriesDAL.Inr(Lng(sm, "sales")), null),
                ("Orders", AssistantQueriesDAL.Num(Lng(sm, "orders")), null),
                ("Payout due now", AssistantQueriesDAL.Inr(Lng(d, "payout_due_now")), null),
                ("On hold (return window)", AssistantQueriesDAL.Inr(Lng(d, "payout_on_hold")), null),
                ("Late to ship", AssistantQueriesDAL.Num(Lng(d, "packages_late_to_ship")), null),
                ("Rating", $"{(d["rating"]?.GetValue<double>() ?? 0):0.0} ({Lng(d, "rating_count")})", null),
                ("Health", $"{Txt(health, "level")} · {Lng(health, "score")}", Txt(health, "headline")),
            ]),
            TableCard("Why", ["Weight", "Reason"],
                (health["factors"] as JsonArray ?? []).Select(f =>
                {
                    var o = f!.AsObject();
                    return Row(Lng(o, "weight"), Txt(o, "text"));
                }), link: $"/admin/sellers/{Txt(d, "id")}"),
        };
        return new AssistantToolOutput(d, cards);
    }

    // ----------------------------------------------------------------------------- returns, refunds, support, payouts, coupons

    private async Task<AssistantToolOutput> ReturnsReportAsync(AssistantToolContext ctx, JsonObject a)
    {
        var p = PeriodArg(a, "last_30_days");
        var seller = Str(a, "seller") is { } sr ? await q.ResolveSellerAsync(sr) : null;
        var output = await q.FindReturnsAsync(p, Str(a, "status"), seller is not null ? Guid.Parse(seller.Id) : null, LimitArg(a));
        var byStatus = output["by_status"]!.AsObject();
        var metricItems = byStatus.Count > 0
            ? byStatus.Select(kv => ((string, string, string?))(System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(kv.Key.Replace('_', ' ')),
                AssistantQueriesDAL.Num(kv.Value!.GetValue<long>()), null)).ToList()
            : [("Returns", "0", null)];
        var cards = new List<JsonObject>
        {
            MetricsCard($"Returns · {p.Label}", metricItems),
            TableCard("Returns", ["Return", "Package", "Seller", "Requested", "Status", "Reason", "Refund"],
                output["items"]!.AsArray().Select(i =>
                {
                    var o = i!.AsObject();
                    return Row(Txt(o, "number"), Txt(o, "package"), Txt(o, "seller"), Txt(o, "requested"), Txt(o, "status"),
                        Txt(o, "reason"), AssistantQueriesDAL.Inr(Lng(o, "refund_amount")));
                }), Lng(output, "total"), link: "/admin/returns"),
        };
        var byReason = output["by_reason"]!.AsObject();
        if (byReason.Count > 0)
            cards.Add(ChartCard("Return reasons", "bar", byReason.Select(kv => kv.Key),
                [("Returns", byReason.Select(kv => (double)kv.Value!.GetValue<long>()))]));
        return new AssistantToolOutput(output, cards);
    }

    private async Task<AssistantToolOutput> RefundsReportAsync(AssistantToolContext ctx, JsonObject a)
    {
        AssistantPeriods.Period? p = Str(a, "period") is not null || Str(a, "date_from") is not null ? PeriodArg(a) : null;
        var output = await q.FindRefundsAsync(Str(a, "status"), p, LimitArg(a));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "id"), Txt(o, "order"), AssistantQueriesDAL.Inr(Lng(o, "amount")), Txt(o, "status"),
                Txt(o, "reason"), Lng(o, "attempts"), Txt(o, "last_error"), Txt(o, "created"));
        });
        return new AssistantToolOutput(output,
            [TableCard($"Refunds{(Str(a, "status") is { } st ? " · " + st : "")}",
                ["Refund id", "Order", "Amount", "Status", "Reason", "Attempts", "Last error", "Created"],
                rows, note: $"Total {AssistantQueriesDAL.Inr(Lng(output, "total_value"))}", link: "/admin/refunds")]);
    }

    private async Task<AssistantToolOutput> SupportTicketsAsync(AssistantToolContext ctx, JsonObject a)
    {
        var output = await q.FindTicketsAsync(Str(a, "status"), BoolArg(a, "overdue_only"), Str(a, "q"), LimitArg(a));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            return Row(Txt(o, "number"), Txt(o, "subject"), Txt(o, "category"), Txt(o, "status"), Txt(o, "priority"),
                Txt(o, "opened"), Txt(o, "reply_due"), Txt(o, "replied").Length > 0 ? Txt(o, "replied") : "—");
        });
        return new AssistantToolOutput(output,
            [TableCard("Support tickets", ["Ticket", "Subject", "Category", "Status", "Priority", "Opened", "Reply due", "Replied"],
                rows, Lng(output, "total"), link: "/admin/support")]);
    }

    private async Task<AssistantToolOutput> PayoutsReportAsync(AssistantToolContext ctx, JsonObject a)
    {
        var output = await q.PayoutsOverviewAsync(Str(a, "status"), LimitArg(a));
        var byStatus = output["by_status"]!.AsObject();
        var metricItems = new List<(string, string, string?)>
        {
            ("Due now", AssistantQueriesDAL.Inr(Lng(output, "due_now_total")), $"{(output["due_now"] as JsonArray)?.Count ?? 0} sellers"),
            ("On hold", AssistantQueriesDAL.Inr(Lng(output, "on_hold_total")), "inside return windows"),
        };
        metricItems.AddRange(byStatus.Select(kv => ((string, string, string?))(
            System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(kv.Key), AssistantQueriesDAL.Num(kv.Value!.GetValue<long>()), null)));
        var cards = new List<JsonObject>
        {
            MetricsCard("Seller payouts", metricItems),
            TableCard("Recent payouts", ["Payout", "Seller", "Amount", "Status", "Method", "UTR", "Created", "Paid"],
                output["items"]!.AsArray().Select(i =>
                {
                    var o = i!.AsObject();
                    return Row(Txt(o, "number"), Txt(o, "seller"), AssistantQueriesDAL.Inr(Lng(o, "amount")), Txt(o, "status"),
                        Txt(o, "mode"), Txt(o, "utr"), Txt(o, "created"), Txt(o, "paid"));
                }), link: "/admin/payouts"),
        };
        return new AssistantToolOutput(output, cards);
    }

    private async Task<AssistantToolOutput> CouponsAsync(AssistantToolContext ctx, JsonObject a)
    {
        var output = await q.CouponsOverviewAsync(BoolArg(a, "active_only"));
        var rows = output["items"]!.AsArray().Select(i =>
        {
            var o = i!.AsObject();
            var active = o["active"]?.GetValue<bool>() ?? false;
            var maxDiscount = Lng(o, "max_discount");
            return Row(Txt(o, "code"), Txt(o, "kind") == "percent" ? $"{Lng(o, "value")}%" : AssistantQueriesDAL.Inr(Lng(o, "value")),
                AssistantQueriesDAL.Inr(Lng(o, "min_order")), maxDiscount != 0 ? AssistantQueriesDAL.Inr(maxDiscount) : "—",
                Lng(o, "used"), o["usage_limit"]?.GetValue<long>() is { } ul && ul > 0 ? ul.ToString() : "∞",
                Txt(o, "ends").Length > 0 ? Txt(o, "ends") : "—", active ? "yes" : "no", Txt(o, "funded_by"));
        });
        return new AssistantToolOutput(output,
            [TableCard("Coupons", ["Code", "Discount", "Min order", "Cap", "Used", "Limit", "Ends", "Active", "Paid by"], rows, link: "/admin/coupons")]);
    }

    // ----------------------------------------------------------------------------- navigation and memory

    private Task<AssistantToolOutput> OpenPageAsync(AssistantToolContext ctx, JsonObject a)
    {
        var page = Str(a, "page");
        if (page is null || !Pages.TryGetValue(page, out var p) || !ctx.Permissions.Contains(p.Permission))
            return Task.FromResult(new AssistantToolOutput(new JsonObject { ["error"] = "That page is not available for your role." }, []));
        return Task.FromResult(new AssistantToolOutput(new JsonObject { ["link"] = p.Href },
            [LinksCard([(p.Label, p.Href)])]));
    }

    private async Task<AssistantToolOutput> RememberAsync(AssistantToolContext ctx, JsonObject a)
    {
        var notes = (await asst.GetMemoryNotesAsync(ctx.UserId)).ToList();
        if (a["forget"] is { } fv)
        {
            var i = (int)fv.GetValue<long>() - 1;
            if (i >= 0 && i < notes.Count) notes.RemoveAt(i);
        }
        if (Str(a, "note") is { } note) notes.Add(note);
        notes = (await asst.SetMemoryNotesAsync(ctx.UserId, notes)).ToList();
        return new AssistantToolOutput(new JsonObject
        {
            ["saved_notes"] = new JsonArray(notes.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray()),
        }, []);
    }
}
