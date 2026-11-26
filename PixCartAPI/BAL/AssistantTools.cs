namespace BAL;

/// <summary>
/// The staff assistant's tool registry (reference: app/assistant/tools.py TOOLS): each tool's name, label,
/// description, permissions and group. It drives the status and settings payloads, the decision layer's tool sets
/// and the tools offered to the model, which AssistantToolsBAL runs.
/// </summary>
public static class AssistantTools
{
    public sealed record ToolDef(string Name, string Label, string Description, string[] AnyOf, string Group);

    public static readonly ToolDef[] All =
    [
        new("business_overview", "Checking the numbers",
            "Sales, orders, average order value, cancellations, returns, commission, COD vs online and new customers for a period. Use for 'how much did we sell', 'today's orders', 'this month's revenue'. Optional filters narrow it to one seller, category, payment method or state.",
            ["dashboard"], "sales"),
        new("sales_breakdown", "Breaking down sales",
            "Sales and orders grouped by day, week, month, hour of day, seller, category, product, state, payment method or package status. Use for trends, charts, comparisons and top-N lists.",
            ["dashboard"], "sales"),
        new("work_queue", "Checking what needs attention",
            "Counts of everything waiting for staff: sellers and listings to review, late packages, returns, failed refunds, overdue tickets, reviews to moderate, failed payouts, out-of-stock options.",
            ["dashboard"], "overview"),
        new("find_orders", "Finding orders",
            "Lists packages (one seller's part of an order) with filters: status, search text (order or package number, customer name or phone, AWB), seller, payment method, period, or packages not shipped after N hours.",
            ["orders"], "orders"),
        new("order_details", "Opening the order",
            "Everything about one order: items, packages, payment, refunds, returns and timeline. Give an order number, package number or AWB.",
            ["orders"], "orders"),
        new("find_customers", "Finding customers",
            "Search customers by name, phone or email, or list top spenders for a period.",
            ["customers"], "customers"),
        new("customer_profile", "Opening the customer",
            "One customer's profile: orders, spend, returns, cancellations, tickets and recent orders. Give a mobile number, email, id or exact name.",
            ["customers"], "customers"),
        new("find_products", "Searching the catalogue",
            "Search listings by title, brand or SKU, filter by status, seller, category or stock, sort by best selling, rating, price or stock.",
            ["catalog"], "catalog"),
        new("stock_alerts", "Checking stock",
            "Live product options with stock at or below a threshold (default 5), lowest first.",
            ["catalog", "sellers"], "catalog"),
        new("find_sellers", "Finding sellers",
            "Search sellers by name, GSTIN or city, filter by status, ranked by sales in a period.",
            ["sellers"], "sellers"),
        new("seller_profile", "Opening the seller",
            "One seller's status, sales for a period, payouts due, listings, late packages and health score with reasons.",
            ["sellers"], "sellers"),
        new("returns_report", "Checking returns",
            "Returns with counts by status and reason; filter by period, status or seller.",
            ["orders", "refunds"], "returns"),
        new("refunds_report", "Checking refunds",
            "Refunds by status (pending, processed, failed) with amounts and errors.",
            ["refunds", "orders"], "returns"),
        new("support_tickets", "Checking the support desk",
            "Support tickets by status, overdue ones (past the 48-hour reply or 30-day resolution limit) or matching text.",
            ["support"], "support"),
        new("payouts_report", "Checking payouts",
            "Money due to sellers now, money on hold in the return window, and recent payouts by status.",
            ["payouts"], "payouts"),
        new("coupons", "Checking coupons",
            "Coupons with value, limits, usage and status.",
            ["marketing"], "marketing"),
        new("gst_tcs_report", "Preparing the TCS report",
            "GST TCS (GSTR-8) for one month: supplier-wise net taxable value and TCS after returns.",
            ["reports"], "reports"),
        new("marketplace_settings", "Reading settings",
            "Current marketplace settings (fees, COD, tax rates, features, payouts), which integrations are connected (never their keys) and the go-live checklist.",
            ["settings", "integrations"], "settings"),
        new("prepare_export", "Preparing the download",
            "Makes a download button for a data export in CSV, Excel (xlsx) or PDF with filters. Exports: orders, order-items, returns, payouts, ledger, tcs, products, stock, sellers, customers, tickets, ai-runs.",
            ["orders", "reports", "payouts", "catalog", "sellers", "customers", "support", "settings"], "exports"),
        new("file_overview", "Reading your file",
            "Columns, types, totals and first rows of a file the person uploaded (defaults to the latest one).",
            ["assistant_files"], "files"),
        new("file_query", "Calculating from your file",
            "Exact counts, sums, averages, min or max over the uploaded file, optionally filtered and grouped.",
            ["assistant_files"], "files"),
        new("file_compare", "Comparing your file with live data",
            "Matches each row of the uploaded file to live orders, packages, products (SKU), payouts, customers or sellers and lists missing records and differences (amounts in rupees, stock, status). Columns are detected from the headers unless given.",
            ["assistant_files"], "files"),
        new("propose_action", "Preparing the change",
            // the reference lists every change kind, so the model asks for one that exists
            "Prepares a change for the person to confirm with a button. Nothing changes until they press Confirm. "
            + $"kinds: {string.Join(", ", AssistantActionDefs.All.Select(x => x.Kind))}. Look records up first so the params are exact.",
            ["assistant_actions"], "actions"),
        new("open_page", "Finding the page",
            "Gives a link to an admin page. Pages: " + string.Join(", ", AssistantToolsBAL.Pages.Keys),
            ["dashboard"], "help"),
        new("remember", "Saving to memory",
            "Saves a short note the person asked you to remember for future chats (preferences, standing instructions). Use forget with the note's number to remove one.",
            ["assistant"], "help"),
    ];

