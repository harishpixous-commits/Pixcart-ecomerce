using System.Text.Json.Nodes;
using Xunit;

namespace Tests.AI;

/// <summary>
/// AI studio (reference tests/test_ai.py): sandbox and live modes, prompt caching layers, switches, budget, permissions,
/// human review, customer messages, rule-based checks, risk briefs and usage accounting.
/// </summary>
[Collection("ai")]
public class AiStudioTests(AiFixture fx) : IAsyncLifetime
{
    private const string Notes = "cotton kurta for men, blue, sizes M L XL, machine wash";
    private readonly Db db = fx.Db;

    public async Task InitializeAsync()
    {
        AiFixture.Offline();
        foreach (var k in new[] { "ai", "llm", "integrations", "site" }) await db.DeleteSetting(k);
        await db.Exec("DELETE FROM ai_runs");
    }

    public Task DisposeAsync()
    {
        AiFixture.Offline();
        return Task.CompletedTask;
    }

    private async Task<(Api Api, Guid SellerId, Guid UserId)> SellerApi(string name)
    {
        var (sid, uid) = await db.Seller(name);
        return (fx.Client(uid), sid, uid);
    }

    /// <summary>Live mode against a fake Anthropic API with the Claude key saved in Admin → Integrations.</summary>
    private async Task<(StubProvider Stub, Func<string> Reply, Action<string> SetText, Action<int> SetStatus)> Live()
    {
        await db.Setting("integrations", $"{{\"ai\": {{\"values\": {{\"api_key\": {{\"enc\": \"{fx.Encrypt("sk-test")}\"}}}}}}}}");
        var text = "";
        var status = 200;
        var usage = new JsonObject { ["input_tokens"] = 120, ["output_tokens"] = 40, ["cache_creation_input_tokens"] = 900, ["cache_read_input_tokens"] = 0 };
        var stub = new StubProvider((_, _) => status != 200 ? StubProvider.Error(status, "overloaded")
            : StubProvider.Sse(StubProvider.Anthropic([StubProvider.Text(text)], "end_turn", usage))).Install();
        return (stub, () => text, t => text = t, s => status = s);
    }

    [Fact]
    public async Task Sandbox_mode_works_without_a_key()
    {
        var (seller, _, _) = await SellerApi("AI Shop");
        var r = await seller.Post("/api/seller/ai/listing", new { notes = "short" });
        r.Is(400);
        Assert.Equal("notes_too_short", r.ErrorCode);
        r = await seller.Post("/api/seller/ai/listing", new { notes = Notes, brand = "Kovai" });
        r.Is(200);
        var outp = r.Obj;
        Assert.Equal("sandbox", (string)outp["mode"]!);
        Assert.Contains("Sandbox draft", (string)outp["description"]!);
        Assert.StartsWith("Kovai", (string)outp["title"]!);
        var done = await seller.Post($"/api/seller/ai/runs/{outp["run_id"]}/apply", new { final_text = (string)outp["title"]! });
        Assert.Equal("applied", (string)done.Obj["status"]!);
        (await seller.Post($"/api/seller/ai/runs/{outp["run_id"]}/discard", new { })).Is(404); // already closed
    }

