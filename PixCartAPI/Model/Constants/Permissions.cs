namespace Model.Constants;

/// <summary>One permission in the role editor (Admin → Staff → Roles).</summary>
public record PermissionDef(string Code, string Label, string Group, string Description, bool Sensitive = false);

/// <summary>
/// Staff roles and permissions for the admin panel. Every admin endpoint asks for one permission ([Perm("orders")]);
/// a staff member has one role, a named set of permissions stored in <c>admin_roles</c>. The owner role always has all.
/// </summary>
public static class Permissions
{
    public const string Owner = "owner";

    public static readonly PermissionDef[] Catalog =
    [
        new("dashboard", "Overview", "General", "Dashboard, KPIs and the go-live checklist."),
        new("assistant", "AI assistant: chat", "AI assistant", "Ask questions in chat. It only reads data this role can see."),
        new("assistant_actions", "AI assistant: make changes", "AI assistant", "Let the assistant prepare changes (approve, cancel, coupons…). Each one still needs Confirm.", true),
        new("assistant_files", "AI assistant: analyse files", "AI assistant", "Upload spreadsheets to analyse and compare with live data."),
        new("assistant_voice", "AI assistant: voice", "AI assistant", "Talk to the assistant and hear spoken answers."),
        new("ai_providers", "AI providers and models", "Administration", "Connect LLM providers, API keys and fallbacks.", true),
        new("sellers", "Sellers", "Marketplace", "KYC review, approve, suspend, commission."),
        new("catalog", "Catalogue", "Marketplace", "Listings, categories and review moderation."),
        new("orders", "Orders and returns", "Operations", "Orders, cancellations, deliveries and returns."),
        new("delivery", "Delivery fleet", "Operations", "Delivery partners, KYC, zones, assignment, live tracking, cash and payouts."),
        new("customers", "Customers", "Operations", "Customer accounts, block and unblock."),
        new("support", "Support desk", "Operations", "Tickets and grievances."),
        new("refunds", "Refunds", "Money", "Retry and complete refunds.", true),
        new("payouts", "Seller payouts", "Money", "Run payouts, bank files, mark paid.", true),
        new("reports", "Reports and exports", "Money", "GST TCS report and data exports."),
        new("marketing", "Marketing and storefront", "Growth", "Coupons, storefront, pages and message templates."),
        new("settings", "Marketplace settings", "Administration", "Fees, COD, tax rates, features and AI studio."),
        new("integrations", "Integrations and API keys", "Administration", "Payment, SMS, email, shipping and AI keys.", true),
        new("staff", "Staff and roles", "Administration", "Add staff, change roles, edit permissions.", true),
        new("audit", "Audit log", "Administration", "Who changed what, and when."),
        new("shop_assistant", "Shop assistant: settings", "Shop assistant (website chat)",
            "Switch the customer chat on or off, choose its features, AI use, voice, limits and budget."),
        new("shop_assistant_kb", "Shop assistant: help articles", "Shop assistant (website chat)",
            "Write, publish and hide the help articles the customer chat answers from."),
        new("shop_assistant_chats", "Shop assistant: customer chats", "Shop assistant (website chat)",
            "Read customers' chats with the website assistant, ratings and statistics.", true),
    ];

    public static readonly string[] All = Catalog.Select(p => p.Code).ToArray();

    /// <summary>The starting roles (seeded when the admin_roles table is empty).</summary>
    public static readonly Dictionary<string, (string Name, string Description, string[] Permissions)> DefaultRoles = new()
    {
        [Owner] = ("Owner", "Full access, including keys, staff and roles. Cannot be edited.", All),
        ["operations"] = ("Operations", "Day-to-day orders, sellers, customers and support.",
            ["dashboard", "assistant", "assistant_actions", "assistant_files", "assistant_voice", "sellers", "orders", "refunds", "customers", "support", "audit",
             "shop_assistant_kb", "shop_assistant_chats", "delivery"]),
        ["catalog"] = ("Catalogue manager", "Listings, categories, reviews and storefront.", ["dashboard", "assistant", "catalog", "marketing"]),
        ["finance"] = ("Finance", "Payouts, refunds, TCS and exports.", ["dashboard", "assistant", "assistant_files", "assistant_voice", "payouts", "refunds", "reports", "orders", "audit"]),
        ["support"] = ("Customer support", "Tickets, orders and customers.", ["dashboard", "assistant", "orders", "support", "customers", "shop_assistant_kb", "shop_assistant_chats"]),
        ["marketing"] = ("Marketing", "Coupons, storefront and catalogue.", ["dashboard", "assistant", "marketing", "catalog", "shop_assistant_kb"]),
        ["delivery_manager"] = ("Delivery manager", "Delivery partners, zones, assignment, live tracking and cash; orders and customers to help them.",
            ["dashboard", "assistant", "delivery", "orders", "customers", "support"]),
    };
}
