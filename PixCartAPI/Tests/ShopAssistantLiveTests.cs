using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using BAL.AI;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>
/// Live mode of the shop assistant (reference: shop_assistant/agent.py run + choose_mode). The provider is stubbed
/// through <see cref="LlmTransport.TestHandler"/>; the fallback to guided mode needs no provider at all.
/// </summary>
public class ShopAssistantLiveTests(ApiFactory f) : ApiTest(f)
{
    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            respond(request);
    }

    private static HttpResponseMessage Sse(string events) =>
        new(HttpStatusCode.OK) { Content = new StringContent(events, Encoding.UTF8, "text/event-stream") };

    private static string TextStream(string text) => string.Concat(
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":7,\"output_tokens\":1}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        $"data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n");

    private static string ToolStream(string toolId, string name, string inputJson) => string.Concat(
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n",
        $"data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"{toolId}\",\"name\":\"{name}\",\"input\":{{}}}}}}\n\n",
        $"data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":{System.Text.Json.JsonSerializer.Serialize(inputJson)}}}}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":6}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n");

    private async Task<T> WithScope<T>(Func<IServiceProvider, Task<T>> work)
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        return await work(scope.ServiceProvider);
    }

    private async Task<(Api Admin, Api Customer, string ChatId)> LiveChat()
    {
        var admin = await Admin();
        var r = await admin.Post("/api/admin/ai-providers/connections",
            new { name = "Claude", type = "anthropic", base_url = "https://api.anthropic.com", models = new[] { "claude-test" }, add_keys = new[] { new { key = "sk-ant-live12345" } } });
        Assert.Equal(201, r.Status);
        var connId = r.Json["connections"]![0]!["id"]!.GetValue<string>();
        r = await admin.Put("/api/admin/ai-providers/routes",
            new { routes = new { shop_assistant = new[] { new { connection = connId, model = "claude-test" } } } });
        Assert.Equal(200, r.Status);
        var customer = await LoginPhone("9800000123", "Meena");
        var s = await customer.Post("/api/shop-assistant/sessions", new { page = new { path = "/", title = "" } });
        Assert.Equal(201, s.Status);
        return (admin, customer, s.Json["id"]!.GetValue<string>());
    }

    private static List<JsonObject> Events(string sseBody) => sseBody.Split("\n\n", StringSplitOptions.RemoveEmptyEntries)
        .Select(l => l.TrimStart("data: ".ToCharArray())).Where(l => l.StartsWith('{'))
        .Select(l => (JsonObject)JsonNode.Parse(l)!).ToList();

    [Fact]
    public async Task Live_mode_answers_with_the_model_and_records_only_tokens()
    {
        var (_, customer, chatId) = await LiveChat();
        LlmTransport.TestHandler = new StubHandler(req => Task.FromResult(Sse(TextStream("Your order is on the way."))));
        try
        {
            var r = await customer.B.Post($"/api/shop-assistant/sessions/{chatId}/messages", new { text = "where is my order" }, customer.Token);
            Assert.Equal(200, r.Status);
            var events = Events(r.Text);
            var start = events.First(e => e["type"]!.GetValue<string>() == "start");
            Assert.Equal("live", start["mode"]!.GetValue<string>());
            Assert.Equal("track", start["intent"]!.GetValue<string>());
            Assert.Contains(events, e => e["type"]!.GetValue<string>() == "tool" && e["name"]!.GetValue<string>() == "my_orders"); // prefetch
            var done = events.Last(e => e["type"]!.GetValue<string>() == "done");
            Assert.Equal("live", done["mode"]!.GetValue<string>());
            Assert.Equal("Your order is on the way.", done["message"]!["text"]!.GetValue<string>());

            // token accounting only: one ai_runs row, no chat text in it (reference: agent._save)
            var run = await WithScope(async sp =>
            {
                var ai = sp.GetRequiredService<DAL.AiDAL>();
                var (items, total) = await ai.RunsPageAsync("shop_assistant", null, 1);
                Assert.Equal(1, total);
                return items.Single();
            });
            Assert.Equal("live", run.Mode);
            Assert.True(run.InputTokens > 0 && run.OutputTokens > 0);
            Assert.DoesNotContain("where is my order", run.Output + run.FinalText);
        }
        finally { LlmTransport.TestHandler = null; }
    }

    [Fact]
    public async Task Live_mode_runs_tools_and_streams_their_cards()
    {
        var (_, customer, chatId) = await LiveChat();
        var calls = 0;
        LlmTransport.TestHandler = new StubHandler(req =>
        {
            calls++;
            return Task.FromResult(calls == 1 ? Sse(ToolStream("tu_1", "help_articles", "{\"query\": \"delivery\"}")) : Sse(TextStream("Here are some shoes.")));
        });
        try
        {
            var r = await customer.B.Post($"/api/shop-assistant/sessions/{chatId}/messages", new { text = "show me shoes" }, customer.Token);
            Assert.Equal(200, r.Status);
            var events = Events(r.Text);
            Assert.Contains(events, e => e["type"]!.GetValue<string>() == "tool" && e["name"]!.GetValue<string>() == "help_articles");
            var done = events.Last(e => e["type"]!.GetValue<string>() == "done");
            Assert.Equal("live", done["mode"]!.GetValue<string>());
            Assert.Equal("Here are some shoes.", done["message"]!["text"]!.GetValue<string>());
            Assert.Contains(done["message"]!["blocks"]!.AsArray().OfType<JsonObject>(), b => b["type"]!.GetValue<string>() == "article");
            Assert.Equal(2, calls); // tool answer went back to the model for the final text
        }
        finally { LlmTransport.TestHandler = null; }
    }

    [Fact]
    public async Task Live_failure_before_any_text_falls_back_to_guided()
    {
        var (_, customer, chatId) = await LiveChat();
        LlmTransport.TestHandler = new StubHandler(_ =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
            { Content = new StringContent("{\"error\":\"boom\"}", Encoding.UTF8, "application/json") }));
        try
        {
            var r = await customer.B.Post($"/api/shop-assistant/sessions/{chatId}/messages", new { text = "where is my order" }, customer.Token);
            Assert.Equal(200, r.Status);
            var events = Events(r.Text);
            var done = events.Last(e => e["type"]!.GetValue<string>() == "done");
            Assert.Equal("guided", done["mode"]!.GetValue<string>()); // the customer still gets an answer
            Assert.True(done["message"]!["text"]!.GetValue<string>().Length > 0);

            // no live ai_runs row: the reply was guided
            var total = await WithScope(async sp =>
            {
                var (_, t) = await sp.GetRequiredService<DAL.AiDAL>().RunsPageAsync("shop_assistant", null, 1);
                return t;
            });
            Assert.Equal(0, total);
        }
        finally { LlmTransport.TestHandler = null; }
    }

    [Fact]
    public async Task Monthly_budget_used_up_switches_to_guided()
    {
        var (admin, customer, chatId) = await LiveChat();
        LlmTransport.TestHandler = new StubHandler(_ => Task.FromResult(Sse(TextStream("Live answer."))));
        try
        {
            var r = await customer.B.Post($"/api/shop-assistant/sessions/{chatId}/messages", new { text = "hello" }, customer.Token);
            Assert.Equal(200, r.Status);
            Assert.Equal("live", Events(r.Text).First(e => e["type"]!.GetValue<string>() == "start")["mode"]!.GetValue<string>());
        }
        finally { LlmTransport.TestHandler = null; }

        // a budget smaller than what was just used: the next message is guided without any provider call
        var put = await admin.Put("/api/admin/shop-assistant/settings", new JsonObject { ["monthly_token_budget"] = 1 });
        Assert.Equal(200, put.Status);
        LlmTransport.TestHandler = new StubHandler(_ => throw new InvalidOperationException("provider must not be called"));
        try
        {
            var r = await customer.B.Post($"/api/shop-assistant/sessions/{chatId}/messages", new { text = "hello again" }, customer.Token);
            Assert.Equal(200, r.Status);
            var events = Events(r.Text);
            Assert.Equal("guided", events.First(e => e["type"]!.GetValue<string>() == "start")["mode"]!.GetValue<string>());
        }
        finally { LlmTransport.TestHandler = null; }
    }
}
