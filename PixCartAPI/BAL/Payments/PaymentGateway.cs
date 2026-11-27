using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Model.DomainModel.Integrations;
using Utils;

namespace BAL.Payments;

/// <summary>A gateway could not do what was asked: unreachable, slow, refused, or it answered with an error.</summary>
public class PaymentGatewayException(string message) : Exception(message);

/// <summary>This gateway cannot take this particular payment (a detail it needs is missing): the next gateway is tried and
/// this one's health is not affected.</summary>
public sealed class NotApplicableException(string message) : PaymentGatewayException(message);

public sealed record PaymentCustomer(string Name, string Phone, string Email);

/// <summary>The gateway's order, session or transaction reference, and the fields the browser or app needs to open it.</summary>
public sealed record CreatedPayment(string Reference, JsonObject Fields);

/// <summary>One payment attempt as the gateway reports it: status created, pending, authorized, captured or failed.</summary>
public sealed record PaymentAttempt(string Id, string Status, string Method = "", long Amount = 0, string Error = "", long CreatedAt = 0);

/// <summary>The gateway's refund reference and status (processed or pending).</summary>
public sealed record RefundResult(string Reference, string Status);

/// <summary>
/// What every payment gateway offers the shop (docs/PAYMENT_GATEWAYS.md, section 6). Amounts are in the currency's
/// smallest unit (paise for INR) unless noted.
/// </summary>
public interface IPaymentGateway
{
    string Code { get; }
    string Name { get; }
    /// <summary>modal, redirect or form: how the browser or app opens the payment.</summary>
    string Mode { get; }
    /// <summary>Payments must be captured after the shopper authorises them.</summary>
    bool CaptureNeeded => false;
    /// <summary>RefundStatusAsync can find a refund by our refund id, before the gateway's own reference is known.</summary>
    bool RefundLookupByOurId => false;

    /// <summary>The keys are filled in, so calls are possible (refunds and checks keep working after the switch is off).</summary>
    bool Configured(IntegrationSettings cfg);
    /// <summary>The admin's switch for taking new payments through this gateway.</summary>
    bool SwitchedOn(IntegrationSettings cfg);
    bool Enabled(IntegrationSettings cfg) => Configured(cfg) && SwitchedOn(cfg);
    /// <summary>The currencies the gateway can charge; null means any.</summary>
    IReadOnlySet<string>? Currencies(IntegrationSettings cfg) => PaymentGateways.InrOnly;
    bool Sandbox(IntegrationSettings cfg);
    /// <summary>The gateway's webhooks can be verified (their secret is filled in, where they have one of their own).</summary>
    bool WebhookReady(IntegrationSettings cfg) => true;

    Task<CreatedPayment> CreateAsync(IntegrationSettings cfg, long amount, string currency, string receipt, PaymentCustomer customer,
        string returnUrl, string notifyUrl, CancellationToken ct = default);
    Task<IReadOnlyList<PaymentAttempt>> AttemptsAsync(IntegrationSettings cfg, string reference, CancellationToken ct = default);
    Task<PaymentAttempt> CaptureAsync(IntegrationSettings cfg, PaymentAttempt attempt, long amount, string currency) => Task.FromResult(attempt);
    Task<RefundResult> RefundAsync(IntegrationSettings cfg, string paymentId, string reference, long amount, string currency, string refundId, string note);
    /// <summary>processed, pending or failed for a refund already sent; "unknown" when the gateway has no such refund or cannot say.</summary>
    Task<string> RefundStatusAsync(IntegrationSettings cfg, string reference, string refundId, string providerRefundId) => Task.FromResult("unknown");
    /// <summary>The reference a verified event is about ("" for a genuine event about nothing the shop tracks); null when
    /// the signature does not check out.</summary>
    string? VerifyWebhook(IntegrationSettings cfg, IReadOnlyDictionary<string, string> headers, byte[] body);
    /// <summary>The reference the shopper's browser came back with from the gateway's payment page.</summary>
    string ReferenceFromReturn(IReadOnlyDictionary<string, string> data);
    /// <summary>One harmless authenticated call; the message to show. Throws PaymentGatewayException when the keys do not work.</summary>
    Task<string> TestAsync(IntegrationSettings cfg);
}

/// <summary>Money and method words shared by the gateways.</summary>
public static class PaymentText
{
    /// <summary>An amount for gateways that take rupees: two decimals, a dot, no grouping.</summary>
    public static string Rupees(long paise) => $"{paise / 100}.{paise % 100:00}";

    /// <summary>Rupees as a gateway reports them (number or text) back to paise.</summary>
    public static long PaiseOf(JsonNode? value)
    {
        if (value is null) return 0;
        var text = value.GetValueKind() == JsonValueKind.String ? value.GetValue<string>() : value.ToJsonString();
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? (long)Math.Round(d * 100, MidpointRounding.ToEven) : 0;
    }

    private static readonly Dictionary<string, string> Methods = new()
    {
        ["upi"] = "upi", ["upi_intent"] = "upi", ["upi_collect"] = "upi", ["upi_qr"] = "upi",
        ["card"] = "card", ["credit_card"] = "card", ["debit_card"] = "card", ["cc"] = "card", ["dc"] = "card", ["token"] = "card",
        ["credit card"] = "card", ["debit card"] = "card",
        ["net_banking"] = "netbanking", ["netbanking"] = "netbanking", ["nb"] = "netbanking",
        ["wallet"] = "wallet", ["cash"] = "wallet",
        ["emi"] = "emi", ["credit_card_emi"] = "emi", ["debit_card_emi"] = "emi", ["cardless_emi"] = "cardless_emi",
        ["pay_later"] = "paylater", ["paylater"] = "paylater", ["bnpl"] = "paylater",
    };

