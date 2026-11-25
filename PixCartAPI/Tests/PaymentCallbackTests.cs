using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL;
using DAL;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Utils;
using Utils.Interface;

namespace Tests;

/// <summary>
/// Ported from tests/test_payment_check.py (the return from Razorpay / a UPI app to the callback URL). Razorpay is an
/// in-memory fake behind RazorpayBAL.TransportFactory on a loopback address: no network.
/// </summary>
public class PaymentCallbackTests(ApiFactory f) : ApiTest(f), IDisposable
{
    private const string Secret = "rzp_test_secret";

    /// <summary>Razorpay's payments and order-payments APIs, in memory (reference: the tests' gateway fixture).</summary>
    private sealed class Gateway : HttpMessageHandler
    {
        public readonly Dictionary<string, JsonObject> Payments = [];
        public bool FailNext;
        private int _n;

        public (string Id, string Signature) Pay(string orderId, long amount)
        {
            var id = $"pay_T{++_n:D4}";
            Payments[id] = new JsonObject { ["id"] = id, ["order_id"] = orderId, ["amount"] = amount, ["status"] = "captured", ["method"] = "upi", ["created_at"] = _n };
            return (id, Sign(orderId, id));
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (FailNext)
            {
                FailNext = false;
                throw new HttpRequestException("timeout");
            }
            var path = request.RequestUri!.AbsolutePath;
            JsonNode? body = null;
            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries); // v1, payments|orders, ...
            if (parts is [_, "payments", var pid] && Payments.TryGetValue(pid, out var p)) body = p.DeepClone();
            else if (parts is [_, "payments", var cpid, "capture"] && Payments.TryGetValue(cpid, out var cp))
            {
                cp["status"] = "captured";
                body = cp.DeepClone();
            }
            else if (parts is [_, "orders", var oid, "payments"])
                body = new JsonObject { ["items"] = new JsonArray(Payments.Values.Where(x => x["order_id"]!.GetValue<string>() == oid).Select(x => (JsonNode?)x.DeepClone()).ToArray()) };
            var status = body is null ? HttpStatusCode.NotFound : HttpStatusCode.OK;
            body ??= new JsonObject { ["error"] = new JsonObject { ["description"] = "not found" } };
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") });
        }
    }

    private readonly Gateway _gateway = new();

    private static string Sign(string orderId, string paymentId) =>
        EncryptDecrypt.HmacSha256Hex(Secret, Encoding.UTF8.GetBytes($"{orderId}|{paymentId}"));

    public void Dispose() => RazorpayBAL.TransportFactory = null;

    /// <summary>The shopper's "did my payment go through?" on the server that reaches the fake gateway.</summary>
    private static async Task<JsonNode> Check(HttpClient c, Api buyer, Guid oid)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/orders/{oid}/payment-status") { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", buyer.Token);
        var r = await c.SendAsync(req);
        var text = await r.Content.ReadAsStringAsync();
        Assert.True(r.IsSuccessStatusCode, text);
        return JsonNode.Parse(text)!;
    }

    /// <summary>A server whose Razorpay address is a local one, answered by the in-memory gateway.</summary>
    private HttpClient Server()
    {
        RazorpayBAL.TransportFactory = () => _gateway;
        var app = Factory.WithWebHostBuilder(b => b.UseSetting("App:RazorpayApiBase", "http://127.0.0.1:9/v1"));
        return app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });
    }

    /// <summary>A shopper's online order waiting for payment, with its Razorpay order.</summary>
    private async Task<(Api Buyer, Guid OrderId, string RzpOrder)> OnlineOrder(string phone, long amount = 10000)
    {
        var buyer = await LoginPhone(phone, "Callback Shopper");
        var oid = Guid.NewGuid();
        var rzp = "order_" + phone;
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var dal = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
        await using var tx = await db.BeginAsync();
        await dal.InsertOrderAsync(new()
        {
            Id = oid, Number = "PCT" + phone[^6..], UserId = Guid.Parse(buyer.Id), Status = "pending_payment", PaymentMethod = "online",
            PaymentStatus = "pending", ShipTo = "{}", ItemsTotal = amount, GrandTotal = amount, Currency = "INR", FxRate = 1, Fees = "[]",
            IdempotencyKey = Guid.NewGuid().ToString(), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
        }, tx);
        await tx.ExecuteAsync(
            "INSERT INTO payments(id,order_id,provider,provider_order_id,amount_paise,currency,status,method,error,created_at) VALUES(@pid,@oid,'razorpay',@rzp,@amount,'INR','created','','',UTC_TIMESTAMP())",
            new { pid = Guid.NewGuid(), oid, rzp, amount });
        await tx.CommitAsync();
        return (buyer, oid, rzp);
    }

    private static async Task<HttpResponseMessage> Post(HttpClient c, Dictionary<string, string> form) =>
        await c.PostAsync("/api/payments/razorpay/callback", new FormUrlEncodedContent(form));

    private static string Location(HttpResponseMessage r) => r.Headers.Location!.OriginalString;

    private static Task<string> OrderState(Guid oid) =>
        ApiFactory.DbScalarAsync<string>("SELECT CONCAT(status, '/', payment_status) FROM orders WHERE id = @oid", new { oid });

    [Fact]
    public async Task Return_from_upi_app_success_and_coming_back_twice_changes_nothing()
    {
        using var c = Server();
        var (buyer, oid, rzp) = await OnlineOrder("9760000011");
        var (pid, sig) = _gateway.Pay(rzp, 10000);
        var form = new Dictionary<string, string> { ["razorpay_order_id"] = rzp, ["razorpay_payment_id"] = pid, ["razorpay_signature"] = sig };
        var r = await Post(c, form);
        Assert.Equal(303, (int)r.StatusCode);
        Assert.Equal($"/orders/{oid}?payment=success", Location(r));
        Assert.Equal("placed/paid", await OrderState(oid));
        Assert.Equal(pid, await ApiFactory.DbScalarAsync<string>("SELECT provider_payment_id FROM payments WHERE order_id = @oid", new { oid }));
        // the shopper is told once, with the reference text, whichever way the payment was confirmed
        var placed = await ApiFactory.DbQueryAsync<string>(
            "SELECT subject FROM notifications WHERE user_id = @u AND event = 'order_placed' AND channel = 'inapp'", new { u = buyer.Id });
        Assert.Equal(["Order placed"], placed);
        r = await Post(c, form);
        Assert.EndsWith("payment=success", Location(r));
        Assert.Equal(1, await ApiFactory.DbScalarAsync<long>(
            "SELECT COUNT(*) FROM notifications WHERE user_id = @u AND event = 'order_placed' AND channel = 'inapp'", new { u = buyer.Id }));
    }

    [Fact]
    public async Task Return_with_a_forged_signature_trusts_only_razorpay()
    {
        using var c = Server();
        var (_, oid, rzp) = await OnlineOrder("9760000012");
        var r = await Post(c, new() { ["razorpay_order_id"] = rzp, ["razorpay_payment_id"] = "pay_fake", ["razorpay_signature"] = new string('0', 64) });
        Assert.Equal(303, (int)r.StatusCode);
        Assert.Contains("payment=failed", Location(r));
        Assert.Equal("pending_payment/pending", await OrderState(oid));
    }

    [Fact]
    public async Task Return_after_a_failed_payment_then_a_retry_succeeds()
    {
        using var c = Server();
        var (buyer, oid, rzp) = await OnlineOrder("9760000013");
        var (pid, _) = _gateway.Pay(rzp, 10000);
        _gateway.Payments[pid]["status"] = "failed";
        _gateway.Payments[pid]["error_description"] = "Payment declined by the bank";
        var r = await Post(c, new()
        {
            ["error[code]"] = "BAD_REQUEST_ERROR", ["error[description]"] = "Payment declined by the bank", ["error[source]"] = "customer",
            ["error[metadata]"] = JsonSerializer.Serialize(new { payment_id = pid, order_id = rzp }),
        });
        Assert.Equal(303, (int)r.StatusCode);
        Assert.Equal($"/orders/{oid}?payment=failed&reason=Payment+declined+by+the+bank", Location(r));
        var s = await Check(c, buyer, oid);
        Assert.True(s["status"]!.GetValue<string>() == "failed" && s["reason"]!.GetValue<string>().Contains("declined"), s.ToJsonString());
        // try again: the second attempt on the same Razorpay order succeeds
        var (pid2, sig2) = _gateway.Pay(rzp, 10000);
        r = await Post(c, new() { ["razorpay_order_id"] = rzp, ["razorpay_payment_id"] = pid2, ["razorpay_signature"] = sig2 });
        Assert.EndsWith("payment=success", Location(r));
        Assert.Equal("placed/paid", await OrderState(oid));
    }

    [Fact]
    public async Task Return_when_razorpay_is_unreachable_says_checking_and_the_next_check_records_it()
    {
        using var c = Server();
        var (buyer, oid, rzp) = await OnlineOrder("9760000016");
        var (pid, sig) = _gateway.Pay(rzp, 10000);
        _gateway.FailNext = true;
        var r = await Post(c, new() { ["razorpay_order_id"] = rzp, ["razorpay_payment_id"] = pid, ["razorpay_signature"] = sig });
        Assert.Equal($"/orders/{oid}?payment=checking", Location(r));
        // the order page's next check records it
        Assert.Equal("paid", (await Check(c, buyer, oid))["status"]!.GetValue<string>());
        Assert.Equal("placed/paid", await OrderState(oid));
    }

    [Fact]
    public async Task Return_for_an_unknown_order()
    {
        using var c = Server();
        var r = await Post(c, new() { ["razorpay_order_id"] = "order_nope", ["razorpay_payment_id"] = "pay_x", ["razorpay_signature"] = "x" });
        Assert.Equal(303, (int)r.StatusCode);
        Assert.Equal("/orders?payment=unknown", Location(r));
        r = await c.GetAsync("/api/payments/razorpay/callback");
        Assert.Equal(303, (int)r.StatusCode);
    }
}
