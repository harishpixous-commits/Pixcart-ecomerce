using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Web;
namespace BAL;

/// <summary>Gateway adapters for Cashfree, PhonePe, PayU and Stripe (docs/PAYMENT_GATEWAYS.md section 6). Mirror of services/gateways.py.
/// Built from a plain credentials dictionary and an HttpClient the caller owns; nothing here reads the database.
/// Amounts in and out are paise; adapters convert to rupees where the gateway wants them.</summary>
public sealed class GatewayException(string message) : Exception(message);

public sealed record GatewayPayment(string Reference, string Mode, JsonObject Fields);
public sealed record GatewayAttempt(string Id, string Status, string Method, long Amount, string Error);
public sealed record GatewayRefund(string Id, string Status);

public abstract class PaymentGateway(HttpClient http, IReadOnlyDictionary<string, string> creds)
{
    public abstract string Code { get; }
    protected string Cred(string k) => creds.TryGetValue(k, out var v) ? v : "";
    protected static string Rupees(long paise) => (paise / 100m).ToString("0.00", CultureInfo.InvariantCulture);
    protected static long Paise(JsonNode? rupees) => (long)Math.Round(decimal.Parse(rupees?.ToString() is { Length: > 0 } s ? s : "0", CultureInfo.InvariantCulture) * 100m);
    protected static string Sha512(string s) => Convert.ToHexString(SHA512.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    protected static string Sha256(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    protected static string HmacHex(string key, byte[] data) => Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), data)).ToLowerInvariant();
    protected static bool Same(string a, string b) => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
    protected static GatewayAttempt Attempt(string id, string status, string method, long amount, string error = "") => new(id, status, method, amount, error);
    protected static JsonObject J(params (string K, JsonNode? V)[] kv) { var o = new JsonObject(); foreach (var (k, v) in kv) o[k] = v; return o; }

    protected async Task<JsonNode?> Send(HttpMethod m, string url, IEnumerable<KeyValuePair<string, string>>? headers = null, HttpContent? content = null)
    {
        using var req = new HttpRequestMessage(m, url) { Content = content };
        foreach (var (k, v) in headers ?? []) req.Headers.TryAddWithoutValidation(k, v);
        HttpResponseMessage r;
        try { r = await http.SendAsync(req); }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { throw new GatewayException("Payment gateway is not reachable right now"); }
        var text = await r.Content.ReadAsStringAsync();
        JsonNode? body = null;
        try { body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text); } catch (JsonException) { }
        if ((int)r.StatusCode >= 400)
        {
            var msg = (body?["message"] ?? body?["error"]?["message"])?.ToString();
            throw new GatewayException(string.IsNullOrEmpty(msg) ? $"Payment gateway error ({(int)r.StatusCode})" : msg);
        }
        return body;
    }
    protected static StringContent Json(JsonNode n) => new(n.ToJsonString(), Encoding.UTF8, "application/json");
    protected static FormUrlEncodedContent Form(IEnumerable<KeyValuePair<string, string>> f) => new(f);

    public abstract Task<GatewayPayment> CreateAsync(long amount, string currency, string receipt, JsonObject customer, string returnUrl, string notifyUrl);
    public abstract Task<List<GatewayAttempt>> AttemptsAsync(string reference);
    /// <summary>One harmless authenticated call for the Test connection button; throws GatewayException when the keys are refused.</summary>
    public abstract Task PingAsync();
    public abstract bool Sandbox { get; }
    public abstract Task<GatewayRefund> RefundAsync(string reference, string paymentId, long amount, string refundId, string note);
    public abstract string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body);
    public abstract string? ReferenceFromReturn(IReadOnlyDictionary<string, string> p);

    protected static string? Header(IReadOnlyDictionary<string, string> h, string name) => h.FirstOrDefault(x => x.Key.Equals(name, StringComparison.OrdinalIgnoreCase)).Value;
    protected static string Cust(JsonObject c, string k, string fallback = "") => c[k]?.ToString() is { Length: > 0 } s ? s : fallback;
}

