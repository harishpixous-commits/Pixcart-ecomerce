using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using API.Service;
using BAL.AI;
using Dapper;
using DAL.Helpers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using MySqlConnector;
using Utils;
using Xunit;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Tests.AI;

/// <summary>
/// The API against a real MySQL test database (pixcart_test_ai on 127.0.0.1:3307), created fresh once per test run.
/// Providers are faked with a stub HttpMessageHandler: no real AI API is ever called.
/// </summary>
public sealed class AiFixture : IAsyncLifetime
{
    public const string ConnectionString = "Server=127.0.0.1;Port=3307;Database=pixcart_test_ai;User=root;Password=pixcart;";
    public WebApplicationFactory<Program> Factory { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        Environment.SetEnvironmentVariable("App__Environment", "test");
        Environment.SetEnvironmentVariable("App__ConnectionString", ConnectionString);
        Environment.SetEnvironmentVariable("App__RunJobs", "false");
        Environment.SetEnvironmentVariable("App__AnthropicApiKey", "");
        Environment.SetEnvironmentVariable("App__SmtpHost", "");
        await using (var c = new MySqlConnection("Server=127.0.0.1;Port=3307;User=root;Password=pixcart;"))
            await c.ExecuteAsync("DROP DATABASE IF EXISTS pixcart_test_ai");
        Factory = new WebApplicationFactory<Program>();
        await Factory.Services.GetRequiredService<DatabaseMigrator>().MigrateAsync();
    }

    public Task DisposeAsync()
    {
        Factory.Dispose();
        return Task.CompletedTask;
    }

    public Db Db => new();

    public Api Client(Guid? userId = null, bool admin = false, Dictionary<string, string>? headers = null)
    {
        var http = Factory.CreateClient();
        if (userId is { } id)
        {
            var token = Factory.Services.GetRequiredService<TokenService>().CreateAccessToken(id, admin);
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        foreach (var (k, v) in headers ?? []) http.DefaultRequestHeaders.TryAddWithoutValidation(k, v);
        return new Api(http);
    }

    public string Encrypt(string plain) => Factory.Services.GetRequiredService<EncryptDecrypt>().Encrypt(plain);

    /// <summary>Resets the fake provider and cooldowns; tests that need live mode install a handler.</summary>
    public static void Offline()
    {
        LlmTransport.TestHandler = null;
        LlmTransport.LayaTestHandler = null;
        LlmRouterBAL.ClearCooldowns();
        LlmRouterBAL.RetryDelay = TimeSpan.Zero;
    }
}

[CollectionDefinition("ai")]
public sealed class AiCollection : ICollectionFixture<AiFixture>;

/// <summary>An HTTP client with JSON helpers.</summary>
public sealed class Api(HttpClient http)
{
    public HttpClient Http { get; } = http;

    public sealed record Res(HttpStatusCode Status, string Text, byte[] Bytes)
    {
        public int Code => (int)Status;
        public JsonNode Json => JsonNode.Parse(Text)!;
        public JsonObject Obj => (JsonObject)Json;
        public string ErrorCode => Text.Length > 0 && Text[0] == '{' && Obj["error"] is { } e ? (string)e["code"]! : $"(no error: {Code} {Text})";

        /// <summary>Fails with the response text unless the status is as expected.</summary>
        public Res Is(int code)
        {
            Assert.True(Code == code, $"expected {code}, got {Code}: {Text}");
            return this;
        }

        /// <summary>Server-sent events of a streamed answer.</summary>
        public List<JsonObject> Events => Text.Split('\n').Where(l => l.StartsWith("data:")).Select(l => (JsonObject)JsonNode.Parse(l[5..])!).ToList();
    }

    private async Task<Res> Send(HttpMethod method, string path, object? body)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body != null)
            req.Content = new StringContent(body is JsonNode n ? n.ToJsonString() : System.Text.Json.JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var resp = await Http.SendAsync(req);
        var bytes = await resp.Content.ReadAsByteArrayAsync();
        return new Res(resp.StatusCode, Encoding.UTF8.GetString(bytes), bytes);
    }

    public Task<Res> Get(string path) => Send(HttpMethod.Get, path, null);
    public Task<Res> Post(string path, object? body = null) => Send(HttpMethod.Post, path, body ?? new { });
    public Task<Res> Put(string path, object body) => Send(HttpMethod.Put, path, body);
    public Task<Res> Patch(string path, object body) => Send(HttpMethod.Patch, path, body);
    public Task<Res> Delete(string path) => Send(HttpMethod.Delete, path, null);

    public async Task<Res> Upload(string path, string filename, byte[] data, string contentType)
    {
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(data);
        file.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        form.Add(file, "file", filename);
        using var resp = await Http.PostAsync(path, form);
        var bytes = await resp.Content.ReadAsByteArrayAsync();
        return new Res(resp.StatusCode, Encoding.UTF8.GetString(bytes), bytes);
    }
}