    [Fact]
    public async Task Live_call_uses_cached_prompt_layers_and_records_usage()
    {
        var (stub, _, setText, _) = await Live();
        var admin = fx.Client(await db.Admin(), true);
        await db.Setting("site", "{\"brand_name\": \"Kadai\"}");
        var r = await admin.Put("/api/admin/ai", new
        {
            model = "claude-sonnet-5-5", brand_voice = "Cheerful and short.",
            tasks = new Dictionary<string, object> { ["listing_writer"] = new { enabled = true, instructions = "Mention the city of manufacture if given." }, ["nonsense"] = new { enabled = false } },
        });
        r.Is(200);
        Assert.False(r.Obj["settings"]!["tasks"]!.AsObject().ContainsKey("nonsense"));
        setText(new JsonObject { ["title"] = "Men's Blue Cotton Kurta", ["description"] = "A blue cotton kurta.", ["highlights"] = new JsonArray("100% cotton"),
            ["specs"] = new JsonObject { ["Fabric"] = "Cotton" }, ["missing"] = new JsonArray("Sleeve length?") }.ToJsonString());
        var (seller, _, _) = await SellerApi("Live Shop");
        var cat = await db.Category("Shirts");
        r = await seller.Post("/api/seller/ai/listing", new { notes = Notes, category_id = cat });
        r.Is(200);
        Assert.Equal("Men's Blue Cotton Kurta", (string)r.Obj["title"]!);
        Assert.Equal("live", (string)r.Obj["mode"]!);
        var call = stub.Calls[^1];
        Assert.Equal("sk-test", call.Headers["x-api-key"]);
        Assert.Equal("2023-06-01", call.Headers["anthropic-version"]);
        Assert.EndsWith("/v1/messages", call.Url);
        Assert.Equal("claude-sonnet-5-5", (string)call.Body["model"]!);
        var system = call.Body["system"]!.AsArray();
        Assert.Equal(2, system.Count);
        Assert.Equal("ephemeral", (string)system[0]!["cache_control"]!["type"]!);
        Assert.Equal("ephemeral", (string)system[1]!["cache_control"]!["type"]!);
        var rules = (string)system[0]!["text"]!;
        var brand = (string)system[1]!["text"]!;
        Assert.Contains("never invent", rules);
        Assert.Contains("Kadai", brand);
        Assert.Contains("Cheerful", brand);
        Assert.Contains("city of manufacture", brand);
        var user = (string)call.Body["messages"]![0]!["content"]!;
        Assert.Contains(Notes, user);
        Assert.DoesNotContain("Kadai", user);
        var run = (await db.Rows("SELECT input_tokens, output_tokens, cache_creation_tokens, mode, model FROM ai_runs WHERE task = 'listing_writer' ORDER BY created_at DESC LIMIT 1"))[0];
        Assert.Equal(120, (int)run.input_tokens);
        Assert.Equal(40, (int)run.output_tokens);
        Assert.Equal(900, (int)run.cache_creation_tokens);
        Assert.Equal("live", (string)run.mode);
        Assert.Equal("claude-haiku-5-5", (string)run.model);
        var studio = (await admin.Get("/api/admin/ai")).Obj;
        Assert.Equal("live", (string)studio["status"]!["mode"]!);
        Assert.True((long)studio["usage"]!["runs"]! >= 1);
        Assert.True((double)studio["usage"]!["cost_usd"]! > 0);
        var listing = studio["tasks"]!.AsArray().First(t => (string)t!["key"]! == "listing_writer")!;
        Assert.True((long)listing["runs_this_month"]! >= 1);
        Assert.StartsWith("Mention", (string)listing["instructions"]!);
    }

    [Fact]
    public async Task Switches_budget_and_failures()
    {
        var (stub, _, setText, setStatus) = await Live();
        var admin = fx.Client(await db.Admin(), true);
        var (seller, _, _) = await SellerApi("Switch Shop");
        await admin.Put("/api/admin/ai", new { enabled = false });
        Assert.Equal("ai_off", (await seller.Post("/api/seller/ai/listing", new { notes = Notes })).ErrorCode);
        await admin.Put("/api/admin/ai", new { enabled = true, tasks = new { listing_writer = new { enabled = false } } });
        Assert.Equal("ai_task_off", (await seller.Post("/api/seller/ai/listing", new { notes = Notes })).ErrorCode);
        await admin.Put("/api/admin/ai", new { enabled = true, tasks = new { }, monthly_token_budget = 100 });
        setText("{\"title\": \"T\", \"description\": \"D\", \"highlights\": [], \"specs\": {}, \"missing\": []}");
        (await seller.Post("/api/seller/ai/listing", new { notes = Notes })).Is(200); // 160 tokens used
        var r = await seller.Post("/api/seller/ai/listing", new { notes = Notes });
        r.Is(429);
        Assert.Equal("ai_budget", r.ErrorCode);
        await admin.Put("/api/admin/ai", new { monthly_token_budget = 0 });
        // provider errors are retried once, then recorded as a failed run
        setStatus(503);
        var before = stub.Calls.Count;
        r = await seller.Post("/api/seller/ai/listing", new { notes = Notes });
        r.Is(502);
        Assert.Equal(2, stub.Calls.Count - before);
        var failed = (await admin.Get("/api/admin/ai/runs?status=failed")).Obj["items"]!.AsArray();
        Assert.NotEmpty(failed);
        Assert.False(string.IsNullOrEmpty((string)failed[0]!["error"]!));
        // settings are validated
        (await admin.Put("/api/admin/ai", new { model = "gpt-4" })).Is(400);
        (await admin.Put("/api/admin/ai", new { monthly_token_budget = -5 })).Is(400);
    }