public sealed class CashfreeGateway : PaymentGateway
{
    private readonly string id, secret, bas;
    public override bool Sandbox { get; }
    public override async Task PingAsync()
    {
        try { await Send(HttpMethod.Get, bas + "/orders/pixcart_connection_test", H()); }
        catch (GatewayException e) when (e.Message.Contains("not found", StringComparison.OrdinalIgnoreCase) || e.Message.Contains("does not exist", StringComparison.OrdinalIgnoreCase)) { }
    }
    public CashfreeGateway(HttpClient http, IReadOnlyDictionary<string, string> creds) : base(http, creds)
    {
        id = Cred("client_id"); secret = Cred("client_secret"); Sandbox = id.StartsWith("TEST");
        bas = Sandbox ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg";
    }
    public override string Code => "cashfree";
    private Dictionary<string, string> H() => new() { ["x-client-id"] = id, ["x-client-secret"] = secret, ["x-api-version"] = "2023-08-01" };

    public override async Task<GatewayPayment> CreateAsync(long amount, string currency, string receipt, JsonObject c, string returnUrl, string notifyUrl)
    {
        var body = J(("order_id", receipt), ("order_amount", decimal.Parse(Rupees(amount), CultureInfo.InvariantCulture)), ("order_currency", currency),
            ("customer_details", J(("customer_id", Cust(c, "id", receipt)), ("customer_phone", Cust(c, "contact", "9999999999")), ("customer_name", Cust(c, "name", "Customer")), ("customer_email", Cust(c, "email")))),
            ("order_meta", J(("return_url", returnUrl), ("notify_url", notifyUrl))));
        var d = await Send(HttpMethod.Post, bas + "/orders", H(), Json(body));
        var session = d?["payment_session_id"]?.ToString();
        if (string.IsNullOrEmpty(session)) throw new GatewayException("Cashfree did not return a payment session");
        return new(d?["order_id"]?.ToString() ?? receipt, "modal", J(("sdk_url", "https://sdk.cashfree.com/js/v3/cashfree.js"), ("env", Sandbox ? "sandbox" : "production"), ("payment_session_id", session)));
    }
    public override async Task<List<GatewayAttempt>> AttemptsAsync(string reference)
    {
        var rows = await Send(HttpMethod.Get, $"{bas}/orders/{reference}/payments", H()) as JsonArray ?? [];
        return rows.Select(p => Attempt(p?["cf_payment_id"]?.ToString() ?? "", p?["payment_status"]?.ToString() switch { "SUCCESS" => "captured", "PENDING" => "pending", "NOT_ATTEMPTED" => "created", _ => "failed" },
            p?["payment_group"]?.ToString() ?? "", Paise(p?["payment_amount"]), p?["error_details"]?["error_description"]?.ToString() ?? "")).ToList();
    }
    public override async Task<GatewayRefund> RefundAsync(string reference, string paymentId, long amount, string refundId, string note)
    {
        var d = await Send(HttpMethod.Post, $"{bas}/orders/{reference}/refunds", H(), Json(J(("refund_amount", decimal.Parse(Rupees(amount), CultureInfo.InvariantCulture)), ("refund_id", refundId), ("refund_note", note.Length > 100 ? note[..100] : note))));
        return new(d?["cf_refund_id"]?.ToString() ?? refundId, d?["refund_status"]?.ToString() == "SUCCESS" ? "processed" : "pending");
    }
    public override string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        var ts = Header(headers, "x-webhook-timestamp") ?? ""; var sig = Header(headers, "x-webhook-signature") ?? "";
        if (secret.Length == 0) return null;
        var want = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(ts).Concat(body).ToArray()));
        if (!Same(want, sig)) return null;
        try { return JsonNode.Parse(body)?["data"]?["order"]?["order_id"]?.ToString() is { Length: > 0 } o ? o : null; } catch (JsonException) { return null; }
    }
    public override string? ReferenceFromReturn(IReadOnlyDictionary<string, string> p) => p.TryGetValue("order_id", out var v) && v.Length > 0 ? v : null;
}

