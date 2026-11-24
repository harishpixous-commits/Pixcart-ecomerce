using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BAL.AI;

/// <summary>
/// One kind of LLM provider and how to talk to it. Two wire protocols cover almost every provider:
/// "anthropic" (Anthropic Messages API, Claude) and "openai" (OpenAI Chat Completions, which most providers also serve:
/// OpenAI, Azure OpenAI v1, Gemini's OpenAI-compatible endpoint, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together,
/// Fireworks, Cerebras, and local servers such as Ollama, LM Studio and vLLM). A provider entry only supplies defaults;
/// admins can add any OpenAI-compatible server with the "custom" type, so a new provider needs no code change.
/// </summary>
public sealed record ProviderType(string Key, string Name, string Protocol, string BaseUrl, string Auth = "bearer", bool NeedsKey = true,
    bool Local = false, string[]? ExampleModels = null, string DocsUrl = "", string Notes = "");

/// <summary>Known provider types and the routes (what each fallback chain is used for). Same as the reference catalog.</summary>
public static class LlmCatalog
{
    public static readonly ProviderType[] ProviderTypes =
    [
        new("anthropic", "Anthropic (Claude)", "anthropic", "https://api.anthropic.com", Auth: "x-api-key",
            ExampleModels: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"], DocsUrl: "https://docs.claude.com/en/api/overview"),
        new("openai", "OpenAI", "openai", "https://api.openai.com/v1", DocsUrl: "https://platform.openai.com/docs/api-reference/chat"),
        new("azure_openai", "Azure OpenAI", "openai", "https://YOUR-RESOURCE.openai.azure.com/openai/v1", Auth: "api-key",
            DocsUrl: "https://learn.microsoft.com/azure/ai-foundry/openai/reference", Notes: "Use your deployment name as the model."),
        new("gemini", "Google Gemini", "openai", "https://generativelanguage.googleapis.com/v1beta/openai",
            DocsUrl: "https://ai.google.dev/gemini-api/docs/openai", Notes: "Gemini's OpenAI-compatible endpoint."),
        new("groq", "Groq", "openai", "https://api.groq.com/openai/v1", DocsUrl: "https://console.groq.com/docs/openai"),
        new("mistral", "Mistral", "openai", "https://api.mistral.ai/v1", DocsUrl: "https://docs.mistral.ai/api/"),
        new("deepseek", "DeepSeek", "openai", "https://api.deepseek.com/v1", DocsUrl: "https://api-docs.deepseek.com/"),
        new("xai", "xAI (Grok)", "openai", "https://api.x.ai/v1", DocsUrl: "https://docs.x.ai/"),
        new("openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1", DocsUrl: "https://openrouter.ai/docs",
            Notes: "One key for hundreds of models, including Bedrock and Vertex-hosted ones."),
        new("together", "Together AI", "openai", "https://api.together.xyz/v1", DocsUrl: "https://docs.together.ai/"),
        new("fireworks", "Fireworks AI", "openai", "https://api.fireworks.ai/inference/v1", DocsUrl: "https://docs.fireworks.ai/"),
        new("cerebras", "Cerebras", "openai", "https://api.cerebras.ai/v1", DocsUrl: "https://inference-docs.cerebras.ai/"),
        new("ollama", "Ollama (local)", "openai", "http://localhost:11434/v1", Auth: "none", NeedsKey: false, Local: true,
            DocsUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md", Notes: "Runs models on your own server. Pick a model that supports tools."),
        new("lmstudio", "LM Studio (local)", "openai", "http://localhost:1234/v1", Auth: "none", NeedsKey: false, Local: true,
            DocsUrl: "https://lmstudio.ai/docs/app/api/endpoints/openai"),
        new("vllm", "vLLM (self-hosted)", "openai", "http://localhost:8000/v1", NeedsKey: false, Local: true,
            DocsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html"),
        new("custom", "Any OpenAI-compatible server", "openai", "https://", NeedsKey: false, DocsUrl: "", Notes: "Enter the address that ends before /chat/completions."),
    ];

    public static readonly Dictionary<string, ProviderType> Types = ProviderTypes.ToDictionary(p => p.Key);

    /// <summary>What each route is used for; every route has its own ordered list of (connection, model) to try.</summary>
    public static readonly (string Key, string Label, string Help)[] Routes =
    [
        ("assistant", "AI assistant (chat and voice)", "Needs a model that supports tool calling."),
        ("assistant_fast", "Quick answers and voice", "A fast model for short questions and spoken replies. Empty = use the assistant route."),
        ("studio", "AI studio drafts", "Listing writer, support drafts, review summaries, business brief."),
        ("shop_assistant", "Shop assistant (customer chat on the website)",
            "Answers customers on the storefront with customer-only tools. Needs tool calling. Empty = use the AI assistant route."),
        ("translate", "Translating the site (languages)",
            "Translates the website and panels into the languages switched on in Admin → Languages and currencies. Any fast model. Empty = use the AI assistant route."),
    ];

    public static bool IsRoute(string r) => Routes.Any(x => x.Key == r);

    public static JsonObject RouteInfo()
    {
        var o = new JsonObject();
        foreach (var (k, label, help) in Routes) o[k] = J.O(("label", label), ("help", help));
        return o;
    }
}

/// <summary>A configured connection: one provider address with several API keys (decrypted, in order) and models.</summary>
public sealed class LlmConnection
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Type { get; init; } = "";
    public string BaseUrl { get; init; } = "";
    public List<string> Keys { get; init; } = [];
    public List<string> KeyIds { get; init; } = [];
    public List<string> Models { get; init; } = [];
    public bool Enabled { get; init; } = true;
    public int TimeoutS { get; init; } = 60;
    public bool Builtin { get; init; }
    public Dictionary<string, string> ExtraHeaders { get; init; } = [];

    public string Protocol => LlmCatalog.Types.TryGetValue(Type, out var t) ? t.Protocol : "openai";
    public string Auth => LlmCatalog.Types.TryGetValue(Type, out var t) ? t.Auth : "bearer";
}

public sealed record LlmTarget(LlmConnection Connection, string Model);

/// <summary>A system prompt block; blocks marked Cache become prompt-cache breakpoints where the provider supports it.</summary>
public sealed record SystemBlock(string Text, bool Cache = false);

/// <summary>One finished model turn in the canonical (Anthropic-style content blocks) format.</summary>
public sealed class LlmTurn
{
    public JsonArray Content { get; init; } = [];
    public string StopReason { get; init; } = "end_turn";
    public string Model { get; init; } = "";
    public int InputTokens { get; init; }
    public int OutputTokens { get; init; }
    public int CacheCreationTokens { get; init; }
    public int CacheReadTokens { get; init; }

    public string Text => string.Concat(Content.OfType<JsonObject>().Where(b => J.S(b, "type") == "text").Select(b => J.S(b, "text")));
}

/// <summary>Which connection and model answered, and after how many failed attempts.</summary>
public sealed record LlmUsed(string ConnectionId, string ConnectionName, string Provider, string Model, int Fallbacks);

/// <summary>
/// Events of a streamed answer: "text" (Text = delta), "tool" (ToolId, ToolName: a tool call started), "turn" (Turn:
/// the finished turn) and, from the router, a final "used".
/// </summary>
public sealed record LlmEvent(string Kind, string? Text = null, string? ToolId = null, string? ToolName = null, LlmTurn? Turn = null, LlmUsed? Used = null);

/// <summary>A provider failure. Retryable ones move on to the next key or fallback model.</summary>
public sealed class ProviderException(string message, int status = 0, bool retryable = true, bool keyProblem = false) : Exception(message)
{
    public int Status { get; } = status;
    public bool Retryable { get; } = retryable;
    public bool KeyProblem { get; } = keyProblem;

    public static ProviderException Classify(int status, string body)
    {
        var text = J.Cut(body, 300);
        var low = text.ToLowerInvariant();
        if (status is 401 or 403) return new($"Key rejected ({status})", status, true, true);
        if (status == 429) return new("Rate limited", status, true, true);
        if (status == 402 || (status == 400 && (low.Contains("credit") || low.Contains("billing") || low.Contains("quota"))))
            return new("Out of credit", status, true, true);
        if (status == 404) return new("Model or address not found", status);
        if (status >= 500 || status == 408) return new($"Provider error ({status})", status);
        return new($"Request rejected ({status}): {J.Cut(text, 160)}", status);
    }
}

/// <summary>
/// The HTTP transport for providers and the Laya decision server. Tests set <see cref="TestHandler"/> (and
/// <see cref="LayaTestHandler"/>) to a stub so no real API is called — the reference version's httpx MockTransport.
/// </summary>
public static class LlmTransport
{
    public static HttpMessageHandler? TestHandler { get; set; }
    public static HttpMessageHandler? LayaTestHandler { get; set; }

    private static readonly SocketsHttpHandler Shared = new()
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        ConnectTimeout = TimeSpan.FromSeconds(10),
    };

    public static HttpClient Client() => new(TestHandler ?? Shared, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };

    public static HttpClient LayaClient() => new(LayaTestHandler ?? Shared, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>Headers for a request with this key, by protocol and auth style.</summary>
    public static void AddHeaders(HttpRequestMessage req, LlmConnection conn, string key)
    {
        foreach (var (k, v) in conn.ExtraHeaders) req.Headers.TryAddWithoutValidation(k, v);
        if (conn.Protocol == "anthropic")
        {
            req.Headers.TryAddWithoutValidation("x-api-key", key);
            req.Headers.TryAddWithoutValidation("anthropic-version", AnthropicAdapter.AnthropicVersion);
        }
        else if (conn.Auth == "api-key") req.Headers.TryAddWithoutValidation("api-key", key);
        else if (conn.Auth == "x-api-key") req.Headers.TryAddWithoutValidation("x-api-key", key);
        else if (conn.Auth == "bearer" && !string.IsNullOrEmpty(key)) req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {key}");
    }

    public static string Url(LlmConnection conn, string path) => conn.BaseUrl.TrimEnd('/') + path;
}

/// <summary>Server-sent events: yields each event's joined "data:" lines parsed as JSON; stops at [DONE].</summary>
public static class SseReader
{
    public static async IAsyncEnumerable<JsonObject> ReadAsync(Stream stream, [EnumeratorCancellation] CancellationToken ct)
    {
        using var reader = new StreamReader(stream);
        var data = new List<string>();
        while (true)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) break;
            if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                data.Add(line[5..].Trim());
            }
            else if (line.Length == 0 && data.Count > 0)
            {
                var raw = string.Join("\n", data);
                data.Clear();
                if (raw == "[DONE]") yield break;
                if (TryParse(raw) is { } ev) yield return ev;
            }
        }
        if (data.Count > 0 && !(data.Count == 1 && data[0] == "[DONE]") && TryParse(string.Join("\n", data)) is { } last) yield return last;
    }

    private static JsonObject? TryParse(string raw)
    {
        try { return JsonNode.Parse(raw) as JsonObject; } catch (JsonException) { return null; }
    }
}

/// <summary>One wire protocol. Takes the canonical conversation and reports the same events for every provider.</summary>
public interface ILlmAdapter
{
    Task StreamAsync(LlmConnection conn, string key, string model, IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray tools,
        int maxTokens, Func<LlmEvent, Task> emit, CancellationToken ct);
}

public static class LlmAdapters
{
    public static readonly ILlmAdapter Anthropic = new AnthropicAdapter();
    public static readonly ILlmAdapter OpenAi = new OpenAiCompatibleAdapter();

    public static ILlmAdapter For(LlmConnection conn) => conn.Protocol == "anthropic" ? Anthropic : OpenAi;
}
