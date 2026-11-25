using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Utils;

namespace API.Infrastructure;

/// <summary>
/// Checks the query string of every route against the reference API's rules before the request is read, and refuses an
/// invalid one with the reference's 422 answer: the same fields, the same messages (pydantic's errors as the reference's
/// core/errors.py friendly_error words them) and the same first message ("Variant id: is required").
///
/// The rules come from <c>query-rules.json</c>, generated from the reference's OpenAPI schema by
/// tools/schema/query_rules.py. Sign-in is checked first (<see cref="ReferenceGuardFilter"/>), like the reference.
/// </summary>
public sealed partial class ReferenceQueryFilter : IAsyncResourceFilter
{
    private sealed record Rule(
        string Name, string In, bool Required, string Type, string? Format, List<JsonElement>? Enum, int? MinLength, int? MaxLength,
        JsonElement? Ge, JsonElement? Le, JsonElement? Gt, JsonElement? Lt, string? Pattern, int? MaxItems, string? ItemType);

    private static readonly Lazy<Dictionary<string, List<Rule>>> Rules = new(Load);

    private static Dictionary<string, List<Rule>> Load()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("API.Infrastructure.query-rules.json")
                      ?? throw new InvalidOperationException("query-rules.json is not embedded");
        var raw = JsonSerializer.Deserialize<Dictionary<string, List<JsonElement>>>(s) ?? [];
        return raw.ToDictionary(kv => kv.Key, kv => kv.Value.Select(ToRule).ToList());
    }

    private static Rule ToRule(JsonElement e)
    {
        JsonElement? Num(string n) => e.TryGetProperty(n, out var v) ? v : null;
        int? Int(string n) => e.TryGetProperty(n, out var v) ? v.GetInt32() : null;
        string? Str(string n) => e.TryGetProperty(n, out var v) ? v.GetString() : null;
        return new Rule(e.GetProperty("name").GetString()!, Str("in") ?? "query", e.GetProperty("required").GetBoolean(), Str("type") ?? "string",
            Str("format"), e.TryGetProperty("enum", out var en) ? en.EnumerateArray().ToList() : null,
            Int("min_length"), Int("max_length"), Num("ge"), Num("le"), Num("gt"), Num("lt"), Str("pattern"), Int("max_items"),
            Str("item_type"));
    }

    // reference core/errors.py
    private static readonly Dictionary<string, string> FieldLabels = new()
    {
        ["hsn_code"] = "HSN code", ["gst_bps"] = "GST rate", ["gstin"] = "GSTIN", ["pan"] = "PAN", ["ifsc"] = "IFSC",
        ["upi"] = "UPI ID", ["sku"] = "SKU", ["mrp_paise"] = "MRP", ["price_paise"] = "Selling price", ["qty"] = "Quantity",
        ["pincode"] = "PIN code", ["phone"] = "Mobile number", ["email"] = "Email", ["otp"] = "Code", ["code"] = "Code",
        ["line1"] = "Address", ["state_code"] = "State", ["vehicle_no"] = "Vehicle number",
    };

    internal static readonly Dictionary<string, string> PatternHints = new()
    {
        ["hsn_code"] = "use 4, 6 or 8 digits", ["pincode"] = "use the 6-digit PIN code",
        ["ifsc"] = "use the 11-character IFSC, like SBIN0001234", ["phone"] = "use a 10-digit mobile number",
        ["gstin"] = "use the 15-character GSTIN", ["pan"] = "use the 10-character PAN, like ABCDE1234F",
    };

    /// <summary>Python's field_label: a known label, or the name with spaces, first letter capital, the rest lower.</summary>
    public static string Label(string name)
    {
        if (FieldLabels.TryGetValue(name, out var l)) return l;
        var t = name.Replace('_', ' ').Trim();
        return t.Length == 0 ? "Input" : char.ToUpperInvariant(t[0]) + t[1..].ToLowerInvariant();
    }

    [GeneratedRegex(@"^\s*[+-]?\d+\s*$")]
    private static partial Regex IntText();

    [GeneratedRegex(@"\{\**([A-Za-z0-9_]+)[^}]*\}")]
    private static partial Regex PathParam();

    /// <summary>HttpContext.Items key: path and query errors waiting for the body check.</summary>
    internal const string PendingErrors = "reference.param.errors";

    private static readonly HashSet<string> TrueWords = ["1", "on", "t", "true", "y", "yes"];
    private static readonly HashSet<string> FalseWords = ["0", "off", "f", "false", "n", "no"];

    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        if (context.ActionDescriptor is ControllerActionDescriptor action && action.AttributeRouteInfo?.Template is { Length: > 0 } template
            && Rules.Value.TryGetValue(ReferenceGuardFilter.Key(context.HttpContext.Request.Method, template), out var rules))
        {
            var fields = new Dictionary<string, string>();
            var query = context.HttpContext.Request.Query;
            // path values: the reference names them in its own words (order_id); .NET in its route template (orderId).
            // Both list them in the same order, so they are matched by position.
            var netNames = PathParam().Matches(template).Select(m => m.Groups[1].Value).ToList();
            var pathIndex = 0;
            foreach (var r in rules.Where(r => r.In == "path"))
            {
                var netName = pathIndex < netNames.Count ? netNames[pathIndex] : r.Name;
                pathIndex++;
                if (context.RouteData.Values.TryGetValue(netName, out var raw) && raw?.ToString() is { } pv && Check(r, pv) is { } pmsg)
                    fields[r.Name] = pmsg;
            }
            foreach (var r in rules.Where(r => r.In == "query"))
            {
                var present = query.TryGetValue(r.Name, out var values) && values.Count > 0;
                if (!present)
                {
                    if (r.Required) fields[r.Name] = "is required";
                    continue;
                }
                if (r.Type == "array")
                {
                    if (r.MaxItems is { } max && values.Count > max) fields[r.Name] = $"can have at most {max}";
                    continue;
                }
                if (Check(r, values[^1] ?? "") is { } msg) fields[r.Name] = msg;
            }
            if (fields.Count > 0)
            {
                // the reference reports path, query and body errors in one answer: when the body is checked next, it adds
                // its errors and answers (ReferenceBodyFilter)
                if (ReferenceBodyFilter.Checks(context.HttpContext.Request.Method, template))
                    context.HttpContext.Items[PendingErrors] = fields;
                else
                {
                    var (name, msg) = fields.First();
                    throw new AppException($"{Label(name)}: {msg}", "validation_error", 422, fields);
                }
            }
        }
        await next();
    }

    /// <summary>The reference message for one value, or null when it is valid.</summary>
    private static string? Check(Rule r, string v)
    {
        switch (r.Type)
        {
            case "integer":
            {
                if (!IntText().IsMatch(v) || !decimal.TryParse(v.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n))
                    return "must be a number";
                return Bounds(r, n);
            }
            case "number":
            {
                if (!decimal.TryParse(v.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return "must be a number";
                return Bounds(r, n);
            }
            case "boolean":
                return TrueWords.Contains(v.Trim().ToLowerInvariant()) || FalseWords.Contains(v.Trim().ToLowerInvariant()) ? null : "must be on or off";
        }
        if (r.Enum is { Count: > 0 } choices)
        {
            if (choices.Any(c => c.ValueKind == JsonValueKind.String && c.GetString() == v)) return null;
            var shown = choices.Select(c => c.ValueKind == JsonValueKind.String ? $"'{c.GetString()}'" : c.GetRawText()).ToList();
            var expected = shown.Count == 1 ? shown[0] : string.Join(", ", shown[..^1]) + " or " + shown[^1];
            return $"must be one of: {expected}";
        }
        switch (r.Format)
        {
            case "uuid":
                return Guid.TryParse(v.Trim().Replace("urn:uuid:", "", StringComparison.OrdinalIgnoreCase), out _) ? null : "is not a valid id";
            case "date":
                return DateMessage(v);
        }
        if (r.MinLength is { } min && v.Length < min) return min == 1 ? "is required" : $"needs at least {min} characters";
        if (r.MaxLength is { } maxLen && v.Length > maxLen) return $"can be at most {maxLen} characters";
        if (r.Pattern is { } p && !Regex.IsMatch(v, p))
            return PatternHints.TryGetValue(r.Name, out var hint) ? hint : "is not in the right format";
        return null;
    }

    private static string? Bounds(Rule r, decimal n)
    {
        static decimal D(JsonElement e) => e.GetDecimal();
        if (r.Ge is { } ge && n < D(ge)) return $"must be at least {ge.GetRawText()}";
        if (r.Gt is { } gt && n <= D(gt)) return $"must be at least {gt.GetRawText()}";
        if (r.Le is { } le && n > D(le)) return $"must be at most {le.GetRawText()}";
        if (r.Lt is { } lt && n >= D(lt)) return $"must be at most {lt.GetRawText()}";
        return null;
    }

    /// <summary>pydantic's date errors (the reference shows them as they are).</summary>
    internal static string? DateMessage(string v)
    {
        const string head = "Input should be a valid date or datetime, ";
        if (DateTime.TryParseExact(v, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return null;
        if (v.Length < 10) return head + "input is too short";
        var m = Regex.Match(v, @"^(\d{4})-(\d{2})-(\d{2})$");
        if (!m.Success) return Regex.IsMatch(v, @"^\d{4}") ? head + "invalid date separator, expected `-`" : head + "invalid character in year";
        var month = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        if (month is < 1 or > 12) return head + "month value is outside expected range of 1-12";
        return head + "day value is outside expected range";
    }
}
