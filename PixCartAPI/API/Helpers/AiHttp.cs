using System.Text.Json;
using BAL.AI;
using Utils;

namespace API.Helpers;

/// <summary>Request helpers of the AI controllers: path ids checked like the reference API (422), and server-sent events.</summary>
public static class AiHttp
{
    /// <summary>A UUID from the path, or 422 validation_error as the reference API answers for a malformed id.</summary>
    public static Guid Id(string value, string field)
    {
        if (Guid.TryParse(value, out var id)) return id;
        var label = char.ToUpperInvariant(field[0]) + field[1..].Replace('_', ' ');
        throw new AppException($"{label}: Input should be a valid UUID", "validation_error", 422,
            new Dictionary<string, string> { [field] = "Input should be a valid UUID" });
    }

    /// <summary>A value that must be one of the choices (the reference Literal path parameters), else 422.</summary>
    public static string Choice(string value, string field, params string[] choices)
    {
        if (choices.Contains(value)) return value;
        var msg = "Input should be " + string.Join(" or ", choices.Select(c => $"'{c}'"));
        throw new AppException($"{char.ToUpperInvariant(field[0]) + field[1..]}: {msg}", "validation_error", 422, new Dictionary<string, string> { [field] = msg });
    }

    /// <summary>Starts a text/event-stream response and returns the function that writes one event ("data: {json}\n\n").</summary>
    public static Func<System.Text.Json.Nodes.JsonObject, Task> StartSse(HttpResponse response, string cacheControl, bool noSniff)
    {
        response.StatusCode = 200;
        response.ContentType = "text/event-stream; charset=utf-8";
        response.Headers.CacheControl = cacheControl;
        response.Headers["X-Accel-Buffering"] = "no";
        if (noSniff) response.Headers["X-Content-Type-Options"] = "nosniff";
        return async ev =>
        {
            await response.WriteAsync("data: " + ev.ToJsonString(J.Relaxed) + "\n\n");
            await response.Body.FlushAsync();
        };
    }

    public static string Dict(Dictionary<string, JsonElement>? d, string key) =>
        d != null && d.TryGetValue(key, out var v) ? (v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? "None" : v.GetRawText()) : "";
}
