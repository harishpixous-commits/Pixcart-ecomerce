using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Utils;

namespace API.Infrastructure;

/// <summary>
/// Every time in an API answer is written the way the reference writes it (Python's datetime.isoformat() for UTC):
/// "2026-11-23T11:19:56.101216+00:00", or "2026-11-23T11:19:56+00:00" when there are no microseconds. The screens and
/// apps read these strings, so the format is part of the contract.
///
/// Answers built as JsonObject/JsonArray can hold DateTime values (written by System.Text.Json as "...1012160Z") and
/// strings made with ToString("o"); both are rewritten here, just before the answer is sent. Plain objects and records
/// get the same format from <see cref="ReferenceDateTimeConverter"/>.
/// </summary>
public sealed partial class ReferenceJsonFilter : IAsyncResultFilter
{
    // a UTC instant (Z or +00:00). A time without a zone is left as it is: the reference writes naive times that way
    // too (Excel cells in uploads, "1900-01-01T00:00:00"); so are a date alone and another zone ("+05:30").
    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|\+00:00)$")]
    private static partial Regex UtcInstant();

    public Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
    {
        if (context.Result is JsonResult { Value: JsonNode jsonNode }) Normalise(jsonNode);
        if (context.Result is ObjectResult result)
        {
            switch (result.Value)
            {
                case JsonNode node:
                    Normalise(node);
                    break;
                case null or string or Stream or byte[] or ProblemDetails:
                    break;
                default:
                    // a plain object (often wrapping JsonObjects built with ToString("o") times): written to a JSON tree
                    // with the API's own settings, then normalised like the rest
                    var options = context.HttpContext.RequestServices
                        .GetRequiredService<Microsoft.Extensions.Options.IOptions<JsonOptions>>().Value.JsonSerializerOptions;
                    var tree = JsonSerializer.SerializeToNode(result.Value, result.Value.GetType(), options);
                    if (tree is not null)
                    {
                        Normalise(tree);
                        result.Value = tree;
                        result.DeclaredType = typeof(JsonNode);
                    }
                    break;
            }
        }
        return next();
    }

    /// <summary>Rewrites every time inside the tree in place.</summary>
    public static void Normalise(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var key in o.Select(kv => kv.Key).ToList())
                {
                    if (o[key] is JsonValue v) { if (Rewrite(v) is { } s) o[key] = s; }
                    else Normalise(o[key]);
                }
                break;
            case JsonArray a:
                for (var i = 0; i < a.Count; i++)
                {
                    if (a[i] is JsonValue v) { if (Rewrite(v) is { } s) a[i] = s; }
                    else Normalise(a[i]);
                }
                break;
        }
    }

    /// <summary>The reference text for a time value, or null when the value is not a UTC time.</summary>
    private static string? Rewrite(JsonValue v)
    {
        var raw = v.GetValue<object>();
        if (raw is DateTime dt) return DateTimeFunctions.Iso(dt.Kind == DateTimeKind.Local ? dt.ToUniversalTime() : dt);
        if (raw is DateTimeOffset dto) return DateTimeFunctions.Iso(dto.UtcDateTime);
        string? text = raw switch
        {
            string s => s,
            JsonElement { ValueKind: JsonValueKind.String } e => e.GetString(),
            _ => null,
        };
        if (text is null || text.Length < 19 || !UtcInstant().IsMatch(text)) return null;
        var parsed = DateTime.Parse(text.TrimEnd('Z').Replace("+00:00", ""), System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal);
        var iso = DateTimeFunctions.Iso(parsed);
        return iso == text ? null : iso;
    }
}

/// <summary>DateTime in plain objects and records, written like the reference (see <see cref="ReferenceJsonFilter"/>).</summary>
public sealed class ReferenceDateTimeConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) =>
        writer.WriteStringValue(DateTimeFunctions.Iso(value.Kind == DateTimeKind.Local ? value.ToUniversalTime() : value));
}
