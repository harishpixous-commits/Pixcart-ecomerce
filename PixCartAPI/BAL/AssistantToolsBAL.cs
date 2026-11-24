namespace BAL;

using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DAL;
using Utils;

/// <summary>
/// Runs the assistant's read-only tools and builds the screen cards (reference: app/assistant/tools.py).
/// Only tools whose backing queries are ported are registered for execution; the status endpoint still
/// reports all 25 from <see cref="AssistantTools"/>. Permissions are re-checked on every execution.
/// </summary>
public partial class AssistantToolsBAL(AssistantQueriesDAL q, AssistantBAL asst, AiBAL ai, AssistantActionsBAL actionsBal,AssistantUploadDAL uploads)
{
    public sealed record AssistantToolContext(Guid UserId, HashSet<string> Permissions, Guid ConversationId, bool ShareContacts, List<string> UploadIds);

    public sealed record AssistantToolOutput(JsonNode Data, List<JsonObject> Cards);

    private delegate Task<AssistantToolOutput> Handler(AssistantToolContext ctx, JsonObject a);

    private sealed record ExecutableTool(string Name, string[] AnyOf, Handler Run);

    private Dictionary<string, ExecutableTool>? _registryBacking;

    private Dictionary<string, ExecutableTool> Registry => _registryBacking ??= BuildRegistry();

    // ----------------------------------------------------------------------------- cards (reference: tools.metrics/table/chart)

