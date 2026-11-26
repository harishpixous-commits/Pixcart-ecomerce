using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL;
using BAL.AI;
using BAL.Interface;
using ClosedXML.Excel;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace Tests;

/// <summary>
/// Admin AI assistant (reference: tests/test_assistant.py, the same seven scenarios): sandbox answers, live tool use on
/// any provider with key/provider fallback, file analysis and comparison, confirm-before-run actions, downloads,
/// memory and permission limits, and the Laya decision server's rules. Providers and the Laya server are stubbed
/// through <see cref="LlmTransport.TestHandler"/> and <see cref="LlmTransport.LayaTestHandler"/>: no network, no real keys.
/// </summary>
public class AssistantTests(ApiFactory f) : ApiTest(f)
{
    private const string Pw = AdminPassword;

    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request);
    }

    /// <summary>One recorded provider request: url, parsed body and headers (names in lower case, as httpx shows them).</summary>
    private sealed record Call(string Url, JsonObject Body, Dictionary<string, string> Headers);

    private static async Task<Call> Record(HttpRequestMessage req)
    {
        var body = req.Content is null ? "{}" : await req.Content.ReadAsStringAsync();
        var headers = req.Headers.Concat(req.Content?.Headers ?? Enumerable.Empty<KeyValuePair<string, IEnumerable<string>>>())
            .ToDictionary(h => h.Key.ToLowerInvariant(), h => string.Join(",", h.Value));
        return new Call(req.RequestUri!.ToString(), (JsonObject)JsonNode.Parse(body)!, headers);
    }

    private static HttpResponseMessage Text(int status, string text, string type = "text/event-stream") =>
        new((HttpStatusCode)status) { Content = new StringContent(text, Encoding.UTF8, type) };

    private static string Dumps(JsonNode? n) => n?.ToJsonString(J.Relaxed) ?? "null";

    /// <summary>conftest's events(r): every "data:" line parsed.</summary>
    private static List<JsonObject> Events(Res r) => r.Text.Split('\n')
        .Where(l => l.StartsWith("data:", StringComparison.Ordinal))
        .Select(l => (JsonObject)JsonNode.Parse(l[5..])!).ToList();

    private static string Type(JsonObject e) => e["type"]!.GetValue<string>();

    private static async Task<string> NewChat(Api api, object? context = null)
    {
        var r = await api.Post("/api/admin/assistant/conversations", new { context = context ?? new { } });
        Assert.True(r.Status == 201, r.ToString());
        return r.Json["id"]!.GetValue<string>();
    }

    private static async Task<List<JsonObject>> Ask(Api api, string conv, string text, bool voice = false)
    {
        var r = await api.Post($"/api/admin/assistant/conversations/{conv}/messages", new { text, voice });
        Assert.True(r.Status == 200, r.ToString());
        return Events(r);
    }

    // ------------------------------------------------------------------ data (reference: test_phase2_money.setup + place_cod_order)

    private static DateTime Now => DateTimeFunctions.UtcNow();

    /// <summary>The conftest categories, a live listing of an approved Tamil Nadu seller ("Handloom Cotton Shirt Blue",
    /// ₹1,000, MRP ₹2,000, 10 in stock), then Meena orders two by cash on delivery through the real checkout.</summary>
    private async Task<(JsonObject Order, Guid VariantId)> PlaceCodOrder()
    {
        var fashion = Guid.NewGuid();
        var shirts = Guid.NewGuid();
        foreach (var (id, parent, name, slug) in new[] { (fashion, (Guid?)null, "Fashion", "fashion"), (shirts, (Guid?)fashion, "Men's Shirts", "mens-shirts") })
            await ApiFactory.DbExecAsync(
                "INSERT INTO categories (id, parent_id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active, required_details, " +
                "return_window_days, min_return_window_days, created_at, updated_at) VALUES (@id, @parent, @name, @slug, '', @commission, 500, 0, 1, CAST('[]' AS JSON), 7, 0, @now, @now)",
                new { id, parent, name, slug, commission = parent is null ? 1000 : 1200, now = Now });

        var ownerId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO users (id, phone, email, name, is_admin, is_active, admin_role, totp_enabled, marketing_opt_in, ui_prefs, created_at, updated_at) " +
            "VALUES (@id, '9400000001', NULL, 'Kovai Textiles Owner', 0, 1, '', 0, 0, CAST('{}' AS JSON), @now, @now)", new { id = ownerId, now = Now });
        var sellerId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, gstin, pan_last4, contact_email, contact_phone, " +
            "pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, grievance_email, " +
            "grievance_phone, rejection_reason, submitted_at, approved_at, razorpay_account_id, dispatch_days, dispatch_cutoff, holiday_mode, created_at, updated_at) " +
            "VALUES (@id, @ownerId, 'approved', 'Kovai Textiles', 'kovai-textiles', 'Quality goods', 'Kovai Textiles Traders', 'proprietorship', @gstin, '234K', 'kovai@example.com', " +
            "'9400000001', '12 Market Road', '', 'Coimbatore', '33', '641001', 'Kovai Textiles Traders', '9012', 'HDFC0001234', 'Ravi Kumar', 'grievance@example.com', " +
            "'9400000001', '', @now, @now, '', 2, '', 0, @now, @now)",
            new { id = sellerId, ownerId, gstin = ValidGstin("33", "KOVAI1234K"), now = Now });
        var warehouseId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO warehouses (id, seller_id, code, name, line1, line2, city, state_code, pincode, contact_name, contact_phone, gstin, is_default, is_active, " +
            "shiprocket_pickup_name, created_at, updated_at) VALUES (@warehouseId, @sellerId, 'MAIN', 'Main warehouse', '12 Market Road', '', 'Coimbatore', '33', '641001', 'Ravi', " +
            "'9400000001', '', 1, 1, '', @now, @now)", new { warehouseId, sellerId, now = Now });
        var productId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, hsn_code, gst_bps, country_of_origin, " +
            "return_window_days, status, rejection_reason, submitted_at, approved_at, price_from, mrp_from, in_stock, rating_avg, rating_count, sold_count, details, " +
            "created_at, updated_at) VALUES (@productId, @sellerId, @shirts, 'Handloom Cotton Shirt Blue', 'handloom-cotton-shirt-blue', 'Kovai', " +
            "'A well made handloom shirt with great materials and finish.', CAST('[\"Handloom\"]' AS JSON), CAST('{\"Material\": \"Cotton\"}' AS JSON), '6205', 500, " +
            "'India', 7, 'approved', '', @now, @now, 0, 0, 0, 0, 0, 0, CAST('{}' AS JSON), @now, @now)",
            new { productId, sellerId, shirts, now = Now });
        var variantId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, net_qty, is_active, created_at, updated_at) " +
            "VALUES (@variantId, @productId, @sellerId, 'HL-1', CAST('{}' AS JSON), 200000, 100000, 10, 500, NULL, 1, @now, @now)",
            new { variantId, productId, sellerId, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO inventory_levels (variant_id, warehouse_id, quantity, updated_at) VALUES (@variantId, @warehouseId, 10, @now)",
            new { variantId, warehouseId, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO product_images (id, product_id, url, position) VALUES (@id, @productId, '/media/products/shirt.webp', 0)",
            new { id = Guid.NewGuid(), productId });
        await using (var scope = Factory.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<ICatalogBAL>().RefreshProductAggregatesAsync(productId);

        var buyer = await LoginPhone("9620000001", "Meena");
        var addr = await AddAddress(buyer, state: "33");
        var r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 2 });
        Assert.True(r.Status is 200 or 201, r.ToString());
        r = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(r.Status == 201, r.ToString());
        return ((JsonObject)r.Json["order"]!, variantId);
    }

    private static string Inr(long paise) =>
        "₹" + (paise / 100m).ToString("#,##0.00", System.Globalization.CultureInfo.InvariantCulture); // f"{x:,.2f}" (Indian grouping only above a lakh)

    // ------------------------------------------------------------------ 1. decision rules

    [Fact]
    public void Decision_rules_understand_languages_and_periods()
    {
        var names = new HashSet<string> { "business_overview", "sales_breakdown", "work_queue", "find_orders", "order_details", "stock_alerts", "find_products", "open_page", "remember", "prepare_export" };
        foreach (var (text, period) in new[] { ("How much did we sell today?", "today"), ("நேற்று விற்பனை எவ்வளவு?", "yesterday"), ("pichle hafte ki bikri", "last_week") })
        {
            var d = AssistantDecision.Plan(AssistantDecision.Rules(text), minConfidence: 0.55, prefetch: true, available: names);
            Assert.True(d.Period == period && d.DomainList.Contains("sales"), text);
            Assert.True(d.Prefetch.Count > 0 && d.Prefetch[0].Name == "business_overview", text);
            Assert.True(d.Tools is not null && d.Tools.Contains("business_overview") && !d.Tools.Contains("find_products"), text);
        }
        var unsure = AssistantDecision.Plan(AssistantDecision.Rules("asdf qwerty"), minConfidence: 0.55, prefetch: true, available: names);
        Assert.Null(unsure.Tools); // unsure → every tool is offered
    }

    // ------------------------------------------------------------------ 2. sandbox

    [Fact]
    public async Task Sandbox_answers_with_exact_cards()
    {
        var admin = await Admin();
        var (o, _) = await PlaceCodOrder();
        var st = (await admin.Get("/api/admin/assistant/status")).Json;
        Assert.True(st["mode"]!.GetValue<string>() == "sandbox" && st["can"]!["actions"]!.GetValue<bool>() && st["can"]!["files"]!.GetValue<bool>(), st.ToJsonString());
        var conv = await NewChat(admin, new { path = "/admin/orders", title = "Orders" });
        var ev = await Ask(admin, conv, "How much did we sell today?");
        var kinds = ev.Select(Type).ToList();
        Assert.True(kinds[0] == "start" && kinds.Contains("decision") && kinds[^1] == "done", string.Join(",", kinds));
        var card = ev.First(e => Type(e) == "card")["card"]!;
        Assert.True(card["type"]!.GetValue<string>() == "metrics" && card["title"]!.GetValue<string>().StartsWith("Today"), card.ToJsonString());
        var sales = card["items"]!.AsArray().First(i => i!["label"]!.GetValue<string>() == "Sales")!;
        Assert.Equal(Inr(o["grand_total"]!.GetValue<long>()), sales["value"]!.GetValue<string>()); // exact, Indian format for small values
        Assert.Contains("Sandbox mode", ev[^1]["message"]!["text"]!.GetValue<string>());

        ev = await Ask(admin, conv, "export last 7 days orders as pdf");
        var file = ev.First(e => Type(e) == "card" && e["card"]!["type"]!.GetValue<string>() == "file")["card"]!;
        Assert.True(file["format"]!.GetValue<string>() == "pdf" && file["path"]!.GetValue<string>().StartsWith("/api/admin/exports/orders.pdf?"), file.ToJsonString());
        var dl = await admin.B.SendAsync(HttpMethod.Get, file["path"]!.GetValue<string>(), null, admin.Token);
        Assert.True(dl.Status == 200 && dl.Text.StartsWith("%PDF"), dl.Status.ToString());

        var detail = (await admin.Get($"/api/admin/assistant/conversations/{conv}")).Json;
        Assert.True(detail["messages"]!.AsArray().Count == 4 && detail["title"]!.GetValue<string>().StartsWith("How much"), detail.ToJsonString());
        var mid = detail["messages"]![1]!["id"]!.GetValue<string>();
        using var http = Factory.CreateClient();
        async Task<byte[]> Bytes(string path)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, path);
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", admin.Token);
            using var res = await http.SendAsync(req);
            Assert.True(res.StatusCode == HttpStatusCode.OK, path);
            return await res.Content.ReadAsByteArrayAsync();
        }
        foreach (var (fmt, magic) in new[] { ("pdf", "%PDF"u8.ToArray()), ("xlsx", "PK"u8.ToArray()), ("csv", new byte[] { 0xef, 0xbb, 0xbf }), ("md", "# "u8.ToArray()), ("json", "{"u8.ToArray()) })
            Assert.True((await Bytes($"/api/admin/assistant/messages/{mid}/download.{fmt}")).Take(magic.Length).SequenceEqual(magic), fmt);
        using var wb = new XLWorkbook(new MemoryStream(await Bytes($"/api/admin/assistant/messages/{mid}/download.xlsx")));
        Assert.Contains("Answer", wb.Worksheets.Select(w => w.Name));
        var md = await admin.Get($"/api/admin/assistant/conversations/{conv}/download.md");
        Assert.Contains("How much did we sell today?", md.Text);
    }

    // ------------------------------------------------------------------ 3. files

    [Fact]
    public async Task File_upload_query_and_compare()
    {
        var admin = await Admin();
        var (o, _) = await PlaceCodOrder();
        var number = o["number"]!.GetValue<string>();
        var total = o["grand_total"]!.GetValue<long>();
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var csv = $"Order,Amount,Status\n{number},{(total / 100m).ToString("0.00", inv)},placed\nPC0000000X,10.00,placed\n{number},1.00,placed\n";
        var form = new MultipartFormDataContent { { new ByteArrayContent(Encoding.UTF8.GetBytes(csv)), "file", "orders.csv" } };
        var r = await admin.Post("/api/admin/assistant/uploads", form);
        Assert.True(r.Status == 201, r.ToString());
        Assert.True(r.Json["rows"]!.GetValue<int>() == 3 && r.Json["columns"]![1]!["type"]!.GetValue<string>() == "number", r.ToString());
        var upId = r.Json["id"]!.GetValue<string>();

        await using (var scope = Factory.Services.CreateAsyncScope())
        {
            var sp = scope.ServiceProvider;
            var db = sp.GetRequiredService<IMySqlDapperHelper>();
            var user = (await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE email = 'admin@pixcart.in'"))!;
            var tools = sp.GetRequiredService<AssistantToolsBAL>();
            var ctx = new AssistantToolsBAL.AssistantToolContext(user.Id, ["assistant_files", "orders"], Guid.NewGuid(), false, [upId]);
            // reference: uploads.compare(entity="orders") — through the file_compare tool, which returns the same data
            var (outc, err) = await tools.ExecuteAsync(ctx, "file_compare", new JsonObject { ["entity"] = "orders" });
            Assert.False(err, outc.Data.ToJsonString());
            var res = outc.Data;
            Assert.True(res["matched"]!.GetValue<int>() == 2 && res["not_found_in_live"]!.GetValue<int>() == 1 && res["rows_with_differences"]!.GetValue<int>() == 1, res.ToJsonString());
            Assert.Equal(number.ToUpperInvariant(), res["duplicate_keys_in_file"]!.AsArray().Single()!.GetValue<string>());
            Assert.Equal("metrics", outc.Cards[0]["type"]!.GetValue<string>());
            // reference: uploads.query(metric="sum", value_column="Amount")
            var (q, qerr) = await tools.ExecuteAsync(ctx, "file_query", new JsonObject { ["metric"] = "sum", ["value_column"] = "Amount" });
            Assert.False(qerr, q.Data.ToJsonString());
            Assert.Equal((total / 100m + 11).ToString("0.00", inv), q.Data["value"]!.GetValue<string>());
        }
        var bad = await admin.Post("/api/admin/assistant/uploads",
            new MultipartFormDataContent { { new ByteArrayContent("MZ"u8.ToArray()), "file", "x.exe" } });
        Assert.Equal(400, bad.Status);
    }

    // ------------------------------------------------------------------ 4. live mode

    /// <summary>The reference's anthropic_events: a streamed Messages API answer with text and tool_use blocks.</summary>
    private static string AnthropicEvents(JsonObject[] blocks, string stop)
    {
        var evs = new List<JsonObject> { new() { ["type"] = "message_start", ["message"] = new JsonObject { ["model"] = "claude-haiku-5-5", ["usage"] = new JsonObject { ["input_tokens"] = 50 } } } };
        for (var i = 0; i < blocks.Length; i++)
        {
            var b = blocks[i];
            if (b["type"]!.GetValue<string>() == "text")
            {
                evs.Add(new() { ["type"] = "content_block_start", ["index"] = i, ["content_block"] = new JsonObject { ["type"] = "text", ["text"] = "" } });
                evs.Add(new() { ["type"] = "content_block_delta", ["index"] = i, ["delta"] = new JsonObject { ["type"] = "text_delta", ["text"] = b["text"]!.DeepClone() } });
            }
            else
            {
                evs.Add(new() { ["type"] = "content_block_start", ["index"] = i, ["content_block"] = new JsonObject { ["type"] = "tool_use", ["id"] = b["id"]!.DeepClone(), ["name"] = b["name"]!.DeepClone(), ["input"] = new JsonObject() } });
                evs.Add(new() { ["type"] = "content_block_delta", ["index"] = i, ["delta"] = new JsonObject { ["type"] = "input_json_delta", ["partial_json"] = b["input"]!.ToJsonString() } });
            }
            evs.Add(new() { ["type"] = "content_block_stop", ["index"] = i });
        }
        evs.Add(new() { ["type"] = "message_delta", ["delta"] = new JsonObject { ["stop_reason"] = stop }, ["usage"] = new JsonObject { ["output_tokens"] = 20 } });
        evs.Add(new() { ["type"] = "message_stop" });
        return string.Concat(evs.Select(e => $"data: {e.ToJsonString()}\n\n"));
    }

    /// <summary>The reference's openai_events: a streamed Chat Completions answer (Gemini's OpenAI-compatible endpoint).</summary>
    private static string OpenAiEvents(string text)
    {
        var chunks = new[]
        {
            new JsonObject { ["model"] = "gemini-x", ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = new JsonObject { ["content"] = text } }) },
            new JsonObject { ["model"] = "gemini-x", ["choices"] = new JsonArray(new JsonObject { ["index"] = 0, ["delta"] = new JsonObject(), ["finish_reason"] = "stop" }) },
            new JsonObject { ["model"] = "gemini-x", ["choices"] = new JsonArray(), ["usage"] = new JsonObject { ["prompt_tokens"] = 40, ["completion_tokens"] = 8 } },
        };
        return string.Concat(chunks.Select(c => $"data: {c.ToJsonString()}\n\n")) + "data: [DONE]\n\n";
    }

    private static void Live(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler)
    {
        LlmTransport.TestHandler = new StubHandler(handler);
        LlmRouterBAL.RetryDelay = TimeSpan.Zero;
        LlmRouterBAL.ClearCooldowns();
    }

    [Fact]
    public async Task Live_agent_tool_loop_and_provider_fallback()
    {
        var admin = await Admin();
        var (o, _) = await PlaceCodOrder();
        var number = o["number"]!.GetValue<string>();
        var calls = new List<Call>();
        try
        {
            Live(async req =>
            {
                var call = await Record(req);
                lock (calls) calls.Add(call);
                if (call.Url.Contains("anthropic"))
                {
                    if (call.Headers.GetValueOrDefault("x-api-key") == "sk-ant-bad")
                        return Text(429, "{\"error\": {\"message\": \"rate limited\"}}", "application/json");
                    var last = call.Body["messages"]!.AsArray()[^1]!;
                    var hasResult = last["content"] is JsonArray content && content.OfType<JsonObject>()
                        .Any(b => b["type"]?.GetValue<string>() == "tool_result" && !b["tool_use_id"]!.GetValue<string>().StartsWith("prefetch"));
                    if (!hasResult)
                        return Text(200, AnthropicEvents([
                            new JsonObject { ["type"] = "text", ["text"] = "Checking. " },
                            new JsonObject { ["type"] = "tool_use", ["id"] = "tu_1", ["name"] = "find_orders", ["input"] = new JsonObject { ["period"] = "today", ["status"] = "placed" } },
                        ], "tool_use"));
                    return Text(200, AnthropicEvents([new JsonObject { ["type"] = "text", ["text"] = "You have **1** placed package today." }], "end_turn"));
                }
                return Text(200, OpenAiEvents("Fallback answer from Gemini."));
            });
            var r = await admin.Post("/api/admin/ai-providers/connections", new
            {
                type = "anthropic", name = "Claude main", models = new[] { "claude-haiku-5-5" },
                add_keys = new[] { new { key = "sk-ant-bad", label = "old" }, new { key = "sk-ant-good", label = "new" } },
            });
            Assert.True(r.Status == 201, r.ToString());
            var claude = r.Json["connections"]!.AsArray().First(c => c!["name"]!.GetValue<string>() == "Claude main")!;
            Assert.All(claude["keys"]!.AsArray(), k => Assert.DoesNotContain("sk-ant", k!["hint"]!.GetValue<string>()));
            r = await admin.Post("/api/admin/ai-providers/connections", new { type = "gemini", name = "Gemini", models = new[] { "gemini-x" }, add_keys = new[] { new { key = "g-key-123456" } } });
            var gem = r.Json["connections"]!.AsArray().First(c => c!["name"]!.GetValue<string>() == "Gemini")!;
            r = await admin.Put("/api/admin/ai-providers/routes", new
            {
                routes = new
                {
                    assistant = new[]
                    {
                        new { connection = claude["id"]!.GetValue<string>(), model = "claude-haiku-5-5" },
                        new { connection = gem["id"]!.GetValue<string>(), model = "gemini-x" },
                    },
                },
            });
            Assert.True(r.Status == 200, r.ToString());
            Assert.Equal("live", (await admin.Get("/api/admin/assistant/status")).Json["mode"]!.GetValue<string>());

            var conv = await NewChat(admin);
            var ev = await Ask(admin, conv, "list today's placed packages");
            Assert.True(Type(ev[^1]) == "done", Dumps(new JsonArray(ev.Select(e => (JsonNode)e.DeepClone()).ToArray())));
            var text = string.Concat(ev.Where(e => Type(e) == "text").Select(e => e["delta"]!.GetValue<string>()));
            Assert.True(text.Contains('1') && text.Contains("Checking"), text);
            var table = ev.First(e => Type(e) == "card" && e["card"]!["type"]!.GetValue<string>() == "table")["card"]!;
            Assert.Equal(number, table["rows"]![0]![1]!.GetValue<string>());
            // first key was rate limited, second key answered; the tool result went back to the model
            Assert.Equal(["sk-ant-bad", "sk-ant-good"], calls.Take(2).Select(c => c.Headers.GetValueOrDefault("x-api-key")).ToArray());
            var toolResult = calls[^1].Body["messages"]!.AsArray()[^1]!["content"]![0]!;
            Assert.True(toolResult["type"]!.GetValue<string>() == "tool_result" && toolResult["content"]!.GetValue<string>().Contains(number), toolResult.ToJsonString());
            var system = calls[^1].Body["system"]!.AsArray();
            Assert.True(JsonNode.DeepEquals(system[0]!["cache_control"], new JsonObject { ["type"] = "ephemeral" })
                        && system[2]!["text"]!.GetValue<string>().Contains("IST") && system[2]!["cache_control"] is null, system.ToJsonString());
            Assert.Contains("find_orders", calls[^1].Body["tools"]!.AsArray().Select(t => t!["name"]!.GetValue<string>()));

            // follow-up keeps memory of the earlier turn
            await Ask(admin, conv, "and how many yesterday?");
            var hist = calls[^1].Body["messages"]!.AsArray();
            Assert.True(hist[0]!["role"]!.GetValue<string>() == "user" && Dumps(hist[0]).Contains("today's placed packages"), Dumps(hist[0]));

            // Claude fails completely → the Gemini (OpenAI-compatible) fallback answers
            Live(async req =>
            {
                var call = await Record(req);
                lock (calls) calls.Add(call);
                if (call.Url.Contains("anthropic"))
                    return Text(500, "{\"error\": {\"message\": \"down\"}}", "application/json");
                return Text(200, OpenAiEvents("Fallback answer from Gemini."));
            });
            ev = await Ask(admin, conv, "hello there");
            Assert.True(Type(ev[^1]) == "done" && string.Concat(ev.Where(e => Type(e) == "text").Select(e => e["delta"]!.GetValue<string>())).Contains("Gemini"),
                Dumps(new JsonArray(ev.Select(e => (JsonNode)e.DeepClone()).ToArray())));
            var gemCall = calls[^1];
            Assert.True(gemCall.Url.EndsWith("/chat/completions") && gemCall.Headers["authorization"] == "Bearer g-key-123456", gemCall.Url);
            var roles = gemCall.Body["messages"]!.AsArray().Select(m => m!["role"]!.GetValue<string>()).ToList();
            Assert.True(roles[0] == "system" && roles.Contains("tool"), string.Join(",", roles)); // history converted, tool results included
            var usage = (await admin.Get("/api/admin/ai/runs?task=assistant")).Json;
            Assert.True(usage["items"]!.AsArray().Count > 0 && usage["items"]![0]!["task"]!.GetValue<string>() == "assistant", usage.ToJsonString());

            // connection test reports each key
            r = await admin.Post($"/api/admin/ai-providers/connections/{gem["id"]!.GetValue<string>()}/test", new { });
            Assert.True(r.Json["ok"]!.GetValue<bool>(), r.ToString());
        }
        finally
        {
            LlmTransport.TestHandler = null;
            LlmRouterBAL.ClearCooldowns();
        }
    }

    // ------------------------------------------------------------------ 5. actions

    [Fact]
    public async Task Actions_need_confirmation_and_permission()
    {
        var admin = await Admin();
        var (o, _) = await PlaceCodOrder();
        var detail = (await admin.Get($"/api/admin/orders/{o["id"]!.GetValue<string>()}")).Json;
        var package = (detail["sub_orders"] ?? detail["packages"])![0]!["number"]!.GetValue<string>();
        var conv = await NewChat(admin);
        string aid;
        await using (var scope = Factory.Services.CreateAsyncScope())
        {
            var sp = scope.ServiceProvider;
            var user = (await sp.GetRequiredService<IMySqlDapperHelper>().QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE email = 'admin@pixcart.in'"))!;
            var perms = await sp.GetRequiredService<IAccessBAL>().PermissionsForAsync(user);
            var actions = sp.GetRequiredService<AssistantActionsBAL>();
            var act = await actions.PrepareAsync(user.Id, perms, Guid.Parse(conv), "cancel_package", new JsonObject { ["package"] = package, ["reason"] = "Customer asked by phone" });
            aid = act.Id.ToString();
            await Assert.ThrowsAsync<AssistantActionException>(() =>
                actions.PrepareAsync(user.Id, perms, Guid.Parse(conv), "update_setting", new JsonObject { ["key"] = "nope", ["value"] = 1 }));
        }
        var r = await admin.Post($"/api/admin/assistant/actions/{aid}/confirm", new { });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal("done", r.Json["status"]!.GetValue<string>());
        Assert.Equal(409, (await admin.Post($"/api/admin/assistant/actions/{aid}/confirm", new { })).Status);
        Assert.Contains("assistant.action.cancel_package", (await admin.Get("/api/admin/audit")).Text);

        // a role without assistant_actions cannot confirm; a role without assistant cannot chat
        r = await admin.Post("/api/admin/roles", new { name = "Readers", permissions = new[] { "assistant", "orders" } });
        Assert.True(r.Status is 200 or 201, r.ToString());
        r = await admin.Post("/api/admin/staff", new { email = "reader@kadai.in", name = "Reader", role = "readers", password = "Readers@2026xx" });
        Assert.True(r.Status == 201, r.ToString());
        var b = Factory.Browser();
        var login = await b.Post("/api/auth/login", new { email = "reader@kadai.in", password = "Readers@2026xx" });
        b.Cookies.Clear();
        var reader = new Api(b, login.Json["access_token"]!.GetValue<string>(), login.Json["user"]!);
        var st = (await reader.Get("/api/admin/assistant/status")).Json;
        var tools = st["tools"]!.AsArray().Select(t => t!.GetValue<string>()).ToList();
        Assert.True(!st["can"]!["actions"]!.GetValue<bool>() && !tools.Contains("propose_action") && !tools.Contains("payouts_report") && tools.Contains("find_orders"), st.ToJsonString());
        Assert.Equal(403, (await reader.Post($"/api/admin/assistant/actions/{aid}/confirm")).Status);
        var c2 = (await reader.Post("/api/admin/assistant/conversations", new { })).Json["id"]!.GetValue<string>();
        Assert.Equal(404, (await reader.Get($"/api/admin/assistant/conversations/{conv}")).Status); // private to its owner
        r = await reader.Post($"/api/admin/assistant/conversations/{c2}/messages", new { text = "hi", voice = true });
        Assert.Equal(403, r.Status); // no assistant_voice
    }

    // ------------------------------------------------------------------ 6 and 7. settings, memory, Laya

    /// <summary>The Laya server is unreachable; returns the requests the decision layer tried to send.</summary>
    private static List<HttpRequestMessage> LayaDown()
    {
        var seen = new List<HttpRequestMessage>();
        LlmTransport.LayaTestHandler = new StubHandler(req =>
        {
            lock (seen) seen.Add(req);
            throw new HttpRequestException("down");
        });
        return seen;
    }

    private static JsonObject With(JsonNode cfg, params (string Key, object? Value)[] extra)
    {
        var o = (JsonObject)cfg.DeepClone();
        foreach (var (k, v) in extra) o[k] = J.Node(v);
        return o;
    }

    [Fact]
    public async Task Settings_memory_and_decision_test()
    {
        var admin = await Admin();
        LayaDown();
        try
        {
            var cfg = (JsonObject)(await admin.Get("/api/admin/assistant/settings")).Json["settings"]!.DeepClone();
            cfg["decision"]!["provider"] = "laya";
            Assert.Equal(400, (await admin.Put("/api/admin/assistant/settings", cfg)).Status); // needs an address
            cfg["decision"]!["laya_url"] = "https://laya.example.com";
            cfg["decision"]!["laya_key"] = "secret-token-1";
            cfg["voice"]!["languages"] = new JsonArray("ta-IN", "en-IN", "xx-YY");
            var r = await admin.Put("/api/admin/assistant/settings", With(cfg, ("password", Pw)));
            Assert.True(r.Status == 200, r.ToString());
            var saved = r.Json["settings"]!;
            Assert.True(saved["decision"]!["laya_key"]!.GetValue<string>() == "" && saved["decision"]!["laya_key_set"]!.GetValue<bool>()
                        && saved["voice"]!["languages"]!.AsArray().Select(l => l!.GetValue<string>()).SequenceEqual(["ta-IN", "en-IN"]), saved.ToJsonString());
            // Laya is down → the built-in rules answer
            var d = (await admin.Post("/api/admin/assistant/decision-test", new { text = "இன்னைக்கு sales evlo" })).Json;
            Assert.True(d["source"]!.GetValue<string>() == "rules" && d["period"]!.GetValue<string>() == "today", d.ToJsonString());
            r = await admin.Put("/api/admin/assistant/memory", new { notes = new[] { "Reply in Tamil", " " } });
            Assert.Equal(["Reply in Tamil"], r.Json["notes"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray());
        }
        finally { LlmTransport.LayaTestHandler = null; }
    }

    [Fact]
    public async Task Laya_server_is_public_https_and_moving_it_needs_the_password()
    {
        var admin = await Admin();
        var seen = LayaDown();
        try
        {
            var cfg = (JsonObject)(await admin.Get("/api/admin/assistant/settings")).Json["settings"]!.DeepClone();
            cfg["decision"]!["provider"] = "laya";
            cfg["decision"]!["laya_key"] = "secret-token-1";
            foreach (var bad in new[] { "http://laya.example.com", "https://laya:8000", "https://169.254.169.254", "https://10.0.0.5:8000", "https://127.1",
                                        "https://localhost", "https://metadata.google.internal", "https://user@laya.example.com" })
            {
                cfg["decision"]!["laya_url"] = bad;
                var rb = await admin.Put("/api/admin/assistant/settings", With(cfg, ("password", Pw)));
                Assert.True(rb.Status == 400 && rb.ErrorCode == "invalid_assistant_settings", bad + " " + rb);
            }

            cfg["decision"]!["laya_url"] = "https://laya.example.com";
            var r = await admin.Put("/api/admin/assistant/settings", cfg);
            Assert.True(r.Status == 403 && r.ErrorCode == "wrong_password", r.ToString());
            r = await admin.Put("/api/admin/assistant/settings", With(cfg, ("password", Pw)));
            Assert.True(r.Status == 200, r.ToString());
            var saved = r.Json["settings"]!;
            Assert.True(saved["decision"]!["laya_key_set"]!.GetValue<bool>());
            await admin.Post("/api/admin/assistant/decision-test", new { text = "sales today" });
            Assert.True(seen[^1].RequestUri!.ToString() == "https://laya.example.com/predict"
                        && seen[^1].Headers.Authorization?.ToString() == "Bearer secret-token-1", seen[^1].RequestUri!.ToString());

            // other changes need no password and keep the token
            saved["voice"]!["rate"] = 1.2;
            r = await admin.Put("/api/admin/assistant/settings", saved);
            Assert.True(r.Status == 200 && r.Json["settings"]!["decision"]!["laya_key_set"]!.GetValue<bool>(), r.ToString());

            // a new address or path without a new token drops the saved one, so it never reaches another server
            saved = r.Json["settings"]!;
            saved["decision"]!["laya_path"] = "/v2/predict";
            r = await admin.Put("/api/admin/assistant/settings", With(saved, ("password", Pw)));
            Assert.True(r.Status == 200 && !r.Json["settings"]!["decision"]!["laya_key_set"]!.GetValue<bool>(), r.ToString());
            await admin.Post("/api/admin/assistant/decision-test", new { text = "sales today" });
            Assert.True(seen[^1].RequestUri!.ToString() == "https://laya.example.com/v2/predict" && seen[^1].Headers.Authorization is null, seen[^1].RequestUri!.ToString());

            // with two-step sign-in on, the authenticator code is needed too
            var secret = (await admin.Post("/api/auth/totp/setup")).Json["secret"]!.GetValue<string>();
            Assert.Equal(200, (await admin.Post("/api/auth/totp/enable", new { code = TotpHelper.Current(secret) })).Status);
            saved = r.Json["settings"]!;
            saved["decision"]!["laya_url"] = "https://laya.example.net";
            saved["decision"]!["laya_key"] = "secret-token-2";
            r = await admin.Put("/api/admin/assistant/settings", With(saved, ("password", Pw)));
            Assert.True(r.Status == 403 && r.ErrorCode == "totp_required", r.ToString());
            r = await admin.Put("/api/admin/assistant/settings", With(saved, ("password", Pw), ("totp", TotpHelper.Current(secret))));
            Assert.True(r.Status == 200 && r.Json["settings"]!["decision"]!["laya_key_set"]!.GetValue<bool>(), r.ToString());
            Assert.Contains("laya_server=changed", (await admin.Get("/api/admin/audit?action=assistant.settings")).Text);

            // the settings permission alone cannot move the Laya server
            var code = (await admin.Post("/api/admin/roles", new { name = "Settings desk", permissions = new[] { "settings" } })).Json["code"]!.GetValue<string>();
            Assert.Equal(201, (await admin.Post("/api/admin/staff", new { email = "desk@kadai.in", name = "Desk", role = code, password = "Settings@2026x" })).Status);
            var b = Factory.Browser();
            var login = await b.Post("/api/auth/login", new { email = "desk@kadai.in", password = "Settings@2026x" });
            b.Cookies.Clear();
            var desk = new Api(b, login.Json["access_token"]!.GetValue<string>(), login.Json["user"]!);
            var mine = (JsonObject)(await desk.Get("/api/admin/assistant/settings")).Json["settings"]!.DeepClone();
            mine["decision"]!["laya_url"] = "https://collector.example.org";
            r = await desk.Put("/api/admin/assistant/settings", With(mine, ("password", "Settings@2026x")));
            Assert.True(r.Status == 403 && (r.ErrorMessage ?? "").Contains("AI providers"), r.ToString());
            mine["decision"]!["laya_url"] = "https://laya.example.net";
            mine["name"] = "Helper";
            r = await desk.Put("/api/admin/assistant/settings", mine);
            Assert.True(r.Status == 200 && r.Json["settings"]!["decision"]!["laya_key_set"]!.GetValue<bool>(), r.ToString());
        }
        finally { LlmTransport.LayaTestHandler = null; }
    }

    // ------------------------------------------------------------------ live-mode details beyond the reference file

    [Fact]
    public void Generated_tool_specs_match_the_registry()
    {
        Assert.Equal(25, AssistantTools.Specs.Count);
        Assert.Equal(AssistantTools.All.Select(t => t.Name), AssistantTools.Specs.Select(s => s["name"]!.GetValue<string>()));
        foreach (var t in AssistantTools.All)
        {
            var spec = AssistantTools.Spec(t.Name);
            Assert.Equal(t.Description, spec["description"]!.GetValue<string>());
            Assert.Equal("object", spec["input_schema"]!["type"]!.GetValue<string>());
            Assert.NotNull(spec["input_schema"]!["properties"]);
            Assert.NotNull(spec["input_schema"]!["required"]);
        }
    }

    [Fact]
    public void Context_prompt_text_is_exact()
    {
        var text = AssistantPrompts.Context("Asha", "Owner", ["orders", "assistant", "dashboard"],
            new JsonObject { ["path"] = "/admin/orders", ["title"] = "Orders", ["filters"] = "status=placed" }, ["Reply in Tamil"], true,
            new JsonObject { ["intent"] = "data_question", ["areas"] = new JsonArray("sales", "orders"), ["period"] = null }, new JsonArray(), "Person: hi",
            new DateTime(2026, 11, 17, 9, 5, 0, DateTimeKind.Utc));
        Assert.Equal(string.Join("\n",
            "Now: Tuesday, 17 November 2026, 02:35 PM IST.",
            "You are helping Asha (role: Owner). Their permissions: assistant, dashboard, orders.",
            "They opened you from the page Orders (/admin/orders) with filters status=placed. 'This', 'these' or 'here' may refer to it.",
            "Things they asked you to remember:\n1. Reply in Tamil",
            "Earlier in this chat (condensed):\nPerson: hi",
            "Quick reading of the latest message (may be wrong): intent data_question, areas ['sales', 'orders'], period None.",
            "VOICE MODE: your reply is spoken aloud. Answer in 1–3 short, natural sentences that sound good when heard. Say amounts the way people speak " +
            "(\"one lakh twenty thousand rupees\" style is fine), no markdown, no bullet lists, no tables, no URLs. The cards still appear on screen, so you can say " +
            "\"details are on screen\"."), text);
    }

    [Fact]
    public async Task Live_mode_stops_at_the_step_limit_and_records_usage()
    {
        var admin = await Admin();
        var calls = 0;
        try
        {
            Live(_ =>
            {
                Interlocked.Increment(ref calls);
                return Task.FromResult(Text(200, AnthropicEvents([
                    new JsonObject { ["type"] = "tool_use", ["id"] = $"tu_{Guid.NewGuid():N}", ["name"] = "work_queue", ["input"] = new JsonObject() },
                ], "tool_use")));
            });
            var r = await admin.Post("/api/admin/ai-providers/connections", new { type = "anthropic", name = "Claude", models = new[] { "claude-haiku-5-5" }, add_keys = new[] { new { key = "sk-ant-test1234" } } });
            var connId = r.Json["connections"]![0]!["id"]!.GetValue<string>();
            await admin.Put("/api/admin/ai-providers/routes", new { routes = new { assistant = new[] { new { connection = connId, model = "claude-haiku-5-5" } } } });
            var settings = (JsonObject)(await admin.Get("/api/admin/assistant/settings")).Json["settings"]!.DeepClone();
            settings["max_steps"] = 2;
            Assert.Equal(200, (await admin.Put("/api/admin/assistant/settings", settings)).Status);
            var conv = await NewChat(admin);
            var ev = await Ask(admin, conv, "asdf qwerty");
            Assert.Equal("done", Type(ev[^1]));
            Assert.Equal(2, calls);
            Assert.Contains("(I reached the step limit for one question. Ask me to continue.)", ev[^1]["message"]!["text"]!.GetValue<string>());
            Assert.Equal("claude-haiku-5-5 via Claude", ev[^1]["model"]!.GetValue<string>());
            Assert.Equal(100, ev[^1]["usage"]!["input_tokens"]!.GetValue<long>());
            var run = (await ApiFactory.DbQueryAsync<(string Status, string Mode, int In, int Out, string Inputs)>(
                "SELECT status, mode, input_tokens, output_tokens, CAST(inputs AS CHAR) FROM ai_runs WHERE task = 'assistant'")).Single();
            Assert.Equal(("applied", "live", 100, 40), (run.Status, run.Mode, run.In, run.Out));
            Assert.Contains("asdf qwerty", run.Inputs);

            // the monthly budget is used up → an error event, no model call
            r = await admin.Put("/api/admin/ai", new { monthly_token_budget = 100 });
            Assert.True(r.Status == 200, r.ToString());
            var before = calls;
            ev = await Ask(admin, conv, "asdf qwerty");
            Assert.Equal("ai_budget", ev.Last(e => Type(e) == "error")["code"]!.GetValue<string>());
            Assert.Equal(before, calls);
        }
        finally
        {
            LlmTransport.TestHandler = null;
            LlmRouterBAL.ClearCooldowns();
        }
    }
}