public sealed class PhonePeGateway : PaymentGateway
{
    private readonly bool sandbox; private readonly string bas, tokenUrl;
    private string token = ""; private DateTime exp = DateTime.MinValue;
    public PhonePeGateway(HttpClient http, IReadOnlyDictionary<string, string> creds) : base(http, creds)
    {
        sandbox = Cred("mode") != "live";
        bas = sandbox ? "https://api-preprod.phonepe.com/apis/pg-sandbox" : "https://api.phonepe.com/apis/pg";
        tokenUrl = sandbox ? bas + "/v1/oauth/token" : "https://api.phonepe.com/apis/identity-manager/v1/oauth/token";
    }
    public override string Code => "phonepe";
    public override bool Sandbox => sandbox;
    public override async Task PingAsync() => await Auth();
    private async Task<Dictionary<string, string>> Auth()
    {
        if (token.Length == 0 || DateTime.UtcNow > exp.AddSeconds(-30))
        {
            var d = await Send(HttpMethod.Post, tokenUrl, null, Form([new("client_id", Cred("client_id")), new("client_secret", Cred("client_secret")), new("client_version", Cred("client_version") is { Length: > 0 } v ? v : "1"), new("grant_type", "client_credentials")]));
            token = d?["access_token"]?.ToString() ?? "";
            if (token.Length == 0) throw new GatewayException("PhonePe sign-in failed");
            exp = long.TryParse(d?["expires_at"]?.ToString(), out var e) ? DateTimeOffset.FromUnixTimeSeconds(e).UtcDateTime : DateTime.UtcNow.AddMinutes(5);
        }
        return new() { ["Authorization"] = "O-Bearer " + token };
    }
    public override async Task<GatewayPayment> CreateAsync(long amount, string currency, string receipt, JsonObject c, string returnUrl, string notifyUrl)
    {
        var body = J(("merchantOrderId", receipt), ("amount", amount), ("paymentFlow", J(("type", "PG_CHECKOUT"), ("merchantUrls", J(("redirectUrl", returnUrl))))));
        var d = await Send(HttpMethod.Post, bas + "/checkout/v2/pay", await Auth(), Json(body));
        var url = d?["redirectUrl"]?.ToString();
        if (string.IsNullOrEmpty(url)) throw new GatewayException("PhonePe did not return a payment page");
        return new(receipt, "redirect", J(("url", url)));
    }
    public override async Task<List<GatewayAttempt>> AttemptsAsync(string reference)
    {
        var d = await Send(HttpMethod.Get, $"{bas}/checkout/v2/order/{reference}/status", await Auth());
        var st = d?["state"]?.ToString() switch { "COMPLETED" => "captured", "PENDING" => "pending", _ => "failed" };
        var det = (d?["paymentDetails"] as JsonArray)?.FirstOrDefault();
        return [Attempt(det?["transactionId"]?.ToString() ?? d?["orderId"]?.ToString() ?? reference, st, det?["paymentMode"]?.ToString() ?? "", long.TryParse(d?["amount"]?.ToString(), out var a) ? a : 0, det?["errorCode"]?.ToString() ?? "")];
    }
    public override async Task<GatewayRefund> RefundAsync(string reference, string paymentId, long amount, string refundId, string note)
    {
        var d = await Send(HttpMethod.Post, bas + "/payments/v2/refund", await Auth(), Json(J(("merchantRefundId", refundId), ("originalMerchantOrderId", reference), ("amount", amount))));
        return new(d?["refundId"]?.ToString() ?? refundId, d?["state"]?.ToString() == "COMPLETED" ? "processed" : "pending");
    }
    public override string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        var u = Cred("webhook_username"); var p = Cred("webhook_password");
        var got = (Header(headers, "authorization") ?? "").Replace("SHA256(", "").TrimEnd(')');
        if (u.Length == 0 || p.Length == 0 || !Same(Sha256($"{u}:{p}"), got)) return null;
        try { var pl = JsonNode.Parse(body)?["payload"]; var r = pl?["merchantOrderId"]?.ToString() ?? pl?["originalMerchantOrderId"]?.ToString(); return string.IsNullOrEmpty(r) ? null : r; } catch (JsonException) { return null; }
    }
    public override string? ReferenceFromReturn(IReadOnlyDictionary<string, string> p) => p.GetValueOrDefault("merchantOrderId") is { Length: > 0 } a ? a : p.GetValueOrDefault("merchantTransactionId") is { Length: > 0 } b ? b : null;
}

