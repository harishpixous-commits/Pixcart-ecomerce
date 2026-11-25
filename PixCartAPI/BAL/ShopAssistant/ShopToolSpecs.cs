using System.Text.Json.Nodes;

namespace BAL.ShopAssistant;

/// <summary>The customer tool metadata for live mode (reference: shop_assistant/tools.py TOOLS registry):
/// names, labels, descriptions and input schemas the model sees, in the reference's definition order.</summary>
public static class ShopToolSpecs
{
    public sealed record Tool(string Name, string Label, string Description, JsonObject Properties, string[] Required, bool Login, string Feature)
    {
        /// <summary>Reference: Tool.spec().</summary>
        public JsonObject Spec() => new()
        {
            ["name"] = Name,
            ["description"] = Description,
            ["input_schema"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = Properties.DeepClone(),
                ["required"] = new JsonArray(Required.Select(r => (JsonNode)JsonValue.Create(r)).ToArray()),
            },
        };
    }

    private static JsonObject Props(params (string Key, JsonObject Schema)[] p) =>
        new(p.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Schema)));

    private static JsonObject Str(string? description = null) =>
        description is null ? new JsonObject { ["type"] = "string" } : new JsonObject { ["type"] = "string", ["description"] = description };

    public static readonly Tool[] All =
    [
        new("search_products", "Finding products",
            "Search the store's products by words, with optional price limits in rupees. Use for 'show me running shoes under 2000', " +
            "'do you have pressure cookers'. Returns at most 6 products.",
            Props(("query", Str("product words, e.g. 'running shoes'")),
                ("min_price_rupees", new JsonObject { ["type"] = "number" }),
                ("max_price_rupees", new JsonObject { ["type"] = "number" }),
                ("sort", new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("relevance", "price_asc", "price_desc", "rating", "discount") })),
            ["query"], false, "product_search"),
        new("product_info", "Checking the product",
            "Details of one product the customer names or is looking at: price, offer, stock, rating, return window, cash on delivery, " +
            "highlights, seller. Pass the product link slug if known, else its name.",
            Props(("slug", Str()), ("name", Str())), [], false, "product_search"),
        new("help_articles", "Looking it up",
            "Search the store's help articles (delivery, cash on delivery, payments, cancellation, returns, refunds, sign-in, coupons, " +
            "invoices, selling, grievance). Use for any policy or how-to question.",
            Props(("query", Str())), ["query"], false, "help_articles"),
        new("store_policies", "Checking store policies",
            "The store's current delivery fee, free-delivery amount, cash on delivery, the other fees on the bill (handling, small cart, " +
            "platform, bad weather, late night) and the tip, delivery times and return reasons. Use for questions about charges, fees and delivery days.",
            Props(), [], false, "help_articles"),
        new("my_orders", "Checking your orders", "The signed-in customer's recent orders with status and totals.",
            Props(("limit", new JsonObject { ["type"] = "integer", ["description"] = "1-10, default 5" })), [], true, "orders"),
        new("order_details", "Checking the order",
            "Full status of one of the customer's orders: each package's progress, courier and tracking, expected delivery, cancellation " +
            "and return eligibility, refunds and returns. Without a number, the latest order.",
            Props(("order_number", Str("e.g. PC2611184K7QZD (or a package number PC2611184K7QZD-1)"))), [], true, "orders"),
        new("my_returns_and_refunds", "Checking returns and refunds", "The customer's return requests and refunds with their status.",
            Props(), [], true, "returns_refunds"),
        new("my_tickets", "Checking your requests", "The customer's support requests (tickets) and their status.",
            Props(), [], true, "tickets"),
        new("ticket_details", "Checking the request", "One support request of the customer, with the team's latest reply.",
            Props(("ticket_number", Str("e.g. TK261118A1B2"))), ["ticket_number"], true, "tickets"),
        new("prepare_ticket", "Preparing a support request",
            "Show the customer a support request form, filled in from the chat, to send to the support team. Use when the customer asks " +
            "for a person, wants to complain, or the problem cannot be solved here. Nothing is sent until the customer presses Send.",
            Props(("category", new JsonObject { ["type"] = "string", ["enum"] = new JsonArray(SupportTicketBAL.CategoryLabels.Keys.Select(k => (JsonNode)JsonValue.Create(k)).ToArray()) }),
                ("subject", Str("short title, 5-120 characters")),
                ("message", Str("the problem in the customer's words, with the key facts")),
                ("order_number", Str()),
                ("grievance", new JsonObject { ["type"] = "boolean", ["description"] = "a formal grievance to the Grievance Officer" })),
            ["category", "subject", "message"], true, "tickets"),
        new("prepare_cancellation", "Preparing the cancellation",
            "Prepare cancelling the customer's order (or one package of it) that has not shipped yet. The customer sees a Confirm button; " +
            "nothing is cancelled until they press it.",
            Props(("order_number", Str("order number, or a package number to cancel only that package")),
                ("reason", Str())),
            ["order_number"], true, "cancel_orders"),
    ];

    private static readonly Dictionary<string, Tool> ByName = All.ToDictionary(t => t.Name);

    public static Tool? Find(string name) => ByName.GetValueOrDefault(name);

    public static string LabelOf(string name) => ByName.TryGetValue(name, out var t) ? t.Label : "Working";

    /// <summary>Reference: tools.available — only what this visitor (guest or signed-in) and the feature switches allow.</summary>
    public static List<Tool> Available(bool signedIn, IReadOnlyDictionary<string, bool> features) =>
        All.Where(t => (signedIn || !t.Login) && (!features.TryGetValue(t.Feature, out var on) || on)).ToList();
}