/// <summary>A fake provider: records every request and answers with the handler's response.</summary>
public sealed class StubProvider(Func<HttpRequestMessage, JsonObject, HttpResponseMessage> handler) : HttpMessageHandler
{
    public sealed record Call(string Url, JsonObject Body, Dictionary<string, string> Headers);

    public List<Call> Calls { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var text = request.Content is null ? "{}" : await request.Content.ReadAsStringAsync(ct);
        var body = JsonNode.Parse(string.IsNullOrEmpty(text) ? "{}" : text) as JsonObject ?? [];
        var headers = request.Headers.ToDictionary(h => h.Key.ToLowerInvariant(), h => string.Join(",", h.Value));
        lock (Calls) Calls.Add(new Call(request.RequestUri!.ToString(), body, headers));
        return handler(request, body);
    }

    public static HttpResponseMessage Sse(string text) =>
        new(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, "text/event-stream") };

    public static HttpResponseMessage Error(int status, string message) =>
        new((HttpStatusCode)status) { Content = new StringContent($"{{\"error\": {{\"message\": \"{message}\"}}}}", Encoding.UTF8, "application/json") };

    /// <summary>A Messages API stream (text and tool_use blocks), as the real API sends it.</summary>
    public static string Anthropic(IEnumerable<JsonObject> blocks, string stop, JsonObject? usage = null, string model = "claude-haiku-5-5")
    {
        usage ??= new JsonObject { ["input_tokens"] = 50, ["output_tokens"] = 20 };
        var startUsage = new JsonObject();
        foreach (var (k, v) in usage) if (k != "output_tokens") startUsage[k] = v?.DeepClone();
        var evs = new List<JsonObject> { new() { ["type"] = "message_start", ["message"] = new JsonObject { ["model"] = model, ["usage"] = startUsage } } };
        var i = 0;
        foreach (var b in blocks)
        {
            if ((string)b["type"]! == "text")
            {
                evs.Add(new() { ["type"] = "content_block_start", ["index"] = i, ["content_block"] = new JsonObject { ["type"] = "text", ["text"] = "" } });
                evs.Add(new() { ["type"] = "content_block_delta", ["index"] = i, ["delta"] = new JsonObject { ["type"] = "text_delta", ["text"] = b["text"]!.DeepClone() } });
            }
            else
            {
                evs.Add(new() { ["type"] = "content_block_start", ["index"] = i,
                    ["content_block"] = new JsonObject { ["type"] = "tool_use", ["id"] = b["id"]!.DeepClone(), ["name"] = b["name"]!.DeepClone(), ["input"] = new JsonObject() } });
                evs.Add(new() { ["type"] = "content_block_delta", ["index"] = i,
                    ["delta"] = new JsonObject { ["type"] = "input_json_delta", ["partial_json"] = b["input"]!.ToJsonString() } });
            }
            evs.Add(new() { ["type"] = "content_block_stop", ["index"] = i });
            i++;
        }
        evs.Add(new() { ["type"] = "message_delta", ["delta"] = new JsonObject { ["stop_reason"] = stop }, ["usage"] = new JsonObject { ["output_tokens"] = usage["output_tokens"]?.DeepClone() ?? 0 } });
        evs.Add(new() { ["type"] = "message_stop" });
        return string.Concat(evs.Select(e => $"event: {e["type"]}\ndata: {e.ToJsonString()}\n\n"));
    }

    public static JsonObject Text(string t) => new() { ["type"] = "text", ["text"] = t };

    public static JsonObject Tool(string id, string name, JsonObject input) => new() { ["type"] = "tool_use", ["id"] = id, ["name"] = name, ["input"] = input };

    /// <summary>An OpenAI Chat Completions stream with one text answer and usage.</summary>
    public static string OpenAi(string text, string model = "gemini-x")
    {
        var chunks = new[]
        {
            new JsonObject { ["model"] = model, ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = new JsonObject { ["content"] = text } }) },
            new JsonObject { ["model"] = model, ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = new JsonObject(), ["finish_reason"] = "stop" }) },
            new JsonObject { ["model"] = model, ["choices"] = new JsonArray(), ["usage"] = new JsonObject { ["prompt_tokens"] = 40, ["completion_tokens"] = 8 } },
        };
        return string.Concat(chunks.Select(c => $"data: {c.ToJsonString()}\n\n")) + "data: [DONE]\n\n";
    }

    /// <summary>Installs this stub as the provider transport (live mode).</summary>
    public StubProvider Install()
    {
        AiFixture.Offline();
        LlmTransport.TestHandler = this;
        return this;
    }
}