public sealed class PayUGateway : PaymentGateway
{
    private readonly string key, salt, bas, info;
    public PayUGateway(HttpClient http, IReadOnlyDictionary<string, string> creds) : base(http, creds)
    {
        key = Cred("key"); salt = Cred("salt"); var sandbox = Cred("mode") != "live";
        bas = sandbox ? "https://test.payu.in" : "https://secure.payu.in"; info = sandbox ? "https://test.payu.in" : "https://info.payu.in";
    }
    public override string Code => "payu";
    public override bool Sandbox => bas.Contains("test.");
    public override async Task PingAsync() => await AttemptsAsync("pixcart_connection_test");
    public override Task<GatewayPayment> CreateAsync(long amount, string currency, string receipt, JsonObject c, string returnUrl, string notifyUrl)
    {
        var amt = Rupees(amount); var product = $"Order {receipt}"; if (product.Length > 100) product = product[..100];
        var first = Cust(c, "name", "Customer").Split(' ')[0]; if (first.Length > 50) first = first[..50];
        var email = Cust(c, "email", "noreply@example.com");
        var hash = Sha512(string.Join("|", key, receipt, amt, product, first, email) + new string('|', 11) + salt);
        var f = J(("key", key), ("txnid", receipt), ("amount", amt), ("productinfo", product), ("firstname", first), ("email", email), ("phone", Cust(c, "contact")), ("surl", returnUrl), ("furl", returnUrl), ("hash", hash));
        return Task.FromResult(new GatewayPayment(receipt, "form", J(("action", bas + "/_payment"), ("fields", f))));
    }
    private Task<JsonNode?> Post(string command, string var1, params (string, string)[] more)
    {
        var f = new List<KeyValuePair<string, string>> { new("key", key), new("command", command), new("var1", var1), new("hash", Sha512($"{key}|{command}|{var1}|{salt}")) };
        f.AddRange(more.Select(m => new KeyValuePair<string, string>(m.Item1, m.Item2)));
        return Send(HttpMethod.Post, info + "/merchant/postservice.php?form=2", null, Form(f));
    }
    public override async Task<List<GatewayAttempt>> AttemptsAsync(string reference)
    {
        var d = await Post("verify_payment", reference);
        var tx = d?["transaction_details"]?[reference];
        if (tx is null) return [];
        var st = tx["status"]?.ToString()?.ToLowerInvariant() switch { "success" => "captured", "pending" => "pending", _ => "failed" };
        return [Attempt(tx["mihpayid"]?.ToString() ?? "", st, tx["mode"]?.ToString() ?? "", Paise(tx["amt"]), tx["error_Message"]?.ToString() ?? "")];
    }
    public override async Task<GatewayRefund> RefundAsync(string reference, string paymentId, long amount, string refundId, string note)
    {
        var d = await Post("cancel_refund_transaction", paymentId, ("var2", refundId), ("var3", Rupees(amount)));
        if (d?["status"]?.ToString() != "1") throw new GatewayException(d?["msg"]?.ToString() is { Length: > 0 } m ? m : "PayU refund failed");
        return new(d["request_id"]?.ToString() ?? refundId, "pending");
    }
    public bool VerifyPost(IReadOnlyDictionary<string, string> p)
    {
        string G(string k) => p.GetValueOrDefault(k) ?? "";
        var parts = new List<string> { salt, G("status") };
        for (var i = 5; i >= 1; i--) parts.Add(G($"udf{i}"));
        parts.AddRange(["", "", "", "", "", G("email"), G("firstname"), G("productinfo"), G("amount"), G("txnid"), key]);
        return salt.Length > 0 && Same(Sha512(string.Join("|", parts)), G("hash"));
    }
    public override string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        var q = HttpUtility.ParseQueryString(Encoding.UTF8.GetString(body));
        var p = q.AllKeys.Where(k => k != null).ToDictionary(k => k!, k => q[k]!);
        return VerifyPost(p) ? p.GetValueOrDefault("txnid") : null;
    }
    public override string? ReferenceFromReturn(IReadOnlyDictionary<string, string> p) => VerifyPost(p) ? p.GetValueOrDefault("txnid") : null;
}

