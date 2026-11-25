using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>
/// Admin-editable marketplace settings (Admin → Marketplace settings, the <c>platform_settings</c> row "marketplace"):
/// fees, COD, tax rates, feature switches, product page modules, list sizes, maintenance mode, error pages, app links.
/// Every module reads them through this interface. The values are the reference version's DEFAULTS with the saved
/// values on top (unknown saved keys are ignored), in the same key order.
/// </summary>
public interface IPlatformSettingsBAL
{
    /// <summary>The merged settings document (defaults plus saved values). Cached for the request; do not modify it.</summary>
    Task<JsonObject> GetAsync();

    /// <summary>
    /// Checks the changes (types, ranges, choices, links, texts) and saves them over the stored values, under a row lock.
    /// Returns the merged settings. Throws <see cref="Utils.AppException"/> 400 "invalid_setting" with the reference
    /// message (e.g. "search_page_size must be a whole number between 8 and 60") when a value is not allowed.
    /// </summary>
    Task<JsonObject> UpdateAsync(JsonObject updates);

    /// <summary>The cleaned changes (spaces tidied in texts), or 400 "invalid_setting". Does not save.</summary>
    JsonObject Validate(JsonObject updates);

    /// <summary>Locked merge of already-validated updates inside the caller's transaction, so related writes
    /// commit with the change (reference: update_settings' single session).</summary>
    Task MergeValidatedAsync(JsonObject clean, Utils.Interface.IUnitOfWork uow);

    /// <summary>Drops the cached settings after an outside-the-service write.</summary>
    void InvalidateCache();
}

/// <summary>Typed reads from a settings document (JSON numbers, booleans and strings).</summary>
public static class SettingsJson
{
    public static long Long(this JsonObject o, string key) => ToLong(o[key]);

    public static int Int(this JsonObject o, string key) => (int)ToLong(o[key]);

    public static bool Bool(this JsonObject o, string key) => o[key] is JsonValue v && v.GetValueKind() == JsonValueKind.True;

    public static string Str(this JsonObject o, string key) => o[key] is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : "";

    /// <summary>A JSON number as a whole number (0 for anything else).</summary>
    public static long ToLong(JsonNode? n)
    {
        if (n is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return 0;
        return decimal.TryParse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? (long)d : 0;
    }

    /// <summary>A JSON number as a decimal (null for anything else).</summary>
    public static decimal? ToDecimal(JsonNode? n) =>
        n is JsonValue v && v.GetValueKind() == JsonValueKind.Number && decimal.TryParse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;

    /// <summary>True for a JSON whole number (not a boolean, not 5.0), like Python's isinstance(value, int).</summary>
    public static bool IsWholeNumber(JsonNode? n, out long value)
    {
        value = 0;
        if (n is not JsonValue v || v.GetValueKind() != JsonValueKind.Number) return false;
        var text = v.ToJsonString();
        if (text.Contains('.') || text.Contains('e') || text.Contains('E')) return false;
        return long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value);
    }

    /// <summary>Python truthiness of a JSON value (bool(x)).</summary>
    public static bool Truthy(JsonNode? n) => n switch
    {
        null => false,
        JsonObject o => o.Count > 0,
        JsonArray a => a.Count > 0,
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False or JsonValueKind.Null => false,
            JsonValueKind.String => v.GetValue<string>().Length > 0,
            JsonValueKind.Number => ToDecimal(v) != 0,
            _ => false,
        },
        _ => false,
    };

    /// <summary>Python's str(x) for a JSON value ("" for null, like str(x or "")).</summary>
    public static string Text(JsonNode? n) => n switch
    {
        null => "",
        JsonValue v when v.GetValueKind() == JsonValueKind.String => v.GetValue<string>(),
        JsonValue v when v.GetValueKind() == JsonValueKind.Null => "",
        JsonValue v when v.GetValueKind() == JsonValueKind.True => "True",
        JsonValue v when v.GetValueKind() == JsonValueKind.False => "False",
        _ => n.ToJsonString(),
    };
}