    [Fact]
    public async Task Support_reply_draft_is_reviewed_and_keeps_contact_details_private()
    {
        var (stub, _, setText, _) = await Live();
        var admin = fx.Client(await db.Admin(), true);
        var buyer = await db.User("Priya Raman");
        var (tid, _) = await db.Ticket(buyer, "Parcel late", "My parcel has not arrived. Call me on 9610000004.");
        setText("Here is a draft: Hi Priya, sorry for the delay. We are checking with the courier and will update you today.");
        var r = await admin.Post("/api/admin/ai/tasks/support_reply", new { subject_id = tid.ToString(), tone = "apologetic", intent = "apologise and say we are checking" });
        r.Is(200);
        var draft = r.Obj;
        Assert.StartsWith("Hi Priya", (string)draft["output"]!["text"]!); // preamble removed
        var prompt = (string)stub.Calls[^1].Body["messages"]![0]!["content"]!;
        Assert.Contains("Priya", prompt);
        Assert.DoesNotContain("Raman", prompt);
        Assert.Contains("apologetic", prompt);
        Assert.DoesNotContain("buyer", prompt.ToLowerInvariant());
        var applied = await admin.Post($"/api/admin/ai/runs/{draft["id"]}/apply", new { final_text = (string)draft["output"]!["text"]! + " Thanks!" });
        Assert.Equal(200, applied.Code);
        var run = (await admin.Get($"/api/admin/ai/runs/{draft["id"]}")).Obj;
        Assert.Equal("applied", (string)run["status"]!);
        Assert.EndsWith("Thanks!", (string)run["final_text"]!);
        Assert.Equal("apologetic", (string)run["inputs"]!["tone"]!);
        (await admin.Post($"/api/admin/ai/runs/{draft["id"]}/discard", new { })).Is(409);
    }

    [Fact]
    public async Task Customer_message_draft_send_and_risk_briefs()
    {
        var admin = fx.Client(await db.Admin(), true);
        var (sellerId, _) = await db.Seller("Brief Shop", approvedAt: DateTime.UtcNow.AddDays(-5));
        var product = await db.Product(sellerId, await db.Category("Kurtas"), "Handloom Cotton Shirt Blue");
        var buyer = await db.User("Arun");
        var o = await db.Order(buyer, sellerId, product);
        (await admin.Post("/api/admin/ai/tasks/customer_message", new { subject_id = o.Id.ToString(), intent = "" })).Is(400);
        var d = (await admin.Post("/api/admin/ai/tasks/customer_message", new { subject_id = o.Id.ToString(), tone = "friendly", intent = "Tell them the seller ships tomorrow" })).Obj;
        Assert.StartsWith("About your order", (string)d["output"]!["subject"]!);
        Assert.Equal("sandbox", (string)d["mode"]!);
        var r = await admin.Post($"/api/admin/ai/runs/{d["id"]}/send", new { subject = "Your order ships tomorrow", text = "Hi Arun, the seller ships your order tomorrow." });
        r.Is(200);
        Assert.Equal("sent", (string)r.Obj["status"]!);
        (await admin.Post($"/api/admin/ai/runs/{d["id"]}/send", new { subject = "Again", text = "Sending twice must fail." })).Is(409);
        var n = (await db.Rows("SELECT subject, body FROM notifications WHERE user_id = @buyer AND event = 'staff_message' AND channel = 'inapp'", new { buyer }))[0];
        Assert.Equal("Your order ships tomorrow", (string)n.subject);
        Assert.Contains("ships your order", (string)n.body);
        Assert.Equal(1L, await db.Scalar<long>("SELECT COUNT(*) FROM audit_logs WHERE action = 'ai.customer_message.sent' AND entity_id = @id", new { id = o.Id.ToString() }));
        // risk brief for the same order: first COD order from a new account
        var brief = (await admin.Get($"/api/admin/ai/briefs/order/{o.Id}")).Obj;
        Assert.Contains((string)brief["level"]!, new[] { "GREEN", "AMBER", "RED" });
        Assert.Contains(brief["factors"]!.AsArray(), f => ((string)f!["text"]!).Contains("First order"));
        var sbrief = (await admin.Get($"/api/admin/ai/briefs/seller/{sellerId}")).Obj;
        Assert.True((bool)sbrief["insufficient_history"]!);
        Assert.False(string.IsNullOrEmpty((string)sbrief["headline"]!));
        Assert.Contains(sbrief["factors"]!.AsArray(), f => ((string)f!["text"]!).Contains("Approved less than 30 days ago"));
        (await admin.Get($"/api/admin/ai/briefs/order/{Guid.NewGuid()}")).Is(404);
        (await admin.Get("/api/admin/ai/briefs/order/not-a-uuid")).Is(422);
    }

