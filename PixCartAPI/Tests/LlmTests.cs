using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using BAL.AI;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>
/// The LLM layer (reference: app/llm/{config,router,adapters}.py and the ai-providers endpoints in
/// routers/assistant.py). Provider traffic is stubbed through <see cref="LlmTransport.TestHandler"/>, like the
/// reference tests' httpx MockTransport: no real provider is ever contacted.
/// </summary>
public class LlmTests(ApiFactory f) : ApiTest(f)
{
    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(respond(request));
    }

    private static HttpResponseMessage Sse(string events) =>
        new(HttpStatusCode.OK) { Content = new StringContent(events, Encoding.UTF8, "text/event-stream") };

    private static HttpResponseMessage Status(HttpStatusCode code, string body = "{}") =>
        new(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static string AnthropicStream(string text) => string.Concat(
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        $"data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n");

    private static string OpenAiStream(string text) => string.Concat(
        $"data: {{\"model\":\"gpt-x\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{text}\"}},\"finish_reason\":null}}]}}\n\n",
        "data: {\"model\":\"gpt-x\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"model\":\"gpt-x\",\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2}}\n\n",
        "data: [DONE]\n\n");

    private async Task<T> WithScope<T>(Func<IServiceProvider, Task<T>> work)
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        return await work(scope.ServiceProvider);
    }

    [Fact]
    public async Task Connection_lifecycle_hides_keys_and_validates()
    {
        var admin = await Admin();
        var r = await admin.Get("/api/admin/ai-providers");
        Assert.True(r.Status == 200, r.ToString());
        Assert.Empty(r.Json["connections"]!.AsArray()); // no env key and no saved Integrations key in the test host

        // a cloud provider over plain http is refused (reference: _check_url)
        var bad = await admin.Post("/api/admin/ai-providers/connections",
            new { type = "openai", base_url = "http://api.openai.com/v1", models = new[] { "gpt-x" }, add_keys = new[] { new { key = "sk-12345678x" } } });
        Assert.True(bad.Status == 400 && bad.ErrorCode == "invalid_connection", bad.ToString());

        // the cloud metadata address is refused
        bad = await admin.Post("/api/admin/ai-providers/connections",
            new { type = "openai", base_url = "https://169.254.169.254/v1", models = new[] { "gpt-x" }, add_keys = new[] { new { key = "sk-12345678x" } } });
        Assert.True(bad.Status == 400 && bad.ErrorCode == "invalid_connection", bad.ToString());

        // create
        r = await admin.Post("/api/admin/ai-providers/connections",
            new { name = "Main", type = "openai", base_url = "https://api.openai.com/v1", models = new[] { "gpt-x" }, add_keys = new[] { new { key = "sk-test-12345678abcd", label = "first" } } });
        Assert.Equal(201, r.Status);
        var conn = r.Json["connections"]!.AsArray().Single()!;
        var connId = conn["id"]!.GetValue<string>();
        Assert.Equal("Main", conn["name"]!.GetValue<string>());
        Assert.Equal("••••abcd", conn["keys"]![0]!["hint"]!.GetValue<string>());
        Assert.DoesNotContain("sk-test-12345678abcd", r.Text); // secrets never leave the server

        // edit: add a second key, rename
        r = await admin.Put($"/api/admin/ai-providers/connections/{connId}",
            new { name = "Renamed", add_keys = new[] { new { key = "sk-test-9999zzzz", label = "second" } } });
        Assert.Equal(200, r.Status);
        conn = r.Json["connections"]!.AsArray().Single()!;
        Assert.Equal("Renamed", conn["name"]!.GetValue<string>());
        Assert.Equal(2, conn["keys"]!.AsArray().Count);

        // routes
        r = await admin.Put("/api/admin/ai-providers/routes",
            new { routes = new { assistant = new[] { new { connection = connId, model = "gpt-x" } } } });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Single(r.Json["routes"]!["assistant"]!.AsArray());

        // a route pointing at a missing connection is refused
        bad = await admin.Put("/api/admin/ai-providers/routes",
            new { routes = new { assistant = new[] { new { connection = "nosuchconn", model = "gpt-x" } } } });
        Assert.True(bad.Status == 400 && bad.ErrorCode == "invalid_routes", bad.ToString());

        // the built-in connection cannot be edited here
        bad = await admin.Put($"/api/admin/ai-providers/connections/{LlmConfigBAL.BuiltinId}", new { name = "x" });
        Assert.True(bad.Status == 400 && bad.ErrorCode == "builtin_connection", bad.ToString());

        // delete
        r = await admin.Delete($"/api/admin/ai-providers/connections/{connId}");
        Assert.Equal(200, r.Status);
        Assert.Empty(r.Json["connections"]!.AsArray());
    }

    [Fact]
    public async Task Connection_test_streams_through_stubbed_transport_and_records_the_result()
    {
        var admin = await Admin();
        var r = await admin.Post("/api/admin/ai-providers/connections",
            new { name = "Claude", type = "anthropic", base_url = "https://api.anthropic.com", models = new[] { "claude-test" }, add_keys = new[] { new { key = "sk-ant-test123456" } } });
        Assert.Equal(201, r.Status);
        var connId = r.Json["connections"]![0]!["id"]!.GetValue<string>();

        var seen = new List<string?>();
        LlmTransport.TestHandler = new StubHandler(req =>
        {
            seen.Add(req.Headers.TryGetValues("x-api-key", out var v) ? v.FirstOrDefault() : null);
            return Sse(AnthropicStream("OK"));
        });
        try
        {
            r = await admin.Post($"/api/admin/ai-providers/connections/{connId}/test", new { model = "claude-test" });
            Assert.True(r.Status == 200 && r.Json["ok"]!.GetValue<bool>(), r.ToString());
            Assert.Contains("OK in", r.Json["message"]!.GetValue<string>());
            Assert.Equal(["sk-ant-test123456"], seen); // anthropic auth header reached the provider call

            // the result is recorded on the connection
            r = await admin.Get("/api/admin/ai-providers");
            Assert.True(r.Json["connections"]![0]!["last_test"]!["ok"]!.GetValue<bool>());

            // a rejected key reports ok=false with the classified message
            LlmTransport.TestHandler = new StubHandler(_ => Status(HttpStatusCode.Unauthorized));
            r = await admin.Post($"/api/admin/ai-providers/connections/{connId}/test", new { model = "claude-test" });
            Assert.True(r.Status == 200 && !r.Json["ok"]!.GetValue<bool>(), r.ToString());
            Assert.Contains("Key rejected (401)", r.Json["message"]!.GetValue<string>());
            r = await admin.Get("/api/admin/ai-providers");
            Assert.False(r.Json["connections"]![0]!["last_test"]!["ok"]!.GetValue<bool>());
        }
        finally { LlmTransport.TestHandler = null; }
    }

    [Fact]
    public async Task Router_falls_back_to_the_next_key_after_a_rate_limit()
    {
        var admin = await Admin();
        var r = await admin.Post("/api/admin/ai-providers/connections",
            new
            {
                name = "Claude", type = "anthropic", base_url = "https://api.anthropic.com", models = new[] { "claude-test" },
                add_keys = new[] { new { key = "sk-ant-first1111" }, new { key = "sk-ant-second2222" } },
            });
        Assert.Equal(201, r.Status);
        var connId = r.Json["connections"]![0]!["id"]!.GetValue<string>();
        r = await admin.Put("/api/admin/ai-providers/routes",
            new { routes = new { assistant = new[] { new { connection = connId, model = "claude-test" } } } });
        Assert.Equal(200, r.Status);

        var keys = new List<string?>();
        LlmTransport.TestHandler = new StubHandler(req =>
        {
            var key = req.Headers.TryGetValues("x-api-key", out var v) ? v.FirstOrDefault() : null;
            keys.Add(key);
            return key == "sk-ant-first1111" ? Status((HttpStatusCode)429) : Sse(AnthropicStream("hello"));
        });
        try
        {
            var (turn, used) = await WithScope(async sp =>
            {
                var router = sp.GetRequiredService<ILlmRouterBAL>();
                return await router.CompleteAsync("assistant", [new SystemBlock("Be brief.")], "hi", 64);
            });
            Assert.Equal("hello", turn.Content.OfType<JsonObject>().First(b => b["type"]!.GetValue<string>() == "text")["text"]!.GetValue<string>());
            Assert.Equal(1, used.Fallbacks); // first key rate-limited, second answered
            Assert.Equal("Claude", used.ConnectionName);
            Assert.Equal(["sk-ant-first1111", "sk-ant-second2222"], keys);

            // the rate-limited key is now cooling down: the next call goes straight to the second key
            keys.Clear();
            var (_, used2) = await WithScope(async sp =>
            {
                var router = sp.GetRequiredService<ILlmRouterBAL>();
                return await router.CompleteAsync("assistant", [new SystemBlock("Be brief.")], "hi again", 64);
            });
            Assert.Equal(0, used2.Fallbacks);
            Assert.Equal(["sk-ant-second2222"], keys);
        }
        finally { LlmTransport.TestHandler = null; }
    }

    [Fact]
    public async Task Openai_compatible_stream_yields_text_and_usage()
    {
        LlmTransport.TestHandler = new StubHandler(_ => Sse(OpenAiStream("hi there")));
        try
        {
            var conn = new LlmConnection
            {
                Id = "c1", Name = "OpenAI", Type = "openai", BaseUrl = "https://api.openai.com/v1",
                Keys = ["sk-x"], KeyIds = ["k1"], Models = ["gpt-x"],
            };
            var events = new List<LlmEvent>();
            await LlmAdapters.For(conn).StreamAsync(conn, "sk-x", "gpt-x", [new SystemBlock("sys")],
                new JsonArray(J.O(("role", "user"), ("content", "ping"))), [], 32, ev => { events.Add(ev); return Task.CompletedTask; }, CancellationToken.None);
            Assert.Equal("hi there", string.Concat(events.Where(e => e.Kind == "text").Select(e => e.Text)));
            var turn = events.Single(e => e.Kind == "turn").Turn!;
            Assert.Equal("end_turn", turn.StopReason); // finish_reason "stop" normalises to anthropic-style, as in the reference
            Assert.Equal(4, turn.InputTokens);
            Assert.Equal(2, turn.OutputTokens);
        }
        finally { LlmTransport.TestHandler = null; }
    }

    [Fact]
    public async Task Router_with_no_connections_reports_not_configured()
    {
        await Admin();
        var ex = await Assert.ThrowsAsync<Utils.AppException>(() => WithScope(sp =>
            sp.GetRequiredService<ILlmRouterBAL>().CompleteAsync("assistant", [new SystemBlock("s")], "hi", 32)));
        Assert.Equal("ai_not_configured", ex.Code);
        Assert.Equal(400, ex.StatusCode);
    }
}
