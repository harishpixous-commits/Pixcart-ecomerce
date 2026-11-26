using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;

namespace BAL;

/// <summary>
/// Text and JSON helpers that keep the storefront's rules identical to the reference version (which reads JSON with
/// Python: str(x), x or "", int(x), slicing, isoformat).
/// </summary>
internal static partial class CatalogText
{
    /// <summary>Python's str(x) of a JSON value: None, True, False, numbers and strings.</summary>
    public static string Str(JsonNode? n) => n switch
    {
        null => "None",
        JsonValue v when v.GetValueKind() == JsonValueKind.String => v.GetValue<string>(),
        JsonValue v when v.GetValueKind() == JsonValueKind.Null => "None",
        JsonValue v when v.GetValueKind() == JsonValueKind.True => "True",
        JsonValue v when v.GetValueKind() == JsonValueKind.False => "False",
        _ => n.ToJsonString(),
    };

    /// <summary>Python's str(x or "").</summary>
    public static string OrEmpty(JsonNode? n) => SettingsJson.Truthy(n) ? Str(n) : "";

    /// <summary>Python's s[:n].</summary>
    public static string Cut(string s, int n) => s.Length <= n ? s : s[..n];

    /// <summary>A JSON value from a dict, like d.get(key, default).</summary>
    public static JsonNode? Get(JsonObject? o, string key) => o != null && o.TryGetPropertyValue(key, out var v) ? v : null;

    public static bool Has(JsonObject? o, string key) => o != null && o.ContainsKey(key);

    /// <summary>A string value or null when the value is not a JSON string.</summary>
    public static string? AsString(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    /// <summary>A whole number from a JSON value (number, numeric text or true/false); ArgumentException otherwise.</summary>
    public static long LenientInt(JsonNode? n)
    {
        switch (n?.GetValueKind())
        {
            case JsonValueKind.True: return 1;
            case JsonValueKind.False: return 0;
            case JsonValueKind.Number:
                return (long)Math.Truncate(SettingsJson.ToDecimal(n) ?? 0);
            case JsonValueKind.String:
                var s = n!.GetValue<string>().Trim().Replace("_", "");
                if (long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var i)) return i;
                throw new ArgumentException($"'{n.GetValue<string>()}' is not a whole number");
            default:
                throw new ArgumentException("A whole number is required");
        }
    }

    /// <summary>Python's secrets.token_hex(4): 8 hex characters.</summary>
    public static string TokenHex(int bytes = 4) => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(bytes));

    [GeneratedRegex(@"[\x00-\x08\x0b-\x1f\x7f]")]
    private static partial Regex ControlRx();

    /// <summary>Plain text only: control characters removed, spaces trimmed, cut to the limit (cms._text).</summary>
    public static string PlainText(JsonNode? value, int limit) => Cut(ControlRx().Replace(OrEmpty(value), "").Trim(), limit);

    /// <summary>Python's datetime.isoformat() for an aware time (microseconds only when not zero).</summary>
    public static string IsoText(DateTimeOffset t)
    {
        var frac = t.Ticks % TimeSpan.TicksPerSecond / 10;
        var main = t.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) + (frac != 0 ? "." + frac.ToString("D6") : "");
        var off = t.Offset;
        var sign = off < TimeSpan.Zero ? "-" : "+";
        off = off.Duration();
        return $"{main}{sign}{off.Hours:D2}:{off.Minutes:D2}";
    }

    [GeneratedRegex(@"(Z|z|[+-]\d{2}(:?\d{2})?)$")]
    private static partial Regex OffsetRx();

    /// <summary>Python's datetime.fromisoformat(text): (time, had an offset), or false when it is not a date and time.</summary>
    public static bool TryParseIso(string text, out DateTimeOffset value, out bool aware)
    {
        value = default;
        var t = text.Trim();
        aware = t.Length > 10 && OffsetRx().IsMatch(t);
        if (t.Length < 10) return false;
        if (aware)
            return DateTimeOffset.TryParse(t, CultureInfo.InvariantCulture, DateTimeStyles.None, out value);
        if (!DateTime.TryParse(t, CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) return false;
        value = new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), TimeSpan.Zero);
        return true;
    }

    /// <summary>Python's float formatting in JSON for a rating (0.0, 4.5).</summary>
    public static double Rating(decimal v) => (double)v;
}