    [Fact]
    public async Task Listing_check_always_includes_rule_based_findings()
    {
        var (_, _, setText, _) = await Live();
        var admin = fx.Client(await db.Admin(), true);
        var (sellerId, _) = await db.Seller("Check Shop");
        var p = await db.Product(sellerId, await db.Category("Shirts"), "Handloom shirt", description: "Handloom shirt. WhatsApp 9876543210 for wholesale.");
        setText("{\"risk\": \"low\", \"issues\": [], \"suggested_reason\": \"\"}");
        var r = await admin.Post("/api/admin/ai/tasks/listing_check", new { subject_id = p.Id.ToString() });
        r.Is(200);
        Assert.Equal("medium", (string)r.Obj["output"]!["risk"]!);
        Assert.Contains(r.Obj["output"]!["issues"]!.AsArray(), i => ((string)i!).Contains("phone number"));
    }

    [Fact]
    public async Task Permissions_and_seller_scoping()
    {
        var marketing = fx.Client(await db.Admin("marketing"), true);
        (await marketing.Post("/api/admin/ai/tasks/support_reply", new { subject_id = "x" })).Is(403);
        (await marketing.Get("/api/admin/ai")).Is(403);
        var (a, _, _) = await SellerApi("Shop A");
        var (b, _, _) = await SellerApi("Shop B");
        (await a.Post("/api/seller/ai/tasks/support_reply", new { subject_id = "x" })).Is(404); // admin-only task
        var run = (await a.Post("/api/seller/ai/listing", new { notes = Notes })).Obj;
        (await b.Post($"/api/seller/ai/runs/{run["run_id"]}/apply", new { final_text = "mine now" })).Is(404);
        var customer = fx.Client(await db.User("Customer"));
        (await customer.Get("/api/admin/ai")).Is(403);
        (await fx.Client().Get("/api/admin/ai")).Is(401);
    }

    [Fact]
    public async Task Ai_drafts_use_the_current_roles()
    {
        // a custom role without the dashboard permission cannot draft the business brief; with it, it can
        var code = await db.Role("Brief readers");
        var staff = await db.Admin(code);
        var api = fx.Client(staff, true);
        (await api.Post("/api/admin/ai/tasks/business_brief", new { subject_id = "7" })).Is(403);
        await db.Exec("UPDATE admin_roles SET permissions = CAST('[\"dashboard\"]' AS JSON) WHERE code = @code", new { code });
        var r = await api.Post("/api/admin/ai/tasks/business_brief", new { subject_id = "7" });
        r.Is(200);
        r = await api.Post($"/api/admin/ai/runs/{r.Obj["id"]}/discard", new { });
        r.Is(200);
        Assert.Equal("discarded", (string)r.Obj["status"]!);
    }

    [Fact]
    public async Task Business_brief_uses_only_supplied_figures()
    {
        var (stub, _, setText, _) = await Live();
        var admin = fx.Client(await db.Admin(), true);
        setText("Sales were steady.\n\nNext steps:\n- Reply to tickets");
        var r = await admin.Post("/api/admin/ai/tasks/business_brief", new { subject_id = "7" });
        r.Is(200);
        var prompt = (string)stub.Calls[^1].Body["messages"]![0]!["content"]!;
        Assert.Contains("Figures for the period", prompt);
        Assert.Contains("sales:", prompt);
        Assert.Contains("last 7 days", prompt);
        Assert.Contains("use only the numbers provided", (string)stub.Calls[^1].Body["system"]![0]!["text"]!);
    }
}
