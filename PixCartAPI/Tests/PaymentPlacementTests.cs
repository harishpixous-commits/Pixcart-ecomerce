using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace Tests;

/// <summary>Several gateways at checkout (mirror of tests/test_payment_placement.py): failover and events, pay another way,
/// the return and webhook of a second gateway, the admin routing API. Gateways are in-memory fakes: no network.</summary>
public class PaymentPlacementTests(ApiFactory f) : ApiTest(f)
{
    private sealed class FakeGateways
    {
        public readonly Dictionary<string, JsonNode> Orders = [];
        public readonly HashSet<string> Paid = [];
        public bool CashfreeDown; private int _n;
        public HttpResponseMessage Handle(HttpRequestMessage r)
        {
            var path = r.RequestUri!.AbsolutePath; var host = r.RequestUri.Host;
            HttpResponseMessage Ok(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
            if (host.Contains("cashfree"))
            {
                if (CashfreeDown) return new(HttpStatusCode.InternalServerError) { Content = new StringContent("{\"message\":\"cashfree is down\"}", Encoding.UTF8, "application/json") };
                if (r.Method == HttpMethod.Post && path.EndsWith("/orders")) { var b = JsonNode.Parse(r.Content!.ReadAsStringAsync().Result)!; var id = b["order_id"]!.GetValue<string>(); Orders[id] = b; return Ok($"{{\"order_id\":\"{id}\",\"payment_session_id\":\"sess_{id}\"}}"); }
                if (path.EndsWith("/payments")) { var oid = path.Split('/')[^2]; return Ok(Paid.Contains(oid) ? $"[{{\"cf_payment_id\":901,\"payment_status\":\"SUCCESS\",\"payment_group\":\"upi\",\"payment_amount\":{Orders[oid]["order_amount"]}}}]" : "[]"); }
            }
            if (host.Contains("stripe") && r.Method == HttpMethod.Post && path.EndsWith("/checkout/sessions")) return Ok($"{{\"id\":\"cs_{++_n}\",\"url\":\"https://stripe/pay\"}}");
            return new(HttpStatusCode.NotFound) { Content = new StringContent("{\"message\":\"unhandled\"}", Encoding.UTF8, "application/json") };
        }
    }

    private readonly FakeGateways _fake = new();