public sealed class StripeGateway : PaymentGateway
{
    private readonly string key, whsec; private const string Base = "https://api.stripe.com/v1";
    public StripeGateway(HttpClient http, IReadOnlyDictionary<string, string> creds) : base(http, creds) { key = Cred("secret_key"); whsec = Cred("webhook_secret"); }
    public override string Code => "stripe";
    public override bool Sandbox => key.StartsWith("sk_test_");
    public override async Task PingAsync() => await Send(HttpMethod.Get, Base + "/balance", H());
    private Dictionary<string, string> H(string? idem = null) { var h = new Dictionary<string, string> { ["Authorization"] = "Bearer " + key }; if (idem != null) h["Idempotency-Key"] = idem; return h; }
    public override async Task<GatewayPayment> CreateAsync(long amount, string currency, string receipt, JsonObject c, string returnUrl, string notifyUrl)
    {
        var sep = returnUrl.Contains('?') ? "&" : "?"; var back = $"{returnUrl}{sep}session_id={{CHECKOUT_SESSION_ID}}";
        var f = new List<KeyValuePair<string, string>> { new("mode", "payment"), new("line_items[0][quantity]", "1"), new("line_items[0][price_data][currency]", currency.ToLowerInvariant()),
            new("line_items[0][price_data][unit_amount]", amount.ToString(CultureInfo.InvariantCulture)), new("line_items[0][price_data][product_data][name]", $"Order {receipt}"),
            new("success_url", back), new("cancel_url", back), new("client_reference_id", receipt), new("metadata[order_number]", receipt) };
        if (Cust(c, "email") is { Length: > 0 } em) f.Add(new("customer_email", em));
        var d = await Send(HttpMethod.Post, Base + "/checkout/sessions", H(), Form(f));
        var url = d?["url"]?.ToString();
        if (string.IsNullOrEmpty(url)) throw new GatewayException("Stripe did not return a payment page");
        return new(d!["id"]!.ToString(), "redirect", J(("url", url)));
    }
    public override async Task<List<GatewayAttempt>> AttemptsAsync(string reference)
    {
        var d = await Send(HttpMethod.Get, $"{Base}/checkout/sessions/{reference}?expand[]=payment_intent", H());
        var pi = d?["payment_intent"]; var pid = pi is JsonObject o ? o["id"]?.ToString() : pi?.ToString();
        var st = d?["payment_status"]?.ToString() == "paid" ? "captured" : d?["status"]?.ToString() == "expired" ? "failed" : "pending";
        return [Attempt(string.IsNullOrEmpty(pid) ? reference : pid, st, "card", long.TryParse(d?["amount_total"]?.ToString(), out var a) ? a : 0)];
    }
    public override async Task<GatewayRefund> RefundAsync(string reference, string paymentId, long amount, string refundId, string note)
    {
        var d = await Send(HttpMethod.Post, Base + "/refunds", H(refundId), Form([new("payment_intent", paymentId), new("amount", amount.ToString(CultureInfo.InvariantCulture))]));
        return new(d?["id"]?.ToString() ?? refundId, d?["status"]?.ToString() == "succeeded" ? "processed" : "pending");
    }
    public string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body, long nowUnix)
    {
        var parts = (Header(headers, "stripe-signature") ?? "").Split(',').Select(x => x.Split('=', 2)).Where(x => x.Length == 2).GroupBy(x => x[0]).ToDictionary(x => x.Key, x => x.First()[1]);
        if (whsec.Length == 0 || !parts.TryGetValue("t", out var t) || !long.TryParse(t, out var ts) || Math.Abs(nowUnix - ts) > 300) return null;
        if (!Same(HmacHex(whsec, Encoding.UTF8.GetBytes(t + ".").Concat(body).ToArray()), parts.GetValueOrDefault("v1") ?? "")) return null;
        try { return JsonNode.Parse(body)?["data"]?["object"]?["id"]?.ToString() is { Length: > 0 } r ? r : null; } catch (JsonException) { return null; }
    }
    public override string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body) => VerifyWebhook(headers, body, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
    public override string? ReferenceFromReturn(IReadOnlyDictionary<string, string> p) => p.GetValueOrDefault("session_id") is { Length: > 0 } s ? s : null;
}

