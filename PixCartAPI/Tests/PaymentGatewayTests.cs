using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using BAL.Interface;
using BAL.Payments;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel.Integrations;
using Utils;

namespace Tests;

/// <summary>Each payment gateway adapter against an HTTP fake (requests, answers, signatures, returns), the egress rule,
/// each gateway's health and routing with failover (docs/PAYMENT_GATEWAYS.md, sections 2, 3 and 6).</summary>
public sealed class PaymentGatewayTests(ApiFactory f) : ApiTest(f), IDisposable
{
    public void Dispose()
    {
        PaymentHttp.TransportFactory = null;
        PhonePeGateway.Tokens.Clear();
    }

    private static readonly PaymentCustomer Priya = new("Priya Sharma", "9876543210", "priya@example.com");
    private const string Ret = "https://shop.example/api/payments/x/callback";
    private const string Hook = "https://shop.example/api/payments/x/webhook";

    private static IntegrationSettings Cfg() => new()
    {
        PublicWebUrl = "https://shop.example",
        CashfreeClientId = "TEST10012345", CashfreeClientSecret = "cfsk_ma_test_secret", CashfreeCheckout = true,
        PhonepeClientId = "PIXCARTUAT", PhonepeClientSecret = "pp-secret", PhonepeCheckout = true, PhonepeWebhookUsername = "pixhook", PhonepeWebhookPassword = "pixhookpass",
        PayuKey = "gtKFFx", PayuSalt = "eCwWELxi", PayuCheckout = true,
        StripeSecretKey = "sk_test_51Pix0000000000", StripeWebhookSecret = "whsec_pixcart0000000000", StripeCheckout = true,
    };

