using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Utils;

namespace API.Helpers;

/// <summary>
/// The return items of a return request, read like the reference's ReturnIn.lines(): the items are free-form objects
/// ({order_item_id, qty}); a missing key, an id that is not a UUID or a quantity that is not a whole number is refused
/// with the reference's answer (400 invalid_items "Choose the items and quantities to return"), never with a JSON
/// conversion error. Used by the shopper's and the staff's "open a return".
/// </summary>
public static partial class ReturnLines
{
    [GeneratedRegex(@"^[+-]?\d+(_\d+)*$")]
    private static partial Regex WholeNumberText();

    public static List<(Guid OrderItemId, int Qty)> Parse(IEnumerable<JsonElement> items)
    {
        var lines = new List<(Guid, int)>();
        foreach (var item in items)
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("order_item_id", out var id) || !item.TryGetProperty("qty", out var qty))
                throw Invalid();
            lines.Add((LenientUuid(id) ?? throw Invalid(), LenientInt(qty) ?? throw Invalid()));
        }
        return lines;
    }

    private static AppException Invalid() => new("Choose the items and quantities to return", "invalid_items", 400);

    /// <summary>A lenient UUID: braces, a "urn:uuid:" prefix and dashes anywhere are allowed; 32 hex digits.</summary>
    private static Guid? LenientUuid(JsonElement v)
    {
        var text = v.ValueKind == JsonValueKind.String ? v.GetString()! : v.GetRawText(); // str() of a number never parses
        var hex = text.Replace("urn:", "").Replace("uuid:", "").Trim('{', '}').Replace("-", "");
        return hex.Length == 32 && hex.All(Uri.IsHexDigit) && Guid.TryParseExact(hex, "N", out var g) ? g : null;
    }

    /// <summary>Python's int(v) on a JSON value: whole numbers, decimals truncated (int(2.9) == 2), true/false as 1/0,
    /// numeric strings (spaces around and single underscores between digits allowed); null, lists and objects fail.</summary>
    private static int? LenientInt(JsonElement v)
    {
        switch (v.ValueKind)
        {
            case JsonValueKind.True:
                return 1;
            case JsonValueKind.False:
                return 0;
            case JsonValueKind.Number:
                if (v.TryGetInt64(out var whole)) return Clamp(whole);
                return v.TryGetDouble(out var d) && double.IsFinite(d) ? Clamp((long)Math.Truncate(Math.Clamp(d, long.MinValue, long.MaxValue))) : null;
            case JsonValueKind.String:
                var t = v.GetString()!.Trim();
                return WholeNumberText().IsMatch(t) && long.TryParse(t.Replace("_", ""), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var p)
                    ? Clamp(p) : null;
            default:
                return null;
        }
    }

    private static int Clamp(long v) => v > int.MaxValue ? int.MaxValue : v < int.MinValue ? int.MinValue : (int)v;
}
