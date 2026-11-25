using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Utils;

namespace API.Infrastructure;

/// <summary>
/// Validates a JSON request body against the reference API's schema for the route before the body is read, the way
/// pydantic does (lax mode: "5" is a number, true is 1, ...), and refuses an invalid one with the reference's 422 answer:
/// every invalid field in the reference model's field order, its messages (pydantic's errors as the reference's
/// core/errors.py friendly_error words them), and the first one as the message ("Full name: is required").
///
/// The schemas come from <c>body-rules.json</c>, generated from the reference's OpenAPI by tools/schema/body_rules.py.
/// Rules written only in reference code (custom validators) are not in the schema; the endpoint's own checks keep them.
/// Runs after sign-in (<see cref="ReferenceGuardFilter"/>) and the query check (<see cref="ReferenceQueryFilter"/>).
/// </summary>
public sealed partial class ReferenceBodyFilter : IAsyncResourceFilter
{
    private sealed record Route(bool Required, JsonElement Schema);

    private static readonly Lazy<Dictionary<string, Route>> Routes = new(Load);

    private static Dictionary<string, Route> Load()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("API.Infrastructure.body-rules.json")
                      ?? throw new InvalidOperationException("body-rules.json is not embedded");
        using var doc = JsonDocument.Parse(s);
        return doc.RootElement.EnumerateObject().ToDictionary(p => p.Name,
            p => new Route(p.Value.GetProperty("required").GetBoolean(), p.Value.GetProperty("schema").Clone()));
    }

    // loc parts the reference leaves out of field names (core/errors.py)
    private static readonly HashSet<string> Hidden = ["body", "query", "path"];

    private static readonly HashSet<string> TrueWords = ["1", "on", "t", "true", "y", "yes"];
    private static readonly HashSet<string> FalseWords = ["0", "off", "f", "false", "n", "no"];

    [GeneratedRegex(@"^[+-]?\d+(\.0*)?$")]
    private static partial Regex IntString();

    [GeneratedRegex(@"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")]
    private static partial Regex EmailText();

    /// <summary>Whether this filter checks the body of a route (then path and query errors are reported with it).</summary>
    internal static bool Checks(string method, string template) =>
        method is "POST" or "PUT" or "PATCH" && Routes.Value.ContainsKey(ReferenceGuardFilter.Key(method, template));

    public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
    {
        var request = context.HttpContext.Request;
        var pending = context.HttpContext.Items.TryGetValue(ReferenceQueryFilter.PendingErrors, out var p) ? p as Dictionary<string, string> : null;
        if (request.Method is "POST" or "PUT" or "PATCH"
            && context.ActionDescriptor is ControllerActionDescriptor action && action.AttributeRouteInfo?.Template is { Length: > 0 } template
            && Routes.Value.TryGetValue(ReferenceGuardFilter.Key(request.Method, template), out var route)
            && (request.ContentType is null || request.ContentType.Contains("json", StringComparison.OrdinalIgnoreCase)))
        {
            request.EnableBuffering();
            string text;
            using (var reader = new StreamReader(request.Body, leaveOpen: true)) text = await reader.ReadToEndAsync();
            request.Body.Position = 0;
            var errors = new List<(List<string> Loc, string Msg)>();
            if (string.IsNullOrWhiteSpace(text))
            {
                if (route.Required) errors.Add(([], "is required"));
            }
            else
            {
                JsonDocument? doc = null;
                try { doc = JsonDocument.Parse(text); }
                catch (JsonException) { /* not JSON: the endpoint's own binding answers */ }
                if (doc is not null)
                    using (doc)
                    {
                        if (doc.RootElement.ValueKind == JsonValueKind.Null)
                        {
                            if (route.Required) errors.Add(([], "is required")); // null is a missing body for the reference
                        }
                        else Validate(route.Schema, doc.RootElement, [], errors);
                    }
            }
            if (errors.Count > 0 || pending is { Count: > 0 })
            {
                var fields = new Dictionary<string, string>();
                var labels = new Dictionary<string, string>();
                foreach (var (k, m) in pending ?? [])
                {
                    fields[k] = m;
                    labels[k] = ReferenceQueryFilter.Label(k);
                }
                foreach (var (loc, msg) in errors)
                {
                    var parts = loc.Where(p => !Hidden.Contains(p)).ToList();
                    var key = parts.Count > 0 ? string.Join('.', parts) : "_";
                    fields[key] = msg;
                    labels[key] = ReferenceQueryFilter.Label(parts.LastOrDefault(p => !p.All(char.IsDigit)) ?? "");
                }
                var (firstKey, firstMsg) = fields.First();
                var message = firstKey != "_" ? $"{labels[firstKey]}: {firstMsg}" : firstMsg;
                throw new AppException(message, "validation_error", 422, fields);
            }
        }
        else if (pending is { Count: > 0 })
        {
            var (name, msg) = pending.First();
            throw new AppException($"{ReferenceQueryFilter.Label(name)}: {msg}", "validation_error", 422, pending);
        }
        await next();
    }

    private static string? Str(JsonElement s, string name) =>
        s.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>Appends pydantic's errors for one value (first error per value, like pydantic for scalars).</summary>
    private static void Validate(JsonElement schema, JsonElement value, List<string> loc, List<(List<string>, string)> errors)
    {
        // Optional[X] / unions
        if (schema.TryGetProperty("anyOf", out var any))
        {
            var options = any.EnumerateArray().ToList();
            if (value.ValueKind == JsonValueKind.Null && options.Any(o => Str(o, "type") == "null")) return;
            var real = options.Where(o => Str(o, "type") != "null").ToList();
            List<(List<string>, string)>? firstErrors = null;
            foreach (var o in real)
            {
                var errs = new List<(List<string>, string)>();
                Validate(o, value, loc, errs);
                if (errs.Count == 0) return;
                firstErrors ??= errs;
            }
            if (firstErrors is not null) errors.AddRange(firstErrors);
            return;
        }
        if (schema.TryGetProperty("allOf", out var all))
        {
            foreach (var o in all.EnumerateArray()) Validate(o, value, loc, errors);
            return;
        }

        if (schema.TryGetProperty("const", out var constant))
        {
            if (!(value.ValueKind == JsonValueKind.String && constant.ValueKind == JsonValueKind.String && value.GetString() == constant.GetString())
                && value.GetRawText() != constant.GetRawText())
                errors.Add((loc, $"must be one of: {Shown(constant)}"));
            return;
        }
        if (schema.TryGetProperty("enum", out var choices))
        {
            var list = choices.EnumerateArray().ToList();
            var ok = list.Any(c => c.ValueKind == JsonValueKind.String
                ? value.ValueKind == JsonValueKind.String && value.GetString() == c.GetString()
                : c.GetRawText() == value.GetRawText());
            if (!ok)
            {
                var shown = list.Select(Shown).ToList();
                errors.Add((loc, "must be one of: " + (shown.Count == 1 ? shown[0] : string.Join(", ", shown[..^1]) + " or " + shown[^1])));
            }
            return;
        }

        var type = Str(schema, "type");
        if (type is null && schema.TryGetProperty("properties", out _)) type = "object";
        switch (type)
        {
            case "object":
                ValidateObject(schema, value, loc, errors);
                return;
            case "array":
            {
                if (value.ValueKind != JsonValueKind.Array) { errors.Add((loc, "Input should be a valid list")); return; }
                var n = value.GetArrayLength();
                if (schema.TryGetProperty("minItems", out var min) && n < min.GetInt32()) { errors.Add((loc, $"needs at least {min.GetInt32()}")); return; }
                if (schema.TryGetProperty("maxItems", out var max) && n > max.GetInt32()) { errors.Add((loc, $"can have at most {max.GetInt32()}")); return; }
                if (schema.TryGetProperty("items", out var items))
                {
                    var i = 0;
                    foreach (var item in value.EnumerateArray()) Validate(items, item, [.. loc, (i++).ToString(CultureInfo.InvariantCulture)], errors);
                }
                return;
            }
            case "integer":
            {
                decimal n;
                if (value.ValueKind == JsonValueKind.Number)
                {
                    n = value.GetDecimal();
                    if (n != decimal.Truncate(n)) { errors.Add((loc, "Input should be a valid integer, got a number with a fractional part")); return; }
                }
                else if (value.ValueKind is JsonValueKind.True or JsonValueKind.False) n = value.ValueKind == JsonValueKind.True ? 1 : 0;
                else if (value.ValueKind == JsonValueKind.String && IntString().IsMatch(value.GetString()!.Trim()))
                    n = decimal.Parse(value.GetString()!.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture);
                else { errors.Add((loc, "must be a number")); return; }
                if (Bounds(schema, n) is { } b) errors.Add((loc, b));
                return;
            }
            case "number":
            {
                decimal n;
                if (value.ValueKind == JsonValueKind.Number) n = value.GetDecimal();
                else if (value.ValueKind is JsonValueKind.True or JsonValueKind.False) n = value.ValueKind == JsonValueKind.True ? 1 : 0;
                else if (value.ValueKind == JsonValueKind.String && decimal.TryParse(value.GetString()!.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var p)) n = p;
                else { errors.Add((loc, "must be a number")); return; }
                if (Bounds(schema, n) is { } b) errors.Add((loc, b));
                return;
            }
            case "boolean":
            {
                var ok = value.ValueKind is JsonValueKind.True or JsonValueKind.False
                         || (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var i) && i is 0 or 1)
                         || (value.ValueKind == JsonValueKind.String && (TrueWords.Contains(value.GetString()!.Trim().ToLowerInvariant()) || FalseWords.Contains(value.GetString()!.Trim().ToLowerInvariant())));
                if (!ok) errors.Add((loc, "must be on or off"));
                return;
            }
            case "string":
                ValidateString(schema, value, loc, errors);
                return;
            case "null":
                if (value.ValueKind != JsonValueKind.Null) errors.Add((loc, "Input should be None"));
                return;
        }
    }

    private static void ValidateObject(JsonElement schema, JsonElement value, List<string> loc, List<(List<string>, string)> errors)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            var title = Str(schema, "title");
            errors.Add((loc, schema.TryGetProperty("properties", out _) && title is not null
                ? $"Input should be a valid dictionary or instance of {title}"
                : "Input should be a valid dictionary"));
            return;
        }
        var required = schema.TryGetProperty("required", out var req) ? req.EnumerateArray().Select(r => r.GetString()!).ToHashSet() : [];
        if (schema.TryGetProperty("properties", out var props))
        {
            foreach (var p in props.EnumerateObject())
            {
                if (value.TryGetProperty(p.Name, out var v)) Validate(p.Value, v, [.. loc, p.Name], errors);
                else if (required.Contains(p.Name)) errors.Add(([.. loc, p.Name], "is required"));
            }
        }
        else if (schema.TryGetProperty("additionalProperties", out var extra) && extra.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in value.EnumerateObject()) Validate(extra, p.Value, [.. loc, p.Name], errors);
        }
    }

    private static void ValidateString(JsonElement schema, JsonElement value, List<string> loc, List<(List<string>, string)> errors)
    {
        var format = Str(schema, "format");
        var name = loc.LastOrDefault(p => !p.All(char.IsDigit)) ?? "";
        switch (format)
        {
            case "uuid":
                if (value.ValueKind != JsonValueKind.String) errors.Add((loc, "UUID input should be a string, bytes or UUID object"));
                else if (!Guid.TryParse(value.GetString()!.Replace("urn:uuid:", "", StringComparison.OrdinalIgnoreCase), out _)) errors.Add((loc, "is not a valid id"));
                return;
            case "date":
                if (value.ValueKind == JsonValueKind.Null) errors.Add((loc, "Input should be a valid date"));
                else if (value.ValueKind != JsonValueKind.String) errors.Add((loc, "Datetimes provided to dates should have zero time - e.g. be exact dates"));
                else if (ReferenceQueryFilter.DateMessage(value.GetString()!) is { } dm) errors.Add((loc, dm));
                return;
            case "date-time":
                if (value.ValueKind == JsonValueKind.Number) return; // a Unix time is a valid datetime for pydantic
                if (value.ValueKind != JsonValueKind.String) { errors.Add((loc, "Input should be a valid datetime")); return; }
                if (DateTimeMessage(value.GetString()!) is { } tm) errors.Add((loc, tm));
                return;
        }
        if (value.ValueKind != JsonValueKind.String) { errors.Add((loc, "Input should be a valid string")); return; }
        var s = value.GetString()!;
        var len = s.EnumerateRunes().Count(); // Python counts characters (code points), not UTF-16 units
        if (schema.TryGetProperty("minLength", out var min) && len < min.GetInt32())
        {
            errors.Add((loc, min.GetInt32() == 1 ? "is required" : $"needs at least {min.GetInt32()} characters"));
            return;
        }
        if (schema.TryGetProperty("maxLength", out var max) && len > max.GetInt32())
        {
            errors.Add((loc, $"can be at most {max.GetInt32()} characters"));
            return;
        }
        if (Str(schema, "pattern") is { } pattern && !Regex.IsMatch(s, pattern))
        {
            errors.Add((loc, ReferenceQueryFilter.PatternHints.TryGetValue(name, out var hint) ? hint : "is not in the right format"));
            return;
        }
        if (format == "email" && !EmailText().IsMatch(s)) errors.Add((loc, "is not a valid email address"));
        else if (format == "uri")
        {
            if (!Uri.TryCreate(s, UriKind.Absolute, out var u)) errors.Add((loc, "Input should be a valid URL, relative URL without a base"));
            else if (u.Scheme is not ("http" or "https")) errors.Add((loc, "URL scheme should be 'http' or 'https'"));
        }
    }

    private static string Shown(JsonElement c) => c.ValueKind == JsonValueKind.String ? $"'{c.GetString()}'" : c.GetRawText();

    private static string? Bounds(JsonElement schema, decimal n)
    {
        if (schema.TryGetProperty("minimum", out var ge) && n < ge.GetDecimal()) return $"must be at least {ge.GetRawText()}";
        if (schema.TryGetProperty("exclusiveMinimum", out var gt) && n <= gt.GetDecimal()) return $"must be at least {gt.GetRawText()}";
        if (schema.TryGetProperty("maximum", out var le) && n > le.GetDecimal()) return $"must be at most {le.GetRawText()}";
        if (schema.TryGetProperty("exclusiveMaximum", out var lt) && n >= lt.GetDecimal()) return $"must be at most {lt.GetRawText()}";
        return null;
    }

    /// <summary>pydantic's datetime errors (shown as they are by the reference).</summary>
    private static string? DateTimeMessage(string v)
    {
        const string head = "Input should be a valid datetime or date, ";
        if (DateTime.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _)
            && Regex.IsMatch(v, @"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$")) return null;
        if (v.Length < 10) return head + "input is too short";
        var m = Regex.Match(v, @"^(\d{4})-(\d{2})-(\d{2})");
        if (!m.Success) return head + "invalid character in year";
        if (int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) is < 1 or > 12) return head + "month value is outside expected range of 1-12";
        if (!DateTime.TryParseExact(m.Value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return head + "day value is outside expected range";
        return head + "unexpected extra characters at the end of the input";
    }
}