    private sealed class NoFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("the test hook must carry every request");
    }

    private sealed class NoRazorpay : IRazorpayBAL
    {
        public Task<bool> OnlinePaymentsAsync() => Task.FromResult(false);
        public Task<JsonObject> CreateOrderAsync(long a, string r, IReadOnlyDictionary<string, string> n, string c = "INR") => throw new InvalidOperationException("not used");
        public Task<JsonObject> CreateCustomerAsync(string n, string c, string e) => throw new InvalidOperationException("not used");
        public Task<JsonObject> FetchPaymentAsync(string id) => throw new InvalidOperationException("not used");
        public Task<IReadOnlyList<JsonObject>> OrderPaymentsAsync(string id) => throw new InvalidOperationException("not used");
        public Task<JsonObject> CapturePaymentAsync(string id, long amount, string currency = "INR") => throw new InvalidOperationException("not used");
        public Task<JsonObject> RefundPaymentAsync(string p, long a, string r, IReadOnlyDictionary<string, string> n) => throw new InvalidOperationException("not used");
        public Task<bool> VerifyPaymentSignatureAsync(string a, string b, string c) => throw new InvalidOperationException("not used");
        public Task<bool> VerifyWebhookSignatureAsync(byte[] b, string s) => throw new InvalidOperationException("not used");
    }

    /// <summary>Cashfree, PhonePe, PayU and Stripe in memory, with switchable trouble per gateway.</summary>
    private sealed class Fake : HttpMessageHandler
    {
        public readonly Dictionary<string, string> Trouble = [];
        public readonly List<HttpRequestMessage> Requests = [];
        public readonly List<string> Bodies = [];
        public readonly Dictionary<string, JsonObject> Cashfree = [];
        public readonly Dictionary<string, JsonObject> Phonepe = [];
        public readonly Dictionary<string, JsonObject> PhonepeRefunds = [];
        public readonly Dictionary<string, JsonObject> Payu = [];
        public readonly Dictionary<string, JsonObject> PayuRefunds = [];
        public readonly Dictionary<string, JsonObject> Stripe = [];
        public readonly Dictionary<string, JsonObject> StripeRefunds = [];
        public readonly Dictionary<string, JsonObject> Idempotent = [];
        public int Tokens;

        private static HttpResponseMessage Json(int status, JsonNode body) =>
            new((HttpStatusCode)status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };

        private static Dictionary<string, string> Form(string body) =>
            body.Split('&', StringSplitOptions.RemoveEmptyEntries).Select(p => p.Split('=', 2))
                .ToDictionary(p => WebUtility.UrlDecode(p[0]), p => p.Length > 1 ? WebUtility.UrlDecode(p[1]) : "");

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            Requests.Add(request);
            Bodies.Add(body);
            var host = request.RequestUri!.Host;
            var code = new[] { "cashfree", "phonepe", "payu", "stripe" }.FirstOrDefault(host.Contains) ?? "?";
            switch (Trouble.GetValueOrDefault(code))
            {
                case "timeout": throw new TaskCanceledException("too slow");
                case "down": throw new HttpRequestException("connection refused");
                case "error": return Json(500, new JsonObject { ["message"] = $"{code} is having trouble", ["error"] = new JsonObject { ["message"] = $"{code} is having trouble" } });
            }
            var path = request.RequestUri.AbsolutePath;
            return code switch
            {
                "cashfree" => CashfreeAnswer(request, path, body),
                "phonepe" => PhonepeAnswer(request, path.Replace("/apis/pg-sandbox", ""), body),
                "payu" => PayuAnswer(Form(body)),
                "stripe" => StripeAnswer(request, path.Replace("/v1", ""), body),
                _ => Json(404, new JsonObject()),
            };
        }

        private HttpResponseMessage CashfreeAnswer(HttpRequestMessage r, string path, string body)
        {
            if (r.Headers.GetValues("x-client-secret").First() != "cfsk_ma_test_secret") return Json(401, new JsonObject { ["message"] = "authentication Failed" });
            Assert.Equal("2023-08-01", r.Headers.GetValues("x-api-version").First());
            var parts = path.Replace("/pg/", "").Split('/');
            if (r.Method == HttpMethod.Post && path == "/pg/orders")
            {
                var b = JsonNode.Parse(body)!.AsObject();
                Cashfree[b["order_id"]!.GetValue<string>()] = new JsonObject { ["body"] = b.DeepClone(), ["payments"] = new JsonArray(), ["refunds"] = new JsonObject() };
                return Json(200, new JsonObject { ["order_id"] = b["order_id"]!.DeepClone(), ["payment_session_id"] = "session_" + Guid.NewGuid().ToString("N")[..12] });
            }
            if (parts.Length >= 2 && Cashfree.TryGetValue(parts[1], out var order))
            {
                if (r.Method == HttpMethod.Get && parts.Length == 3 && parts[2] == "payments") return Json(200, order["payments"]!.DeepClone());
                if (r.Method == HttpMethod.Post && parts.Length == 3 && parts[2] == "refunds")
                {
                    var b = JsonNode.Parse(body)!.AsObject();
                    var refund = new JsonObject { ["cf_refund_id"] = "cfr_" + Guid.NewGuid().ToString("N")[..8], ["refund_id"] = b["refund_id"]!.DeepClone(), ["refund_status"] = "PENDING" };
                    order["refunds"]![b["refund_id"]!.GetValue<string>()] = refund;
                    return Json(200, refund.DeepClone());
                }
                if (r.Method == HttpMethod.Get && parts.Length == 4 && parts[2] == "refunds")
                    return order["refunds"]![parts[3]] is JsonObject rf ? Json(200, rf.DeepClone()) : Json(404, new JsonObject { ["message"] = "refund not found" });
            }
            return Json(404, new JsonObject { ["message"] = "not found" });
        }

        public void CashfreePay(string orderId, string status, string group = "upi", string message = "")
        {
            var order = Cashfree[orderId];
            order["payments"]!.AsArray().Add(new JsonObject
            {
                ["cf_payment_id"] = 5000000000 + order["payments"]!.AsArray().Count, ["payment_status"] = status, ["payment_amount"] = order["body"]!["order_amount"]!.DeepClone(),
                ["payment_group"] = group, ["payment_message"] = message, ["payment_time"] = "2026-11-27T10:00:00+05:30",
            });
        }

        private HttpResponseMessage PhonepeAnswer(HttpRequestMessage r, string path, string body)
        {
            if (r.Method == HttpMethod.Post && path == "/v1/oauth/token")
            {
                var form = Form(body);
                if (form.GetValueOrDefault("client_secret") != "pp-secret") return Json(401, new JsonObject { ["message"] = "Client authentication failed" });
                Tokens++;
                return Json(200, new JsonObject { ["access_token"] = $"tok{Tokens}", ["expires_at"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 });
            }
            if (!r.Headers.TryGetValues("Authorization", out var auth) || !auth.First().StartsWith("O-Bearer tok")) return Json(401, new JsonObject { ["message"] = "Token is not valid" });
            if (r.Method == HttpMethod.Post && path == "/checkout/v2/pay")
            {
                var b = JsonNode.Parse(body)!.AsObject();
                Phonepe[b["merchantOrderId"]!.GetValue<string>()] = new JsonObject { ["body"] = b.DeepClone(), ["payments"] = new JsonArray() };
                return Json(200, new JsonObject { ["state"] = "PENDING", ["redirectUrl"] = "https://mercury-uat.phonepe.com/transact/uat_v2?token=abc" });
            }
            var parts = path.Split('/');
            if (r.Method == HttpMethod.Get && path.StartsWith("/checkout/v2/order/"))
                return Phonepe.TryGetValue(parts[4], out var o) ? Json(200, new JsonObject { ["paymentDetails"] = o["payments"]!.DeepClone() }) : Json(404, new JsonObject { ["code"] = "NOT_FOUND" });
            if (r.Method == HttpMethod.Post && path == "/payments/v2/refund")
            {
                var b = JsonNode.Parse(body)!.AsObject();
                PhonepeRefunds[b["merchantRefundId"]!.GetValue<string>()] = new JsonObject { ["body"] = b.DeepClone(), ["state"] = "PENDING" };
                return Json(200, new JsonObject { ["refundId"] = "OMR123", ["state"] = "PENDING" });
            }
            if (r.Method == HttpMethod.Get && path.StartsWith("/payments/v2/refund/"))
                return PhonepeRefunds.TryGetValue(parts[4], out var rf) ? Json(200, new JsonObject { ["state"] = rf["state"]!.DeepClone() }) : Json(404, new JsonObject());
            return Json(404, new JsonObject());
        }

        private HttpResponseMessage PayuAnswer(Dictionary<string, string> f)
        {
            var expected = Convert.ToHexString(SHA512.HashData(Encoding.UTF8.GetBytes($"{f["key"]}|{f["command"]}|{f.GetValueOrDefault("var1", "")}|eCwWELxi"))).ToLowerInvariant();
            if (f["hash"] != expected) return Json(200, new JsonObject { ["status"] = 0, ["msg"] = "Invalid Hash." });
            switch (f["command"])
            {
                case "verify_payment":
                    var row = Payu.TryGetValue(f["var1"], out var t) ? t.DeepClone() : new JsonObject { ["mihpayid"] = "Not Found", ["status"] = "Not Found" };
                    return Json(200, new JsonObject { ["status"] = 1, ["transaction_details"] = new JsonObject { [f["var1"]] = row } });
                case "cancel_refund_transaction":
                    var id = (7800000 + PayuRefunds.Count).ToString();
                    PayuRefunds[id] = new JsonObject { ["mihpayid"] = f["var1"], ["amount"] = f["var3"], ["status"] = "queued" };
                    return Json(200, new JsonObject { ["status"] = 1, ["msg"] = "Refund Request Queued", ["request_id"] = id });
                default:
                    var refund = PayuRefunds[f["var1"]];
                    return Json(200, new JsonObject { ["status"] = 1, ["transaction_details"] = new JsonObject { [f["var1"]] = new JsonObject {
                        [refund["mihpayid"]!.GetValue<string>()] = new JsonObject { ["request_id"] = f["var1"], ["status"] = refund["status"]!.DeepClone() } } } });
            }
        }

        private HttpResponseMessage StripeAnswer(HttpRequestMessage r, string path, string body)
        {
            if (r.Headers.GetValues("Authorization").First() != "Bearer sk_test_51Pix0000000000") return Json(401, new JsonObject { ["error"] = new JsonObject { ["message"] = "Invalid API Key" } });
            if (r.Method == HttpMethod.Post && path == "/checkout/sessions")
            {
                var form = Form(body);
                var id = "cs_test_" + Guid.NewGuid().ToString("N")[..10];
                Stripe[id] = new JsonObject { ["id"] = id, ["url"] = $"https://checkout.stripe.com/c/pay/{id}", ["payment_status"] = "unpaid", ["status"] = "open",
                    ["amount_total"] = long.Parse(form["line_items[0][price_data][unit_amount]"]), ["created"] = 1, ["payment_intent"] = null, ["form"] = JsonValue.Create(body) };
                return Json(200, Stripe[id].DeepClone());
            }
            if (r.Method == HttpMethod.Get && path.StartsWith("/checkout/sessions/"))
            {
                Assert.Contains("expand%5B%5D=payment_intent", r.RequestUri!.Query);
                return Stripe.TryGetValue(path.Split('/')[3], out var s) ? Json(200, s.DeepClone()) : Json(404, new JsonObject { ["error"] = new JsonObject { ["message"] = "No such session" } });
            }
            if (r.Method == HttpMethod.Post && path == "/refunds")
            {
                var key = r.Headers.TryGetValues("Idempotency-Key", out var k) ? k.First() : "";
                if (key.Length > 0 && Idempotent.TryGetValue(key, out var same)) return Json(200, same.DeepClone());
                var form = Form(body);
                var refund = new JsonObject { ["id"] = "re_" + Guid.NewGuid().ToString("N")[..10], ["payment_intent"] = form["payment_intent"], ["status"] = "pending" };
                StripeRefunds[refund["id"]!.GetValue<string>()] = refund;
                if (key.Length > 0) Idempotent[key] = refund;
                return Json(200, refund.DeepClone());
            }
            if (r.Method == HttpMethod.Get && path.StartsWith("/refunds/"))
                return StripeRefunds.TryGetValue(path.Split('/')[2], out var rf) ? Json(200, rf.DeepClone()) : Json(404, new JsonObject());
            if (path == "/balance") return Json(200, new JsonObject { ["object"] = "balance" });
            return Json(404, new JsonObject());
        }

        public string StripePay(string sessionId)
        {
            var pi = "pi_" + Guid.NewGuid().ToString("N")[..10];
            Stripe[sessionId]["payment_intent"] = new JsonObject { ["id"] = pi, ["status"] = "succeeded" };
            Stripe[sessionId]["payment_status"] = "paid";
            return pi;
        }
    }

    private static PaymentHttp Open(Fake fake)
    {
        PaymentHttp.TransportFactory = () => fake;
        PhonePeGateway.Tokens.Clear();
        return new PaymentHttp(new AppSettings { ExternalProviderMode = "open" }, new NoFactory());
    }

    private static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

    [Fact]
    public async Task Cashfree_order_attempts_refund_webhook_and_return()
    {
        var fake = new Fake();
        var g = new CashfreeGateway(Open(fake));
        var c = Cfg();
        var created = await g.CreateAsync(c, 49950, "INR", "PC-1001", Priya, Ret, Hook);
        Assert.Equal("https://sandbox.cashfree.com/pg/orders", fake.Requests[^1].RequestUri!.ToString());
        var body = JsonNode.Parse(fake.Bodies[^1])!.AsObject();
        Assert.StartsWith("PC-1001-", created.Reference);
        Assert.Equal(created.Reference, body["order_id"]!.GetValue<string>());
        Assert.Equal(499.5, body["order_amount"]!.GetValue<double>());
        Assert.Equal("c9876543210", body["customer_details"]!["customer_id"]!.GetValue<string>());
        Assert.Equal(Ret + "?order_id={order_id}", body["order_meta"]!["return_url"]!.GetValue<string>());
        Assert.Equal("sandbox", created.Fields["env"]!.GetValue<string>());
        Assert.Equal("https://sdk.cashfree.com/js/v3/cashfree.js", created.Fields["sdk_url"]!.GetValue<string>());

        Assert.Empty(await g.AttemptsAsync(c, created.Reference));
        fake.CashfreePay(created.Reference, "FAILED", "card", "Insufficient funds");
        fake.CashfreePay(created.Reference, "SUCCESS");
        var attempts = await g.AttemptsAsync(c, created.Reference);
        Assert.Equal(("failed", "card", 49950L, "Insufficient funds"), (attempts[0].Status, attempts[0].Method, attempts[0].Amount, attempts[0].Error));
        Assert.Equal(("captured", "upi", 49950L, ""), (attempts[1].Status, attempts[1].Method, attempts[1].Amount, attempts[1].Error));

        var refund = await g.RefundAsync(c, attempts[1].Id, created.Reference, 10000, "INR", "rf-1", "Cancelled");
        Assert.Equal("pending", refund.Status);
        Assert.Equal(100.0, JsonNode.Parse(fake.Bodies[^1])!["refund_amount"]!.GetValue<double>());
        Assert.Equal("pending", await g.RefundStatusAsync(c, created.Reference, "rf-1", ""));
        fake.Cashfree[created.Reference]["refunds"]!["rf-1"]!["refund_status"] = "SUCCESS";
        Assert.Equal("processed", await g.RefundStatusAsync(c, created.Reference, "rf-1", ""));
        Assert.Equal("unknown", await g.RefundStatusAsync(c, created.Reference, "rf-404", ""));

        var raw = Encoding.UTF8.GetBytes("{\"type\":\"PAYMENT_SUCCESS_WEBHOOK\",\"data\":{\"order\":{\"order_id\":\"" + created.Reference + "\"}}}");
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        var sig = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes("cfsk_ma_test_secret"), Encoding.UTF8.GetBytes(ts).Concat(raw).ToArray()));
        Assert.Equal(created.Reference, g.VerifyWebhook(c, new Dictionary<string, string> { ["x-webhook-timestamp"] = ts, ["x-webhook-signature"] = sig }, raw));
        Assert.Null(g.VerifyWebhook(c, new Dictionary<string, string> { ["x-webhook-timestamp"] = ts, ["x-webhook-signature"] = sig }, [.. raw, 32]));
        Assert.Equal(created.Reference, g.ReferenceFromReturn(new Dictionary<string, string> { ["order_id"] = created.Reference }));
        Assert.Equal("Keys accepted (sandbox)", await g.TestAsync(c));
        await Assert.ThrowsAsync<NotApplicableException>(() => g.CreateAsync(c, 100, "INR", "PC-1", new("Asha", "", ""), Ret, Hook));
    }

    [Fact]
    public async Task PhonePe_token_is_reused_and_the_flows_map()
    {
        var fake = new Fake();
        var g = new PhonePeGateway(Open(fake));
        var c = Cfg();
        var created = await g.CreateAsync(c, 29900, "INR", "PC-2002", Priya, Ret, Hook);
        Assert.StartsWith("https://mercury-uat.phonepe.com/", created.Fields["url"]!.GetValue<string>());
        var pay = JsonNode.Parse(fake.Bodies[^1])!;
        Assert.Equal(29900, pay["amount"]!.GetValue<long>());
        Assert.Equal($"{Ret}?merchantOrderId={created.Reference}", pay["paymentFlow"]!["merchantUrls"]!["redirectUrl"]!.GetValue<string>());
        fake.Phonepe[created.Reference]["payments"]!.AsArray().Add(new JsonObject { ["transactionId"] = "OM1", ["paymentMode"] = "UPI_INTENT", ["state"] = "COMPLETED",
            ["amount"] = 29900, ["timestamp"] = 1764230400000 });
        var a = (await g.AttemptsAsync(c, created.Reference)).Single();
        Assert.Equal(("OM1", "captured", "upi", 29900L), (a.Id, a.Status, a.Method, a.Amount));
        Assert.Equal(1, fake.Tokens);
        var refund = await g.RefundAsync(c, "OM1", created.Reference, 29900, "INR", "rf-2", "");
        Assert.Equal(("OMR123", "pending"), (refund.Reference, refund.Status));
        fake.PhonepeRefunds["rf-2"]["state"] = "COMPLETED";
        Assert.Equal("processed", await g.RefundStatusAsync(c, created.Reference, "rf-2", ""));
        var auth = Hex(SHA256.HashData(Encoding.UTF8.GetBytes("pixhook:pixhookpass")));
        var evt = Encoding.UTF8.GetBytes("{\"event\":\"checkout.order.completed\",\"payload\":{\"merchantOrderId\":\"" + created.Reference + "\"}}");
        Assert.Equal(created.Reference, g.VerifyWebhook(c, new Dictionary<string, string> { ["authorization"] = auth.ToUpperInvariant() }, evt));
        Assert.Null(g.VerifyWebhook(c, new Dictionary<string, string> { ["authorization"] = new string('f', 64) }, evt));
    }

    [Fact]
    public async Task PayU_form_hash_verify_refund_and_signed_post_back()
    {
        var fake = new Fake();
        var g = new PayUGateway(Open(fake));
        var c = Cfg();
        var created = await g.CreateAsync(c, 59900, "INR", "PC-3003", Priya, Ret, Hook);
        Assert.Empty(fake.Requests);
        var f = created.Fields["fields"]!.AsObject();
        Assert.Equal("https://test.payu.in/_payment", created.Fields["action"]!.GetValue<string>());
        Assert.Equal(("599.00", "Order PC-3003", "Priya"), (f["amount"]!.GetValue<string>(), f["productinfo"]!.GetValue<string>(), f["firstname"]!.GetValue<string>()));
        Assert.Equal(Hex(SHA512.HashData(Encoding.UTF8.GetBytes($"gtKFFx|{created.Reference}|599.00|Order PC-3003|Priya|priya@example.com|||||||||||eCwWELxi"))),
            f["hash"]!.GetValue<string>());
        Assert.Empty(await g.AttemptsAsync(c, created.Reference));
        fake.Payu[created.Reference] = new JsonObject { ["mihpayid"] = "403993715521", ["status"] = "success", ["mode"] = "UPI", ["amt"] = "599.00" };
        var a = (await g.AttemptsAsync(c, created.Reference)).Single();
        Assert.Equal(("403993715521", "captured", "upi", 59900L), (a.Id, a.Status, a.Method, a.Amount));
        var refund = await g.RefundAsync(c, a.Id, created.Reference, 10050, "INR", "rf-3", "");
        Assert.Equal("pending", refund.Status);
        Assert.Equal("pending", await g.RefundStatusAsync(c, created.Reference, "rf-3", refund.Reference));
        fake.PayuRefunds[refund.Reference]["status"] = "success";
        Assert.Equal("processed", await g.RefundStatusAsync(c, created.Reference, "rf-3", refund.Reference));
        var posted = new Dictionary<string, string> { ["key"] = "gtKFFx", ["txnid"] = created.Reference, ["amount"] = "599.00", ["productinfo"] = "Order PC-3003",
            ["firstname"] = "Priya", ["email"] = "priya@example.com", ["status"] = "success" };
        posted["hash"] = Hex(SHA512.HashData(Encoding.UTF8.GetBytes($"eCwWELxi|success|||||||||||priya@example.com|Priya|Order PC-3003|599.00|{created.Reference}|gtKFFx")));
        Assert.Equal(posted["hash"], PayUGateway.ResponseHash("eCwWELxi", posted));
        var form = string.Join("&", posted.Select(kv => $"{WebUtility.UrlEncode(kv.Key)}={WebUtility.UrlEncode(kv.Value)}"));
        Assert.Equal(created.Reference, g.VerifyWebhook(c, new Dictionary<string, string>(), Encoding.UTF8.GetBytes(form)));
        Assert.Null(g.VerifyWebhook(c, new Dictionary<string, string>(), Encoding.UTF8.GetBytes(form.Replace("599.00", "1.00"))));
    }

    [Fact]
    public async Task Stripe_session_refund_idempotency_and_signed_webhook()
    {
        var fake = new Fake();
        var g = new StripeGateway(Open(fake));
        var c = Cfg();
        var created = await g.CreateAsync(c, 129900, "INR", "PC-4004", Priya, Ret, Hook);
        Assert.Contains("success_url=" + WebUtility.UrlEncode(Ret + "?session_id={CHECKOUT_SESSION_ID}"), fake.Bodies[^1]);
        Assert.Equal($"https://checkout.stripe.com/c/pay/{created.Reference}", created.Fields["url"]!.GetValue<string>());
        Assert.Empty(await g.AttemptsAsync(c, created.Reference));
        var pi = fake.StripePay(created.Reference);
        var a = (await g.AttemptsAsync(c, created.Reference)).Single();
        Assert.Equal((pi, "captured", 129900L), (a.Id, a.Status, a.Amount));
        var first = await g.RefundAsync(c, pi, created.Reference, 129900, "INR", "rf-4", "");
        Assert.Equal("refund-rf-4", fake.Requests[^1].Headers.GetValues("Idempotency-Key").First());
        var again = await g.RefundAsync(c, pi, created.Reference, 129900, "INR", "rf-4", "");
        Assert.Equal(first.Reference, again.Reference);
        Assert.Single(fake.StripeRefunds);
        var raw = Encoding.UTF8.GetBytes("{\"type\":\"checkout.session.completed\",\"data\":{\"object\":{\"object\":\"checkout.session\",\"id\":\"" + created.Reference + "\"}}}");
        var t = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        string Sign(long stamp) => $"t={stamp},v1={Hex(HMACSHA256.HashData(Encoding.UTF8.GetBytes("whsec_pixcart0000000000"), Encoding.UTF8.GetBytes(stamp + ".").Concat(raw).ToArray()))}";
        Assert.Equal(created.Reference, g.VerifyWebhook(c, new Dictionary<string, string> { ["stripe-signature"] = Sign(t) }, raw));
        Assert.Null(g.VerifyWebhook(c, new Dictionary<string, string> { ["stripe-signature"] = Sign(t - 600) }, raw));
        Assert.Equal("Keys accepted (test mode)", await g.TestAsync(c));
    }

    [Fact]
    public async Task Calls_stay_on_a_local_mock_unless_provider_access_is_open_and_trouble_reads_well()
    {
        var fake = new Fake();
        PaymentHttp.TransportFactory = () => fake;
        var restricted = new CashfreeGateway(new PaymentHttp(new AppSettings(), new NoFactory()));
        var e = await Assert.ThrowsAsync<PaymentGatewayException>(() => restricted.AttemptsAsync(Cfg(), "x"));
        Assert.Equal("External provider calls are restricted to a local mock in this environment", e.Message);
        Assert.Empty(fake.Requests);
        var g = new CashfreeGateway(Open(fake));
        fake.Trouble["cashfree"] = "timeout";
        Assert.Equal("Cashfree did not answer in time", (await Assert.ThrowsAsync<PaymentGatewayException>(() => g.AttemptsAsync(Cfg(), "x"))).Message);
        fake.Trouble["cashfree"] = "down";
        Assert.Equal("Cashfree is not reachable right now", (await Assert.ThrowsAsync<PaymentGatewayException>(() => g.AttemptsAsync(Cfg(), "x"))).Message);
        Assert.Equal(new[] { "upi", "card", "netbanking", "wallet", "emi", "paylater", "cardless_emi", "crypto" },
            new[] { "UPI_INTENT", "credit_card", "NB", "CASH", "debit_card_emi", "pay_later", "cardless_emi", "Crypto" }.Select(PaymentText.MethodOf));
    }

    private (PaymentRouting Routing, PaymentHealth Health, PaymentGateways Gateways, IServiceScope Scope) Routing(PaymentHttp http)
    {
        var scope = Factory.Services.CreateScope();
        var health = scope.ServiceProvider.GetRequiredService<PaymentHealth>();
        var gateways = new PaymentGateways([new RazorpayGateway(new NoRazorpay()), new CashfreeGateway(http), new PhonePeGateway(http), new PayUGateway(http), new StripeGateway(http)]);
        return (new PaymentRouting(scope.ServiceProvider.GetRequiredService<SettingsDAL>(), gateways, health), health, gateways, scope);
    }

    private static Task AddEvents(string gateway, params bool[] oks) =>
        Task.WhenAll(oks.Select((ok, i) => ApiFactory.DbExecAsync(
            "INSERT INTO payment_gateway_events (id, gateway, ok, ms, error, created_at) VALUES (@id, @gateway, @ok, 100, @error, DATE_SUB(UTC_TIMESTAMP(6), INTERVAL @age SECOND))",
            new { id = Guid.NewGuid(), gateway, ok, error = ok ? "" : "boom", age = oks.Length - i })));

    [Fact]
    public async Task Circuit_success_rates_figures_and_routing_with_failover()
    {
        await ApiFactory.DbExecAsync("DELETE FROM payment_gateway_events");
        var fake = new Fake();
        var (routing, health, _, scope) = Routing(Open(fake));
        using var _scope = scope;
        var rules = PaymentRouting.Normalize(null);
        Assert.Equal("closed", await health.CircuitAsync("cashfree", rules));
        await AddEvents("cashfree", false, false, false);
        Assert.Equal("open", await health.CircuitAsync("cashfree", rules));
        Assert.Equal("half_open", await health.CircuitAsync("cashfree", rules, DateTimeFunctions.UtcNow().AddSeconds(125)));
        await AddEvents("payu", true, false, false, true, false);
        var rates = await health.SuccessRatesAsync(["payu", "stripe"], rules);
        Assert.Equal((0.4, 1.0), (rates["payu"], rates["stripe"]));
        var stats = await health.StatsAsync(["payu", "phonepe"]);
        Assert.Equal((5L, 2L, 0.4), (stats["payu"]["attempts"]!.GetValue<long>(), stats["payu"]["ok"]!.GetValue<long>(), stats["payu"]["success_rate"]!.GetValue<double>()));
        Assert.Null(stats["phonepe"]["success_rate"]);
        Assert.Equal(19, PaymentHealth.RankP95(20));

        var c = Cfg();
        var eligible = await routing.EligibleAsync(c, "INR", rules);
        Assert.Equal(new[] { "phonepe", "payu", "stripe" }, eligible.Select(g => g.Code));  // Cashfree is paused
        Assert.Equal(new[] { "stripe" }, (await routing.EligibleAsync(c, "USD", rules)).Select(g => g.Code));
        await ApiFactory.DbExecAsync("DELETE FROM payment_gateway_events");
        fake.Trouble["cashfree"] = "error";
        fake.Trouble["phonepe"] = "timeout";
        var candidates = await routing.EligibleAsync(c, "INR", rules);
        var (winner, created) = await routing.StartAsync(c, candidates, rules, 10000, "INR", "PC-9", Priya);
        Assert.Equal("payu", winner.Code);
        Assert.Equal("https://test.payu.in/_payment", created.Fields["action"]!.GetValue<string>());
        var events = await ApiFactory.DbQueryAsync<string>("SELECT CONCAT(gateway, ':', ok) FROM payment_gateway_events ORDER BY created_at");
        Assert.Equal(new[] { "cashfree:0", "phonepe:0", "payu:1" }, events);
        var off = PaymentRouting.Normalize(new JsonObject { ["failover"] = false });
        var e = await Assert.ThrowsAsync<PaymentStartException>(() => routing.StartAsync(c, candidates, off, 10000, "INR", "PC-10", Priya));
        Assert.Equal((502, "gateway_error", "Could not start the payment: cashfree is having trouble"), (e.StatusCode, e.Code, e.Message));
        var none = await Assert.ThrowsAsync<PaymentStartException>(() => routing.StartAsync(c, [], rules, 10000, "INR", "PC-11", Priya));
        Assert.Equal((409, "payments_unavailable"), (none.StatusCode, none.Code));
        var alternatives = PaymentRouting.Alternatives(candidates, "payu");
        Assert.Equal("[{\"provider\":\"cashfree\",\"label\":\"Cashfree Payments\"},{\"provider\":\"phonepe\",\"label\":\"PhonePe Payment Gateway\"},{\"provider\":\"stripe\",\"label\":\"Stripe\"}]",
            alternatives.ToJsonString());
    }

    [Fact]
    public void Routing_settings_are_cleaned_and_checked()
    {
        var cleaned = PaymentRouting.Normalize(JsonNode.Parse("{\"order\":[\"stripe\",\"nope\",\"stripe\",5],\"failover\":\"yes\",\"timeout_seconds\":99,\"min_samples\":7,\"strategy\":\"random\"}"));
        Assert.Equal("[\"stripe\"]", cleaned["order"]!.ToJsonString());
        Assert.Equal((7, 8, true, "priority"), ((int)cleaned["min_samples"]!, (int)cleaned["timeout_seconds"]!, (bool)cleaned["failover"]!, (string)cleaned["strategy"]!));
        var e = Assert.Throws<AppException>(() => PaymentRouting.Validate(JsonNode.Parse(
            "{\"order\":[\"payu\",\"payu\"],\"failover\":1,\"strategy\":\"x\",\"timeout_seconds\":2,\"circuit_failures\":21,\"circuit_cooldown_seconds\":5,\"window_minutes\":2000,\"min_samples\":true}")!.AsObject()));
        Assert.Equal(("invalid_routing", 422), (e.Code, e.StatusCode));
        Assert.Equal(new Dictionary<string, string>
        {
            ["order"] = "Each gateway only once", ["failover"] = "Choose on or off", ["strategy"] = "Choose priority or success rate",
            ["timeout_seconds"] = "Time-out: a whole number from 3 to 30", ["circuit_failures"] = "Failures before pausing a gateway: a whole number from 1 to 20",
            ["circuit_cooldown_seconds"] = "Pause length: a whole number from 10 to 3600", ["window_minutes"] = "Success-rate window: a whole number from 5 to 1440",
            ["min_samples"] = "Minimum calls: a whole number from 1 to 100",
        }, e.Fields);
    }
}
