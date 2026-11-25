using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>
/// Ported from tests/test_integrations_roles.py (integrations, roles and permissions; the export tests belong to the
/// exports module) and tests/test_push.py (setup, device tokens, sending after the change, removal of dead tokens).
/// </summary>
public class IntegrationsTests(ApiFactory f) : ApiTest(f)
{
    private async Task<T> WithScope<T>(Func<IServiceProvider, Task<T>> work)
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        return await work(scope.ServiceProvider);
    }

    private Task<Model.DomainModel.Integrations.IntegrationSettings> Effective() => WithScope(sp => sp.GetRequiredService<IIntegrationBAL>().GetAsync());

    [Fact]
    public async Task Integration_save_is_encrypted_and_overrides_env()
    {
        var admin = await Admin();
        var r = await admin.Get("/api/admin/integrations");
        Assert.True(r.Status == 200, r.ToString());
        var razor = r.Json["items"]!.AsArray().First(i => i!["key"]!.GetValue<string>() == "razorpay")!;
        Assert.Equal("environment", razor["fields"]![0]!["source"]!.GetValue<string>()); // the test host sets RazorpayKeyId
        Assert.DoesNotContain("rzp_test_secret", r.Text); // secrets never leave the server

        // wrong password is refused
        var bad = await admin.Put("/api/admin/integrations/msg91", new { values = new { auth_key = new string('k', 20) }, password = "nope" });
        Assert.Equal(403, bad.Status);

        // cannot switch on with required fields missing
        r = await admin.Put("/api/admin/integrations/msg91", new { values = new { auth_key = "msgkey123456789" }, enabled = true, password = AdminPassword });
        Assert.True(r.Status == 400 && r.ErrorMessage!.Contains("OTP template ID"), r.ToString());

        r = await admin.Put("/api/admin/integrations/msg91", new { values = new { auth_key = "msgkey123456789", otp_template_id = "tmpl12345678" }, enabled = true, password = AdminPassword });
        Assert.True(r.Status == 200, r.ToString());
        var item = r.Json["item"]!;
        Assert.True(item["ready"]!.GetValue<bool>() && item["enabled"]!.GetValue<bool>());
        var keyField = item["fields"]!.AsArray().First(x => x!["key"]!.GetValue<string>() == "auth_key")!;
        Assert.Equal("••••6789", keyField["hint"]!.GetValue<string>());
        Assert.DoesNotContain("msgkey123456789", r.Text);

        var stored = JsonNode.Parse(await ApiFactory.DbScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'integrations'"))!;
        var enc = stored["msg91"]!["values"]!["auth_key"]!;
        Assert.True(enc is JsonObject o && o.ContainsKey("enc"));
        Assert.DoesNotContain("msgkey", enc.ToJsonString());

        var cfg = await Effective();
        Assert.Equal("msg91", cfg.SmsProvider);
        Assert.Equal("msgkey123456789", cfg.Msg91AuthKey);

        // switching off falls back to the console provider; appsettings untouched
        r = await admin.Put("/api/admin/integrations/msg91", new { enabled = false, password = AdminPassword });
        Assert.Equal(200, r.Status);
        Assert.Equal("console", (await Effective()).SmsProvider);

        // the audit records field names only
        var details = await ApiFactory.DbQueryAsync<string>("SELECT detail FROM audit_logs WHERE action = 'integration.update'");
        Assert.NotEmpty(details);
        Assert.DoesNotContain(details, d => d.Contains("msgkey123456789"));
    }

    [Fact]
    public async Task Integration_validation_and_checkout_switch()
    {
        var admin = await Admin();
        var r = await admin.Put("/api/admin/integrations/razorpay", new { values = new { key_id = "not-a-key" }, password = AdminPassword });
        Assert.True(r.Status == 400 && r.ErrorMessage!.Contains("rzp_test_"), r.ToString());
        Assert.Equal(200, (await admin.Put("/api/admin/integrations/razorpay", new { enabled = false, password = AdminPassword })).Status);
        // the reference reads /api/site (storefront module); the same effective setting is checked here
        var cfg = await Effective();
        Assert.False(cfg.OnlinePayments);
        Assert.True(cfg.RazorpayEnabled); // refunds still possible with the keys
        await admin.Put("/api/admin/integrations/razorpay", new { enabled = true, password = AdminPassword });
        Assert.True((await Effective()).OnlinePayments);
        Assert.Equal(404, (await admin.Put("/api/admin/integrations/nope", new { password = AdminPassword })).Status);
    }

    [Fact]
    public async Task Connection_checks_use_saved_keys()
    {
        var admin = await Admin();
        var seen = new Dictionary<string, string>();
        Fakes.IntegrationsHandler = req =>
        {
            seen["url"] = req.RequestUri!.ToString();
            seen["auth"] = req.Headers.Authorization?.ToString() ?? (req.Headers.TryGetValues("x-api-key", out var k) ? k.First() : "");
            if (req.RequestUri.AbsolutePath.EndsWith("/v1/models")) return Fakes.Json(200, new { data = new[] { new { id = "claude-haiku-5-5" } } });
            return Fakes.Json(200, new { items = Array.Empty<object>(), count = 0 });
        };
        var r = await admin.Post("/api/admin/integrations/razorpay/test", new { });
        Assert.True(r.Status == 200 && r.Json["ok"]!.GetValue<bool>(), r.ToString());
        Assert.Contains("/orders", seen["url"]);
        Assert.StartsWith("Basic ", seen["auth"]);

        await admin.Put("/api/admin/integrations/ai", new { values = new { api_key = "sk-ant-test-123456" }, enabled = true, password = AdminPassword });
        r = await admin.Post("/api/admin/integrations/ai/test", new { });
        Assert.True(r.Json["ok"]!.GetValue<bool>(), r.ToString());
        Assert.Equal("sk-ant-test-123456", seen["auth"]);
        var ai = (await admin.Get("/api/admin/integrations")).Json["items"]!.AsArray().First(i => i!["key"]!.GetValue<string>() == "ai")!;
        Assert.True(ai["last_test"]!["ok"]!.GetValue<bool>());
        Assert.Equal(200, (await admin.Put("/api/admin/integrations/ai", new { clear = new[] { "api_key" }, enabled = false, password = AdminPassword })).Status);
        Assert.Contains("integration.test", await ApiFactory.DbQueryAsync<string>("SELECT action FROM audit_logs"));
        Assert.Equal(422, (await admin.Post("/api/admin/integrations/msg91/test", new { phone = "12345" })).Status);
    }

    [Fact]
    public async Task Roles_matrix_and_escalation_guards()
    {
        var admin = await Admin();
        var perms = (await admin.Get("/api/admin/permissions")).Json["items"]!.AsArray().Select(p => p!["code"]!.GetValue<string>()).ToHashSet();
        Assert.Superset(new HashSet<string> { "integrations", "assistant", "staff" }, perms);
        var r = await admin.Post("/api/admin/roles", new { name = "Warehouse lead", description = "Ships orders", permissions = new[] { "orders", "customers" } });
        Assert.True(r.Status == 201, r.ToString());
        var code = r.Json["code"]!.GetValue<string>();
        Assert.Equal("warehouse_lead", code);
        Assert.Equal("dashboard", r.Json["permissions"]![0]!.GetValue<string>()); // always added
        Assert.Equal(409, (await admin.Post("/api/admin/roles", new { name = "warehouse lead", permissions = Array.Empty<string>() })).Status);
        Assert.Equal(409, (await admin.Put("/api/admin/roles/owner", new { name = "Owner", permissions = Array.Empty<string>() })).Status);
        Assert.Equal("unknown_permission", (await admin.Post("/api/admin/roles", new { name = "Odd", permissions = new[] { "nope" } })).ErrorCode);

        var lead = await Staff(admin, "lead@kadai.in", code, "Warehouse@2026x");
        var shopper = await LoginPhone("9600000001");
        // the reference checks /api/admin/orders and /api/admin/me (other modules); this module's endpoints are checked instead
        Assert.Equal(200, (await lead.Get($"/api/admin/customers/{shopper.Id}")).Status);
        Assert.Equal(403, (await lead.Get("/api/admin/integrations")).Status);
        Assert.Equal(code, lead.User["admin_role"]!.GetValue<string>());

        // a permission change applies at once
        await admin.Put($"/api/admin/roles/{code}", new { name = "Warehouse lead", permissions = new[] { "orders" } });
        Assert.Equal(403, (await lead.Get($"/api/admin/customers/{shopper.Id}")).Status);

        // a role in use cannot be deleted
        Assert.Equal(409, (await admin.Delete($"/api/admin/roles/{code}")).Status);

        // a non-owner with the staff permission cannot hand out permissions they lack
        await admin.Put($"/api/admin/roles/{code}", new { name = "Warehouse lead", permissions = new[] { "orders", "staff" } });
        Assert.Equal(403, (await lead.Post("/api/admin/roles", new { name = "Sneaky", permissions = new[] { "integrations" } })).Status);
        Assert.Equal(403, (await lead.Post("/api/admin/staff", new { email = "x@kadai.in", name = "Xavier", role = "owner", password = "Sneaky@2026xx" })).Status);
        Assert.Equal(403, (await lead.Put($"/api/admin/roles/{code}", new { name = "Warehouse lead", permissions = new[] { "orders", "staff", "payouts" } })).Status);

        // staff list, an empty role can be deleted, the last owner cannot be switched off
        var staff = (await admin.Get("/api/admin/staff")).Json;
        Assert.True(staff["can_manage_owners"]!.GetValue<bool>());
        Assert.Equal(2, staff["items"]!.AsArray().Count);
        var tmp = (await admin.Post("/api/admin/roles", new { name = "Temp", permissions = Array.Empty<string>() })).Json["code"]!.GetValue<string>();
        Assert.Equal(200, (await admin.Delete($"/api/admin/roles/{tmp}")).Status);
        Assert.Equal("self_lockout", (await admin.Patch($"/api/admin/staff/{admin.Id}", new { is_active = false })).ErrorCode);
    }

    [Fact]
    public async Task Webhooks_check_signature_and_token()
    {
        var b = Factory.Browser();
        var body = new StringContent("{\"event\":\"payout.processed\"}", Encoding.UTF8, "application/json");
        var r = await b.SendAsync(HttpMethod.Post, "/api/webhooks/razorpayx", body, headers: new() { ["x-razorpay-signature"] = "bad" });
        Assert.True(r.Status == 400 && r.ErrorCode == "bad_signature", r.ToString());
        r = await b.SendAsync(HttpMethod.Post, "/api/webhooks/shiprocket", new StringContent("{}", Encoding.UTF8, "application/json"), headers: new() { ["x-api-key"] = "x" });
        Assert.True(r.Status == 401 && r.ErrorCode == "bad_token", r.ToString());

        // a signed event without a payout handler is answered, recorded once and shown as the last webhook
        var admin = await Admin();
        await admin.Put("/api/admin/integrations/razorpayx", new { values = new { account_number = "1234567890", webhook_secret = "xsecret" }, password = AdminPassword });
        var raw = "{\"event\":\"account.updated\"}";
        var sig = Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes("xsecret"), Encoding.UTF8.GetBytes(raw)));
        var headers = new Dictionary<string, string> { ["x-razorpay-signature"] = sig, ["x-razorpay-event-id"] = "evt_1" };
        r = await b.SendAsync(HttpMethod.Post, "/api/webhooks/razorpayx", new StringContent(raw, Encoding.UTF8, "application/json"), headers: headers);
        Assert.True(r.Status == 200 && r.Json["ok"]!.GetValue<bool>(), r.ToString());
        r = await b.SendAsync(HttpMethod.Post, "/api/webhooks/razorpayx", new StringContent(raw, Encoding.UTF8, "application/json"), headers: headers);
        Assert.True(r.Json["duplicate"]!.GetValue<bool>(), r.ToString());
        var x = (await admin.Get("/api/admin/integrations")).Json["items"]!.AsArray().First(i => i!["key"]!.GetValue<string>() == "razorpayx")!;
        Assert.Equal(1, x["last_webhook"]!["count"]!.GetValue<int>());
    }

    // ---------------------------------------------------------------- push (tests/test_push.py)

    private static string ServiceKey()
    {
        using var rsa = RSA.Create(2048);
        return rsa.ExportPkcs8PrivateKeyPem().Replace("\n", "\\n"); // as it appears inside the JSON file
    }

    [Fact]
    public async Task Push_setup_tokens_and_push_after_the_change()
    {
        var sent = new List<JsonNode>();
        var tokensAsked = 0;
        Fakes.PushHandler = req =>
        {
            if (req.RequestUri!.AbsolutePath == "/token")
            {
                Interlocked.Increment(ref tokensAsked);
                return Fakes.Json(200, new { access_token = "ya29.test", expires_in = 3600 });
            }
            var message = JsonNode.Parse(req.Content!.ReadAsStringAsync().Result)!["message"]!;
            lock (sent) sent.Add(message);
            if (message["token"]!.GetValue<string>().StartsWith("dead"))
                return Fakes.Json(404, new { error = new { status = "NOT_FOUND", message = "Requested entity was not found." } });
            return Fakes.Json(200, new { name = "projects/demo/messages/1" });
        };

        var admin = await Admin();
        var c = Factory.Browser();
        // not set up: the browser is told push is off
        Assert.Equal("{\"enabled\":false}", (await c.Get("/api/push/config")).Text);
        var values = new
        {
            project_id = "pixcart-demo", client_email = "push@pixcart-demo.iam.gserviceaccount.com", private_key = ServiceKey(), api_key = "AIzaSyD" + new string('x', 32),
            sender_id = "123456789012", app_id = "1:123456789012:web:abc123def456", vapid_key = "B" + new string('y', 86),
        };
        var r = await admin.Put("/api/admin/integrations/firebase", new { values, enabled = true, password = AdminPassword });
        Assert.True(r.Status == 200, r.ToString());
        var check = (await admin.Post("/api/admin/integrations/firebase/test", new { })).Json;
        Assert.True(check["ok"]!.GetValue<bool>(), check.ToJsonString());
        var cfg = (await c.Get("/api/push/config")).Json;
        Assert.True(cfg["enabled"]!.GetValue<bool>());
        Assert.Equal("pixcart-demo", cfg["projectId"]!.GetValue<string>());
        Assert.DoesNotContain("private_key", cfg.ToJsonString());

        // a phone and a browser register; a notification reaches both as a push once the change is saved
        var rider = await LoginPhone("9600000901", "Push Rider");
        Assert.Equal(201, (await rider.Post("/api/push/tokens", new { token = "phone-token-" + new string('a', 30), platform = "android", app = "delivery" })).Status);
        Assert.Equal(201, (await rider.Post("/api/push/tokens", new { token = "dead-token-" + new string('b', 30), platform = "web", app = "delivery" })).Status);
        Assert.Equal(422, (await rider.Post("/api/push/tokens", new { token = "short" })).Status);
        // the reference triggers a delivery offer (fleet module); any notification on the default channels does the same
        var riderId = Guid.Parse(rider.Id);
        await WithScope(async sp =>
        {
            var db = sp.GetRequiredService<Utils.Interface.IMySqlDapperHelper>();
            var user = await sp.GetRequiredService<DAL.AccountDAL>().GetUserAsync(riderId);
            var notify = sp.GetRequiredService<INotifyBAL>();
            await using var uow = await db.BeginAsync();
            await notify.NotifyAsync("delivery_new_offer", user, new Dictionary<string, object?>
            {
                ["store"] = "Kovai Textiles", ["pickup_area"] = "RS Puram", ["drop_area"] = "Gandhipuram", ["fee"] = "₹40", ["cod"] = "", ["seconds"] = 30,
            }, "/delivery", uow: uow);
            await uow.CommitAsync();
            return 0;
        });
        for (var i = 0; i < 100 && sent.Count < 2; i++) await Task.Delay(50); // the push goes out after the change, in the background
        List<JsonNode> offers;
        lock (sent) offers = sent.Where(m => m["data"]!["event"]!.GetValue<string>() == "delivery_new_offer").ToList();
        Assert.Equal(2, offers.Count);
        Assert.Equal("New delivery request", offers[0]["notification"]!["title"]!.GetValue<string>());
        Assert.Equal("1", offers[0]["data"]!["urgent"]!.GetValue<string>());
        Assert.Equal("HIGH", offers[0]["android"]!["priority"]!.GetValue<string>());
        for (var i = 0; i < 40; i++)
        {
            if (await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM push_tokens") == 1) break;
            await Task.Delay(50);
        }
        Assert.Equal(["phone-token-" + new string('a', 30)], await ApiFactory.DbQueryAsync<string>("SELECT token FROM push_tokens")); // the dead token was removed
        Assert.Equal(1, tokensAsked); // made once for the connection test, then reused from the cache for every push

        // a rolled-back change sends nothing
        sent.Clear();
        await WithScope(async sp =>
        {
            var db = sp.GetRequiredService<Utils.Interface.IMySqlDapperHelper>();
            var user = await sp.GetRequiredService<DAL.AccountDAL>().GetUserAsync(riderId);
            await using var uow = await db.BeginAsync();
            await sp.GetRequiredService<INotifyBAL>().NotifyAsync("security_notice", user, new Dictionary<string, object?> { ["what"] = "x", ["message"] = "y" }, uow: uow);
            return 0; // no commit
        });
        await Task.Delay(500);
        Assert.Empty(sent);

        // signing out removes the device; another account on the same phone takes the token over
        await rider.Post("/api/push/tokens/remove", new { token = "phone-token-" + new string('a', 30) });
        var other = await LoginPhone("9600000903", "Other");
        await other.Post("/api/push/tokens", new { token = "phone-token-" + new string('a', 30) });
        Assert.Equal([Guid.Parse(other.Id)], await ApiFactory.DbQueryAsync<Guid>("SELECT user_id FROM push_tokens"));
    }

    [Fact]
    public async Task Firebase_check_reports_a_bad_key()
    {
        var admin = await Admin();
        Fakes.PushHandler = _ => new HttpResponseMessage(HttpStatusCode.OK);
        var values = new
        {
            project_id = "pixcart-demo", client_email = "push@pixcart-demo.iam.gserviceaccount.com", private_key = "not a key", api_key = "AIzaSyD" + new string('x', 32),
            sender_id = "123456789012", app_id = "1:123456789012:web:abc123def456", vapid_key = "B" + new string('y', 86),
        };
        Assert.Equal(200, (await admin.Put("/api/admin/integrations/firebase", new { values, enabled = true, password = AdminPassword })).Status);
        var check = (await admin.Post("/api/admin/integrations/firebase/test", new { })).Json;
        Assert.False(check["ok"]!.GetValue<bool>());
        Assert.StartsWith("The private key could not be read", check["message"]!.GetValue<string>());
    }
    [Fact]
    public async Task Push_only_transaction_dispatches_on_commit_not_scope_disposal_and_drops_rollback()
    {
        var admin = await Admin();
        var values = new { project_id = "pixcart-demo", client_email = "push@pixcart-demo.iam.gserviceaccount.com",
            private_key = ServiceKey(), api_key = "AIzaSyD" + new string('x', 32), sender_id = "123456789012",
            app_id = "1:123456789012:web:abc123def456", vapid_key = "B" + new string('y', 86) };
        Assert.Equal(200, (await admin.Put("/api/admin/integrations/firebase", new { values, enabled = true, password = AdminPassword })).Status);
        var customer = await LoginPhone("9600000991", "Push Customer");
        Assert.Equal(201, (await customer.Post("/api/push/tokens", new { token = new string('a', 30) })).Status);
        BAL.FcmClient.Reset();
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var count = 0;
        Fakes.PushHandler = req =>
        {
            if (req.RequestUri!.Host.Contains("oauth")) return Fakes.Json(200, new { access_token = "mock-token", expires_in = 3600 });
            Interlocked.Increment(ref count);
            sent.TrySetResult();
            return Fakes.Json(200, new { name = "mock-message" });
        };
        try
        {
            // Push-only channel creates no notification row. Rollback must still suppress dispatch.
            await using (var scope = Factory.Services.CreateAsyncScope())
            {
                var sp = scope.ServiceProvider;
                var user = await sp.GetRequiredService<DAL.AccountDAL>().GetUserAsync(Guid.Parse(customer.Id));
                await using var uow = await sp.GetRequiredService<Utils.Interface.IMySqlDapperHelper>().BeginAsync();
                await sp.GetRequiredService<INotifyBAL>().NotifyAsync("security_notice", user,
                    new Dictionary<string, object?> { ["what"] = "test", ["message"] = "synthetic" }, channels: ["push"], uow: uow);
            }
            await Task.Delay(300);
            Assert.Equal(0, Volatile.Read(ref count));
            // Keep the scope alive after commit: dispatch must not wait for disposal.
            await using (var scope = Factory.Services.CreateAsyncScope())
            {
                var sp = scope.ServiceProvider;
                var user = await sp.GetRequiredService<DAL.AccountDAL>().GetUserAsync(Guid.Parse(customer.Id));
                await using var uow = await sp.GetRequiredService<Utils.Interface.IMySqlDapperHelper>().BeginAsync();
                await sp.GetRequiredService<INotifyBAL>().NotifyAsync("security_notice", user,
                    new Dictionary<string, object?> { ["what"] = "test", ["message"] = "synthetic" }, channels: ["push"], uow: uow);
                Assert.Equal(0, Volatile.Read(ref count));
                await uow.CommitAsync();
                await sent.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.Equal(1, Volatile.Read(ref count));
            }
            await Task.Delay(100);
            Assert.Equal(1, Volatile.Read(ref count));
        }
        finally { Fakes.PushHandler = null; BAL.FcmClient.Reset(); }
    }

    [Fact]
    public async Task Device_registration_keeps_ten_newest_and_rate_limits()
    {
        var customer = await LoginPhone("9600000992", "Many Devices");
        for (var i = 0; i < 11; i++)
        {
            Assert.Equal(201, (await customer.Post("/api/push/tokens", new { token = $"device-{i:D2}-" + new string('x', 25) })).Status);
            if (i == 0) await ApiFactory.DbExecAsync("UPDATE push_tokens SET last_seen_at='2020-01-01' WHERE user_id=@id", new { id = customer.Id });
        }
        var tokens = (await ApiFactory.DbQueryAsync<string>("SELECT token FROM push_tokens WHERE user_id=@id", new { id = customer.Id })).ToList();
        Assert.Equal(10, tokens.Count);
        Assert.DoesNotContain("device-00-" + new string('x', 25), tokens);
        for (var i = 11; i < 30; i++)
            Assert.Equal(201, (await customer.Post("/api/push/tokens", new { token = $"device-{i:D2}-" + new string('x', 25) })).Status);
        Assert.Equal(429, (await customer.Post("/api/push/tokens", new { token = "one-too-many-" + new string('x', 25) })).Status);
    }

    [Theory]
    [InlineData(200, "", "sent")]
    [InlineData(404, "", "gone")]
    [InlineData(410, "", "gone")]
    [InlineData(400, "Invalid REGISTRATION TOKEN", "gone")]
    [InlineData(400, "other invalid request", "error")]
    [InlineData(503, "unavailable", "error")]
    public async Task Fcm_payload_and_status_mapping_are_reference_compatible(int status, string body, string expected)
    {
        using var rsa = RSA.Create(2048);
        var cfg = new Model.DomainModel.Integrations.IntegrationSettings
        {
            FirebaseProjectId = "synthetic", FirebaseClientEmail = "test@synthetic.invalid", FirebasePrivateKey = rsa.ExportPkcs8PrivateKeyPem(),
            FirebaseOauthUrl = "https://oauth.invalid/token", FirebaseFcmBase = "https://fcm.invalid",
        };
        BAL.FcmClient.Reset();
        var oauthCalls = 0;
        JsonNode? captured = null;
        using var client = new HttpClient(new FakeHandler(req =>
        {
            if (req.RequestUri!.Host == "oauth.invalid")
            {
                oauthCalls++;
                return Fakes.Json(200, new { access_token = "synthetic-token", expires_in = 3600 });
            }
            Assert.Equal("Bearer synthetic-token", req.Headers.Authorization!.ToString());
            captured = JsonNode.Parse(req.Content!.ReadAsStringAsync().Result)!["message"];
            return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body) };
        }));
        try
        {
            var result = await BAL.FcmClient.SendOneAsync(client, cfg, "https://shop.invalid", "synthetic-device",
                new string('t', 121), new string('b', 401), "/delivery", new Dictionary<string, string> { ["urgent"] = "1" });
            Assert.Equal(expected, result);
            Assert.Equal(120, captured!["notification"]!["title"]!.GetValue<string>().Length);
            Assert.Equal(400, captured["notification"]!["body"]!.GetValue<string>().Length);
            Assert.Equal("https://shop.invalid/delivery", captured["webpush"]!["fcm_options"]!["link"]!.GetValue<string>());
            Assert.True(captured["webpush"]!["notification"]!["requireInteraction"]!.GetValue<bool>());
            Assert.Equal("deliveries", captured["android"]!["notification"]!["channel_id"]!.GetValue<string>());
            await BAL.FcmClient.AccessTokenAsync(client, cfg);
            Assert.Equal(1, oauthCalls);
            cfg.FirebaseClientEmail = "other@synthetic.invalid";
            await BAL.FcmClient.AccessTokenAsync(client, cfg);
            Assert.Equal(2, oauthCalls);
        }
        finally { BAL.FcmClient.Reset(); }
    }

}
