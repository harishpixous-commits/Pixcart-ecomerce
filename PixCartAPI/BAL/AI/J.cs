using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BAL.AI;

/// <summary>
/// Small helpers for the JSON documents the AI code passes around (the reference version uses plain dicts): reading
/// values leniently, building objects and serialising like Python's json.dumps(ensure_ascii=False).
/// </summary>
public static class J
{
    /// <summary>Compact JSON that keeps ₹ and Indian scripts readable (json.dumps(..., ensure_ascii=False)).</summary>
    public static readonly JsonSerializerOptions Relaxed = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = false };

    public static string Dumps(JsonNode? node) => node is null ? "null" : node.ToJsonString(Relaxed);

    public static string Dumps(object? value) => value is JsonNode n ? Dumps(n) : JsonSerializer.Serialize(value, Relaxed);

    public static JsonNode? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonNode.Parse(json); } catch (JsonException) { return null; }
    }

    public static JsonObject Obj(string? json) => Parse(json) as JsonObject ?? [];

    public static JsonArray Arr(string? json) => Parse(json) as JsonArray ?? [];

    public static JsonNode? Clone(JsonNode? n) => n?.DeepClone();

    /// <summary>A value as text: strings as they are, numbers and booleans as Python's str() would show them, null as "".</summary>
    public static string S(JsonNode? n)
    {
        if (n is null) return "";
        if (n is JsonValue v)
        {
            if (v.TryGetValue<string>(out var s)) return s;
            if (v.TryGetValue<bool>(out var b)) return b ? "True" : "False";
            return v.ToJsonString();
        }
        return n.ToJsonString(Relaxed);
    }

    public static string S(JsonObject? o, string key) => o is null ? "" : S(o[key]);

    public static bool Truthy(JsonNode? n)
    {
        if (n is null) return false;
        if (n is JsonValue v)
        {
            if (v.TryGetValue<bool>(out var b)) return b;
            if (v.TryGetValue<string>(out var s)) return s.Length > 0;
            if (v.TryGetValue<double>(out var d)) return d != 0;
            return true;
        }
        if (n is JsonArray a) return a.Count > 0;
        if (n is JsonObject o) return o.Count > 0;
        return true;
    }

    public static long? Long(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<double>(out var d)) return (long)d;
        if (v.TryGetValue<decimal>(out var m)) return (long)m;
        if (v.TryGetValue<string>(out var s) && long.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p)) return p;
        return null;
    }

    public static double? Double(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<long>(out var l)) return l;
        if (v.TryGetValue<decimal>(out var m)) return (double)m;
        if (v.TryGetValue<string>(out var s) && double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var p)) return p;
        return null;
    }

    /// <summary>A JSON number that is a whole number and not a boolean (Python's isinstance(v, int) and not bool).</summary>
    public static bool IsInt(JsonNode? n) =>
        n is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<long>(out _);

    public static bool IsNumber(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.Number;

    public static bool IsBool(JsonNode? n) => n is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False;

    public static bool IsString(JsonNode? n) => n is JsonValue v && v.GetValueKind() == JsonValueKind.String;

    public static JsonArray Strings(IEnumerable<string> items) => new(items.Select(s => (JsonNode?)JsonValue.Create(s)).ToArray());

    /// <summary>An object from key/value pairs; values may be nodes, strings, numbers, booleans or null.</summary>
    public static JsonObject O(params (string Key, object? Value)[] items)
    {
        var o = new JsonObject();
        foreach (var (k, v) in items) o[k] = Node(v);
        return o;
    }

    public static JsonNode? Node(object? v) => v switch
    {
        null => null,
        JsonNode n => n.Parent is null ? n : n.DeepClone(),
        string s => JsonValue.Create(s),
        bool b => JsonValue.Create(b),
        int i => JsonValue.Create(i),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        decimal m => JsonValue.Create(m),
        Guid g => JsonValue.Create(g.ToString()),
        DateTime dt => JsonValue.Create(Utils.DateTimeFunctions.Iso(dt)),
        IEnumerable<string> ss => Strings(ss),
        _ => JsonSerializer.SerializeToNode(v, Utils.JsonHelper.Options),
    };

    public static JsonArray A(IEnumerable<object?> items) => new(items.Select(Node).ToArray());

    /// <summary>Merges b's keys into a copy of a (Python's a | b).</summary>
    public static JsonObject Merge(JsonObject a, JsonObject b)
    {
        var outp = (JsonObject)a.DeepClone();
        foreach (var (k, v) in b) outp[k] = v?.DeepClone();
        return outp;
    }

    public static string Cut(string s, int n) => s.Length > n ? s[..n] : s;
}