    public static readonly IReadOnlyDictionary<string, ToolDef> ByName = All.ToDictionary(t => t.Name);

    /// <summary>
    /// Reference: Tool.spec() for every tool, in the reference's order: {name, description, input_schema: {type: object,
    /// properties, required}}. Generated from the reference by tools/schema/assistant_tool_specs.py and embedded
    /// (BAL/Assets/assistant/tool-specs.json), so every input schema is exactly the one the reference sends to the model.
    /// </summary>
    public static readonly IReadOnlyList<System.Text.Json.Nodes.JsonObject> Specs = LoadSpecs();

    private static readonly IReadOnlyDictionary<string, System.Text.Json.Nodes.JsonObject> SpecByName =
        Specs.ToDictionary(s => s["name"]!.GetValue<string>());

    private static List<System.Text.Json.Nodes.JsonObject> LoadSpecs()
    {
        using var stream = typeof(AssistantTools).Assembly.GetManifestResourceStream("BAL.Assets.assistant.tool-specs.json")
            ?? throw new InvalidOperationException("The assistant tool specs resource is missing");
        return (System.Text.Json.Nodes.JsonNode.Parse(stream) as System.Text.Json.Nodes.JsonArray ?? [])
            .OfType<System.Text.Json.Nodes.JsonObject>().ToList();
    }

    /// <summary>Reference: Tool.spec — a copy of one tool's spec, ready to send to the model.</summary>
    public static System.Text.Json.Nodes.JsonObject Spec(string name) => (System.Text.Json.Nodes.JsonObject)SpecByName[name].DeepClone();

    /// <summary>Reference: tools.available — the tools any of the person's permissions unlock.</summary>
    public static IEnumerable<ToolDef> Available(IReadOnlySet<string> permissions) =>
        All.Where(t => t.AnyOf.Any(permissions.Contains));
}

/// <summary>Assistant change-action definitions: metadata (reference: app/assistant/actions.py ACTIONS).</summary>
public static class AssistantActionDefs
{
    public sealed record ActionDef(string Kind, string Label, string Permission);

    public static readonly ActionDef[] All =
    [
        new("approve_product", "Approve a listing", "catalog"),
        new("reject_product", "Send a listing back to the seller", "catalog"),
        new("approve_seller", "Approve a seller", "sellers"),
        new("reject_seller", "Ask a seller to fix their application", "sellers"),
        new("suspend_seller", "Suspend a seller", "sellers"),
        new("set_seller_commission", "Change a seller's commission", "sellers"),
        new("cancel_package", "Cancel a package and refund it", "orders"),
        new("mark_delivered", "Mark a package delivered", "orders"),
        new("retry_refund", "Retry a failed refund", "refunds"),
        new("return_decision", "Decide on a return", "refunds"),
        new("block_customer", "Block a customer", "customers"),
        new("unblock_customer", "Unblock a customer", "customers"),
        new("create_coupon", "Create a platform coupon", "marketing"),
        new("set_coupon_active", "Switch a coupon on or off", "marketing"),
        new("reply_ticket", "Reply to a support ticket", "support"),
        new("moderate_review", "Publish or hide a review", "catalog"),
        new("update_setting", "Change a marketplace setting", "settings"),
        new("set_announcement", "Change the storefront announcement bar", "marketing"),
        new("run_payouts", "Create payouts for sellers with money due", "payouts"),
    ];
}