    private HttpClient Server()
    {
        var app = Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddHttpClient(PaymentGatewayBAL.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new FakeHandler(_fake.Handle))));
        return app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
    }

    private static async Task<(int Status, JsonNode? Json)> Call(HttpClient c, HttpMethod m, string url, Api? as_ = null, string body = "{}")
    {
        using var req = new HttpRequestMessage(m, url) { Content = m == HttpMethod.Get ? null : new StringContent(body, Encoding.UTF8, "application/json") };
        if (as_ is not null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", as_.Token);
        req.Headers.Add("X-Requested-With", "pixcart");
        var r = await c.SendAsync(req); var text = await r.Content.ReadAsStringAsync();
        return ((int)r.StatusCode, text.StartsWith('{') || text.StartsWith('[') ? JsonNode.Parse(text) : null);
    }

    private async Task EnableAsync(Api admin, string key, object values)
    {
        var r = await admin.Put($"/api/admin/integrations/{key}", new { values, enabled = true, password = AdminPassword });
        Assert.True(r.Status == 200, r.ToString());
    }

    private async Task<(Api Buyer, Guid OrderId)> OnlineOrder(string phone, long amount = 10000)
    {
        var buyer = await LoginPhone(phone, "Gateway Shopper");
        var oid = Guid.NewGuid();
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var dal = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
        await using var tx = await db.BeginAsync();
        await dal.InsertOrderAsync(new()
        {
            Id = oid, Number = "PCG" + phone[^6..], UserId = Guid.Parse(buyer.Id), Status = "pending_payment", PaymentMethod = "online", PaymentStatus = "pending",
            ShipTo = "{}", ItemsTotal = amount, GrandTotal = amount, Currency = "INR", FxRate = 1, Fees = "[]", IdempotencyKey = Guid.NewGuid().ToString(),
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, PaymentExpiresAt = DateTime.UtcNow.AddMinutes(30),
        }, tx);
        await tx.ExecuteAsync("INSERT INTO payments(id,order_id,provider,provider_order_id,amount_paise,currency,status,method,error,created_at) VALUES(@pid,@oid,'razorpay',@rzp,@amount,'INR','created','','',UTC_TIMESTAMP())",
            new { pid = Guid.NewGuid(), oid, rzp = "order_g" + phone, amount });
        await tx.CommitAsync();
        return (buyer, oid);
    }

    private static Task<string> OrderState(Guid oid) => ApiFactory.DbScalarAsync<string>("SELECT CONCAT(status, '/', payment_status) FROM orders WHERE id = @oid", new { oid });

    [Fact]
    public async Task Pay_another_way_then_return_and_webhook_mark_it_paid()
    {
        var admin = await Admin();
        await EnableAsync(admin, "cashfree", new { client_id = "TEST1234abcd", client_secret = "cf_secret" });
        using var c = Server();
        var (buyer, oid) = await OnlineOrder("9770000004");
        var sw = await Call(c, HttpMethod.Post, $"/api/orders/{oid}/payment/switch", buyer);
        Assert.Equal(200, sw.Status);
        var pay = sw.Json!["payment"]!;
        Assert.Equal("cashfree", pay["provider"]!.GetValue<string>()); Assert.Equal("modal", pay["mode"]!.GetValue<string>()); Assert.StartsWith("sess_", pay["payment_session_id"]!.GetValue<string>());
        Assert.Equal("razorpay", pay["alternatives"]![0]!["provider"]!.GetValue<string>());
        var reference = _fake.Orders.Keys.Single();

        var back = await c.GetAsync($"/api/payments/cashfree/callback?order_id={reference}");
        Assert.Equal(HttpStatusCode.SeeOther, back.StatusCode); Assert.DoesNotContain("payment=success", back.Headers.Location!.OriginalString);
        Assert.Equal("pending_payment/pending", await OrderState(oid));

        _fake.Paid.Add(reference);
        var bodyText = $"{{\"data\":{{\"order\":{{\"order_id\":\"{reference}\"}}}}}}"; var body = Encoding.UTF8.GetBytes(bodyText);
        HttpRequestMessage Hook(string sig) { var m = new HttpRequestMessage(HttpMethod.Post, "/api/payments/cashfree/webhook") { Content = new ByteArrayContent(body) }; m.Headers.Add("x-webhook-timestamp", "1"); m.Headers.Add("x-webhook-signature", sig); return m; }
        Assert.Equal(HttpStatusCode.BadRequest, (await c.SendAsync(Hook("nope"))).StatusCode);
        var sig = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes("cf_secret"), Encoding.UTF8.GetBytes("1" + bodyText)));
        var ok = await c.SendAsync(Hook(sig));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("placed/paid", await OrderState(oid));
        var dup = JsonNode.Parse(await (await c.SendAsync(Hook(sig))).Content.ReadAsStringAsync())!;
        Assert.True(dup["duplicate"]!.GetValue<bool>());

        back = await c.GetAsync($"/api/payments/cashfree/callback?order_id={reference}");
        Assert.Contains("payment=success", back.Headers.Location!.OriginalString);
        Assert.Equal(409, (await Call(c, HttpMethod.Post, $"/api/orders/{oid}/payment/switch", buyer)).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await c.PostAsync("/api/payments/unknown/webhook", new StringContent("{}"))).StatusCode);
    }

    [Fact]
    public async Task Failover_uses_the_next_gateway_and_records_events_even_when_everything_fails()
    {
        var admin = await Admin();
        await EnableAsync(admin, "cashfree", new { client_id = "TEST1234abcd", client_secret = "cf_secret" });
        await EnableAsync(admin, "stripe", new { secret_key = "sk_test_abc123", webhook_secret = "whsec_x" });
        using var c = Server();
        var (buyer, oid) = await OnlineOrder("9770000007");
        var off = await Call(c, HttpMethod.Put, "/api/admin/payments/routing", admin, "{\"order\":[\"cashfree\",\"stripe\",\"razorpay\"]}");
        Assert.Equal(200, off.Status);
        _fake.CashfreeDown = true;
        var sw = await Call(c, HttpMethod.Post, $"/api/orders/{oid}/payment/switch", buyer, "{\"provider\":\"stripe\"}");
        Assert.Equal(200, sw.Status); Assert.Equal("stripe", sw.Json!["payment"]!["provider"]!.GetValue<string>()); Assert.Equal("redirect", sw.Json["payment"]!["mode"]!.GetValue<string>());
        // the next stage without a preferred gateway: the first one (cashfree) is down, so the next in order takes it
        using var scope = Factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddHttpClient(PaymentGatewayBAL.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new FakeHandler(_fake.Handle)))).Services.CreateScope();
        var gateways = scope.ServiceProvider.GetRequiredService<IPaymentGatewayBAL>();
        var dal = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        await using (var tx = await db.BeginAsync())
        {
            var order = (await dal.GetOrderAsync(oid, tx))!;
            var made = await gateways.StartAsync(order, new UserModel { Id = Guid.Parse(buyer.Id), Name = "Gateway Shopper" }, 10000, null, "INR", tx);
            Assert.Equal("stripe", made.Provider);
            await tx.CommitAsync();
        }
        var health = (await Call(c, HttpMethod.Get, "/api/admin/payments/gateways", admin)).Json!["gateways"]!.AsArray().ToDictionary(g => g!["code"]!.GetValue<string>(), g => g!);
        Assert.Equal(1, health["cashfree"]["attempts"]!.GetValue<int>()); Assert.Equal(0, health["cashfree"]["ok"]!.GetValue<int>()); Assert.Contains("down", health["cashfree"]["last_error"]!.GetValue<string>());
        Assert.Equal(2, health["stripe"]["ok"]!.GetValue<int>());
        // failover off: only the first eligible gateway is tried, and it is down
        await Call(c, HttpMethod.Put, "/api/admin/payments/routing", admin, "{\"failover\":false}");
        var failed = await Call(c, HttpMethod.Post, $"/api/orders/{oid}/payment/switch", buyer);
        Assert.Equal(502, failed.Status); Assert.Equal("gateway_error", failed.Json!["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task Routing_settings_and_admin_test()
    {
        var admin = await Admin();
        using var c = Server();
        var ok = await Call(c, HttpMethod.Put, "/api/admin/payments/routing", admin, "{\"order\":[\"stripe\",\"razorpay\"],\"strategy\":\"success_rate\"}");
        Assert.Equal(200, ok.Status); Assert.Equal("stripe", ok.Json!["routing"]!["order"]![0]!.GetValue<string>());
        var bad = await Call(c, HttpMethod.Put, "/api/admin/payments/routing", admin, "{\"timeout_seconds\":1}");
        Assert.Equal("invalid_setting", bad.Json!["error"]!["code"]!.GetValue<string>());
        Assert.Equal(404, (await Call(c, HttpMethod.Post, "/api/admin/payments/gateways/nope/test", admin)).Status);
        var t = await Call(c, HttpMethod.Post, "/api/admin/payments/gateways/stripe/test", admin);
        Assert.Equal(200, t.Status); Assert.False(t.Json!["ok"]!.GetValue<bool>());
        Assert.Equal(403, (await Call(c, HttpMethod.Get, "/api/admin/payments/gateways", await LoginPhone("9770000008"))).Status);
        var audit = await admin.Get("/api/admin/audit");
        Assert.Contains("payments.routing", audit.Text);
    }
}