    public static JsonObject MetricsCard(string title, IEnumerable<(string Label, string Value, string? Hint)> items, string note = "") =>
        new()
        {
            ["type"] = "metrics", ["title"] = title, ["note"] = note,
            ["items"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject { ["label"] = i.Label, ["value"] = i.Value, ["hint"] = i.Hint ?? "" }).ToArray()),
        };

    public static JsonObject TableCard(string title, string[] columns, IEnumerable<JsonArray> rows, long? total = null, string note = "", string link = "")
    {
        var arr = new JsonArray(rows.Select(r => (JsonNode)r).ToArray());
        return new JsonObject
        {
            ["type"] = "table", ["title"] = title, ["columns"] = new JsonArray(columns.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["rows"] = arr, ["total_rows"] = total ?? arr.Count, ["note"] = note, ["link"] = link,
        };
    }

    private static JsonArray Row(params object?[] cells) => new(cells.Select(c => c is null ? null : JsonValue.Create(c.ToString())).ToArray());

    public static JsonObject ChartCard(string title, string kind, IEnumerable<string> labels, IEnumerable<(string Name, IEnumerable<double> Values)> series, string unit = "") =>
        new()
        {
            ["type"] = "chart", ["title"] = title, ["kind"] = kind,
            ["labels"] = new JsonArray(labels.Select(l => (JsonNode)JsonValue.Create(l)!).ToArray()), ["unit"] = unit,
            ["series"] = new JsonArray(series.Select(s => (JsonNode)new JsonObject
            {
                ["name"] = s.Name, ["values"] = new JsonArray(s.Values.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray()),
            }).ToArray()),
        };

    private static JsonObject LinksCard(IEnumerable<(string Label, string Href)> links) =>
        new()
        {
            ["type"] = "links", ["title"] = "Open",
            ["items"] = new JsonArray(links.Select(l => (JsonNode)new JsonObject { ["label"] = l.Label, ["href"] = l.Href }).ToArray()),
        };

    // ----------------------------------------------------------------------------- helpers (reference: tools._period/_limit/_delta)

    private static AssistantPeriods.Period PeriodArg(JsonObject a, string def = "today") =>
        AssistantPeriods.Resolve(
            Str(a, "period") ?? (Str(a, "date_from") is not null || Str(a, "date_to") is not null ? null : def),
            Str(a, "date_from"), Str(a, "date_to"));

    private static string? Str(JsonObject a, string key) => a[key] is JsonValue jv && jv.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;

    private static int LimitArg(JsonObject a, int def = 25, int hi = 200)
    {
        try
        {
            return a["limit"] is { } v ? Math.Max(1, Math.Min((int)v.GetValue<long>(), hi)) : def;
        }
        catch (Exception)
        {
            return def;
        }
    }

    private static bool BoolArg(JsonObject a, string key, bool def = false) =>
        a[key] is JsonValue jv && jv.TryGetValue<bool>(out var b) ? b : def;

    private static string? Delta(long cur, long prev)
    {
        if (prev == 0) return null;
        var change = (cur - prev) * 100.0 / Math.Abs(prev);
        return $"{(change >= 0 ? "+" : "")}{change:0.0}% vs previous";
    }

    /// <summary>Numeric JSON reads that survive int/long/double/decimal payloads (JsonValue numeric casts throw).</summary>
    public static long Lng(JsonObject o, string key)
    {
        if (o[key] is not JsonValue jv) return 0;
        if (jv.TryGetValue<long>(out var l)) return l;
        if (jv.TryGetValue<int>(out var i)) return i;
        if (jv.TryGetValue<double>(out var d)) return (long)d;
        if (jv.TryGetValue<decimal>(out var m)) return (long)m;
        return 0;
    }

    private static string Txt(JsonObject o, string key) => o[key] is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : "";

    /// <summary>Reference: tools.mask — hides phones, emails and street addresses from the model (cards keep them).</summary>
    public static JsonNode? Mask(JsonNode? value)
    {
        switch (value)
        {
            case JsonObject obj:
            {
                var outObj = new JsonObject();
                foreach (var (k, v) in obj.ToList())
                {
                    var lk = k.ToLowerInvariant();
                    if (v is JsonValue jv && jv.TryGetValue<string>(out var s) && s.Length > 0 && (lk.Contains("phone") || lk is "contact" or "mobile"))
                    {
                        var digits = Regex.Replace(s, @"\D", "");
                        outObj[k] = digits.Length >= 6 ? $"{digits[..2]}••••••{digits[^2..]}" : "••••";
                    }
                    else if (v is JsonValue jv2 && jv2.TryGetValue<string>(out var s2) && s2.Length > 0 && lk.Contains("email"))
                    {
                        var parts = s2.Split('@', 2);
                        outObj[k] = parts.Length == 2 ? $"{parts[0][..1]}•••@{parts[1]}" : "•••";
                    }
                    else if (lk is "address" or "line1" or "line2" or "landmark" && v is JsonValue)
                    {
                        outObj[k] = "(hidden)";
                    }
                    else
                    {
                        outObj[k] = Mask(v);
                    }
                }
                return outObj;
            }
            case JsonArray arr:
                return new JsonArray(arr.Select(Mask).ToArray());
            default:
                return value?.DeepClone();
        }
    }

    /// <summary>Reference: tools.model_view — JSON the model sees, masked unless contacts may be shared.</summary>
    public static string ModelView(JsonNode? data, bool shareContacts, int limit = 14000)
    {
        var text = (shareContacts ? data : Mask(data))?.ToJsonString() ?? "null";
        return text.Length > limit
            ? text[..limit] + "…\" (truncated: the screen shows the full table; summarise what is here)"
            : text;
    }

    // ----------------------------------------------------------------------------- pages (reference: tools.PAGES)

    public static readonly IReadOnlyDictionary<string, (string Label, string Href, string Permission)> Pages =
        new Dictionary<string, (string, string, string)>
        {
            ["overview"] = ("Overview", "/admin", "dashboard"), ["orders"] = ("Orders", "/admin/orders", "orders"),
            ["returns"] = ("Returns", "/admin/returns", "orders"), ["refunds"] = ("Refunds", "/admin/refunds", "refunds"),
            ["sellers"] = ("Sellers", "/admin/sellers", "sellers"), ["products"] = ("Listings", "/admin/products", "catalog"),
            ["categories"] = ("Categories", "/admin/categories", "catalog"), ["reviews"] = ("Reviews", "/admin/reviews", "catalog"),
            ["customers"] = ("Customers", "/admin/customers", "customers"), ["support"] = ("Support desk", "/admin/support", "support"),
            ["payouts"] = ("Payouts", "/admin/payouts", "payouts"), ["coupons"] = ("Coupons", "/admin/coupons", "marketing"),
            ["storefront"] = ("Storefront", "/admin/storefront", "marketing"), ["notifications"] = ("Messages", "/admin/notifications", "marketing"),
            ["reports"] = ("Reports", "/admin/reports", "reports"), ["exports"] = ("Exports", "/admin/exports", "reports"),
            ["settings"] = ("Settings", "/admin/settings", "settings"), ["ai_studio"] = ("AI studio", "/admin/ai", "settings"),
            ["assistant_settings"] = ("Assistant settings", "/admin/assistant", "settings"),
            ["ai_providers"] = ("AI providers", "/admin/ai-providers", "ai_providers"),
            ["integrations"] = ("Integrations", "/admin/integrations", "integrations"),
            ["go_live"] = ("Go-live checklist", "/admin/go-live", "dashboard"), ["staff"] = ("Staff and roles", "/admin/staff", "staff"),
            ["audit"] = ("Audit log", "/admin/audit", "audit"),
        };

    private static bool PageAllowed(string href, HashSet<string> perms)
    {
        var path = href.Split('?')[0];
        foreach (var (_, h, p) in Pages.Values)
            if (h == path)
                return perms.Contains(p);
        return true;
    }

    // ----------------------------------------------------------------------------- execution (reference: tools.execute)

    /// <summary>Runs a tool after re-checking the permission. Returns (output, isError).</summary>
    public async Task<(AssistantToolOutput Output, bool IsError)> ExecuteAsync(AssistantToolContext ctx, string name, JsonObject? args)
    {
        if (!Registry.TryGetValue(name, out var t))
            return (Err($"Unknown tool {name}"), true);
        if (!t.AnyOf.Any(ctx.Permissions.Contains))
            return (Err("Your role does not allow this."), true);
        try
        {
            var output = await t.Run(ctx, args ?? new JsonObject());
            return (output, output.Data is JsonObject d && d.ContainsKey("error"));
        }
        catch (AppException exc)
        {
            return (Err(exc.Message), true);
        }
    }

    private static AssistantToolOutput Err(string message) => new(new JsonObject { ["error"] = message }, []);

    /// <summary>The tool names that can actually run in this build.</summary>
    public IEnumerable<string> RegisteredNames => Registry.Keys;
}