    /// <summary>A gateway's payment method name in the shop's words (upi, card, netbanking, wallet, emi, paylater ...);
    /// a name that is not listed is kept, lower-cased, up to 20 characters.</summary>
    public static string MethodOf(string? value)
    {
        var text = (value ?? "").Trim().ToLowerInvariant();
        return Methods.TryGetValue(text, out var m) ? m : text.Length > 20 ? text[..20] : text;
    }

    public static string S(JsonNode? n) => n?.GetValueKind() switch
    {
        JsonValueKind.String => n.GetValue<string>(),
        null or JsonValueKind.Null => "",
        _ => n.ToJsonString(),
    };

    /// <summary>A whole number as a gateway sends it (a number, or digits in text); 0 when there is none. Numbers are read
    /// from their JSON text, so a parsed answer and one built in memory read the same.</summary>
    public static long L(JsonNode? n) => n?.GetValueKind() switch
    {
        JsonValueKind.Number => WholeNumber(n.ToJsonString()),
        JsonValueKind.String => long.TryParse(n.GetValue<string>(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : 0,
        _ => 0,
    };

    private static long WholeNumber(string text) =>
        long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var whole) ? whole
        : double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? (long)d : 0;

    public static string Cut(string s, int n) => s.Length > n ? s[..n] : s;

    public static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    public static bool SameText(string a, string b) =>
        a.Length == b.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));
}

/// <summary>
/// Calls to the gateways beside Razorpay, with the same egress rule as the Razorpay client: unless
/// App:ExternalProviderMode is "open", only literal loopback addresses are called (a local mock); redirects are never
/// followed; and every request can be routed through one test handler.
/// </summary>
public sealed class PaymentHttp(AppSettings app, IHttpClientFactory http)
{
    /// <summary>Test hook: when set, every gateway request goes through this handler. Null keeps the real transports.</summary>
    public static Func<HttpMessageHandler>? TransportFactory { get; set; }

    private static readonly HttpClient LoopbackClient = new(new HttpClientHandler { AllowAutoRedirect = false }, disposeHandler: true);

    private static bool IsLoopbackLiteral(Uri uri)
    {
        if (uri.Host is "::1" or "[::1]") return true;
        var parts = uri.Host.Split('.');
        return parts.Length == 4 && parts[0] == "127" && parts.All(p => byte.TryParse(p, out _));
    }

    /// <summary>Sends one request; network trouble becomes PaymentGatewayException with a readable message.</summary>
    public async Task<(int Status, string Body)> SendAsync(string gateway, HttpRequestMessage request, double timeoutSeconds = 15, CancellationToken ct = default)
    {
        var restricted = app.ExternalProviderMode != "open"; // fail closed: unset means restricted
        if (restricted && !IsLoopbackLiteral(request.RequestUri!))
            throw new PaymentGatewayException("External provider calls are restricted to a local mock in this environment");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        HttpClient? own = null;
        try
        {
            var client = TransportFactory is { } factory ? own = new HttpClient(factory(), disposeHandler: true)
                : restricted ? LoopbackClient : http.CreateClient("payments");
            using var resp = await client.SendAsync(request, HttpCompletionOption.ResponseContentRead, cts.Token);
            return ((int)resp.StatusCode, await resp.Content.ReadAsStringAsync(cts.Token));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new PaymentGatewayException($"{gateway} did not answer in time");
        }
        catch (HttpRequestException)
        {
            throw new PaymentGatewayException($"{gateway} is not reachable right now");
        }
        finally
        {
            own?.Dispose();
        }
    }

    public static HttpRequestMessage Json(HttpMethod method, string url, JsonNode? body)
    {
        var req = new HttpRequestMessage(method, url);
        if (body is not null) req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return req;
    }

    public static HttpRequestMessage Form(HttpMethod method, string url, IEnumerable<KeyValuePair<string, string>>? form)
    {
        var req = new HttpRequestMessage(method, url);
        if (form is not null) req.Content = new FormUrlEncodedContent(form);
        return req;
    }

    /// <summary>The most readable error message in a gateway's error answer (dotted paths like "error.message").</summary>
    public static string ErrorText(string body, params string[] keys)
    {
        JsonNode? data;
        try { data = JsonNode.Parse(body); }
        catch (JsonException) { return PaymentText.Cut(body, 200); }
        foreach (var key in keys)
        {
            JsonNode? node = data;
            foreach (var part in key.Split('.')) node = node is JsonObject o ? o[part] : null;
            if (node is JsonValue v && v.GetValueKind() == JsonValueKind.String && v.GetValue<string>().Length > 0)
                return PaymentText.Cut(v.GetValue<string>(), 300);
        }
        return PaymentText.Cut(data?.ToJsonString() ?? "", 200);
    }

    public static JsonNode? Parse(string body)
    {
        try { return JsonNode.Parse(body); }
        catch (JsonException) { return null; }
    }
}

/// <summary>Every gateway in the standard order: razorpay, cashfree, phonepe, payu, stripe.</summary>
public sealed class PaymentGateways(IEnumerable<IPaymentGateway> all)
{
    public static readonly IReadOnlySet<string> InrOnly = new HashSet<string> { "INR" };
    public static readonly string[] Order = ["razorpay", "cashfree", "phonepe", "payu", "stripe"];

    public IReadOnlyList<IPaymentGateway> All { get; } = Order.Select(code => all.First(g => g.Code == code)).ToList();

    public IPaymentGateway? Find(string code) => All.FirstOrDefault(g => g.Code == code);

    public IPaymentGateway Get(string code) => Find(code) ?? throw new PaymentGatewayException($"Unknown payment gateway: {code}");
}
