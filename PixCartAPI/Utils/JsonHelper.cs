using System.Text.Json;
using System.Text.Json.Nodes;

namespace Utils;

/// <summary>
/// JSON exactly like the reference API: snake_case names, no indentation, nulls kept. JSON columns in MySQL are read and
/// written as text through these helpers.
/// </summary>
public static class JsonHelper
{
    public static readonly JsonSerializerOptions Options = Create();

    public static JsonSerializerOptions Create()
    {
        var o = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            DictionaryKeyPolicy = null,
            WriteIndented = false,
            // characters as they are ("₹", "'"), like the reference (json.dumps(ensure_ascii=False)); only what JSON
            // itself needs is escaped
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        return o;
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string? json) => string.IsNullOrWhiteSpace(json) || json == "null" ? default : JsonSerializer.Deserialize<T>(json, Options);

    /// <summary>A JSON column as a node (object, array or value), or null.</summary>
    public static JsonNode? Node(string? json) => string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json);

    public static JsonObject Object(string? json) => Node(json) as JsonObject ?? [];

    public static JsonArray Array(string? json) => Node(json) as JsonArray ?? [];
}