/// <summary>Credentials and switches for the extra gateways, read from the integration settings in effect.</summary>
public static class GatewayConfig
{
    public static readonly string[] Extra = ["cashfree", "phonepe", "payu", "stripe"];
    public static Dictionary<string, string> Credentials(Model.DomainModel.Integrations.IntegrationSettings c, string code) => code switch
    {
        "cashfree" => new() { ["client_id"] = c.CashfreeClientId, ["client_secret"] = c.CashfreeClientSecret },
        "phonepe" => new() { ["client_id"] = c.PhonepeClientId, ["client_secret"] = c.PhonepeClientSecret, ["client_version"] = c.PhonepeClientVersion, ["webhook_username"] = c.PhonepeWebhookUsername, ["webhook_password"] = c.PhonepeWebhookPassword, ["mode"] = c.PhonepeMode },
        "payu" => new() { ["key"] = c.PayuKey, ["salt"] = c.PayuSalt, ["mode"] = c.PayuMode },
        "stripe" => new() { ["secret_key"] = c.StripeSecretKey, ["webhook_secret"] = c.StripeWebhookSecret },
        _ => [],
    };
    public static bool Configured(Model.DomainModel.Integrations.IntegrationSettings c, string code)
    {
        var cr = Credentials(c, code);
        var need = code switch { "cashfree" => new[] { "client_id", "client_secret" }, "phonepe" => ["client_id", "client_secret"], "payu" => ["key", "salt"], "stripe" => ["secret_key"], _ => null };
        return need != null && need.All(k => cr.GetValueOrDefault(k, "").Length > 0);
    }
    public static bool Enabled(Model.DomainModel.Integrations.IntegrationSettings c, string code) => code == "razorpay" ? c.RazorpayEnabled && c.RazorpayCheckout : Configured(c, code) && code switch
    { "cashfree" => c.CashfreeCheckout, "phonepe" => c.PhonepeCheckout, "payu" => c.PayuCheckout, "stripe" => c.StripeCheckout, _ => false };
    public static PaymentGateway Build(HttpClient http, Model.DomainModel.Integrations.IntegrationSettings c, string code) => code switch
    {
        "cashfree" => new CashfreeGateway(http, Credentials(c, code)), "phonepe" => new PhonePeGateway(http, Credentials(c, code)),
        "payu" => new PayUGateway(http, Credentials(c, code)), "stripe" => new StripeGateway(http, Credentials(c, code)),
        _ => throw new ArgumentException("Unknown gateway"),
    };
}
