using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel.Integrations;
using Utils;

namespace BAL;

/// <summary>
/// Razorpay REST client boundary (reference: services/razorpay.py). Provider keys come from the merged integration
/// store (Admin → Integrations wins over appsettings) via <see cref="IIntegrationBAL"/>; the API base URL and the
/// network timeouts come from the server configuration. Docs: https://razorpay.com/docs/api/
/// </summary>
public class RazorpayBAL(AppSettings app, IIntegrationBAL integrations, IHttpClientFactory http) : IRazorpayBAL
{
    /// <summary>The gateway could not do what was asked (reference: razorpay.GatewayError).</summary>
    public sealed class GatewayException(string message) : Exception(message);

    public async Task<bool> OnlinePaymentsAsync() => (await integrations.GetAsync()).OnlinePayments;

    public Task<JsonObject> CreateOrderAsync(long amount, string receipt, IReadOnlyDictionary<string, string> notes, string currency = "INR")
    {
        var body = new JsonObject
        {
            ["amount"] = amount,
            ["currency"] = currency,
            ["receipt"] = receipt.Length > 40 ? receipt[..40] : receipt,
            ["notes"] = new JsonObject(notes.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
        };
        return CallAsync(HttpMethod.Post, "/orders", body);
    }

    public Task<JsonObject> CreateCustomerAsync(string name, string contact, string email)
    {
        var n = name.Length > 0 ? name : "Customer";
        var body = new JsonObject
        {
            ["name"] = n.Length > 50 ? n[..50] : n,
            ["fail_existing"] = "0",
        };
        if (contact.Length > 0) body["contact"] = contact;
        if (email.Length > 0) body["email"] = email;
        return CallAsync(HttpMethod.Post, "/customers", body);
    }

    public Task<JsonObject> FetchPaymentAsync(string paymentId) =>
        CallAsync(HttpMethod.Get, $"/payments/{paymentId}", null);

    public async Task<IReadOnlyList<JsonObject>> OrderPaymentsAsync(string orderId)
    {
        var data = await CallAsync(HttpMethod.Get, $"/orders/{orderId}/payments", null);
        return data["items"] is JsonArray items ? items.OfType<JsonObject>().ToList() : [];
    }

    public Task<JsonObject> CapturePaymentAsync(string paymentId, long amount, string currency = "INR") =>
        CallAsync(HttpMethod.Post, $"/payments/{paymentId}/capture", new JsonObject { ["amount"] = amount, ["currency"] = currency });

    public Task<JsonObject> RefundPaymentAsync(string paymentId, long amount, string receipt, IReadOnlyDictionary<string, string> notes) =>
        CallAsync(HttpMethod.Post, $"/payments/{paymentId}/refund", new JsonObject
        {
            ["amount"] = amount,
            ["speed"] = "normal",
            ["receipt"] = receipt.Length > 40 ? receipt[..40] : receipt,
            ["notes"] = new JsonObject(notes.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
        });

    public async Task<bool> VerifyPaymentSignatureAsync(string orderId, string paymentId, string signature)
    {
        var secret = (await integrations.GetAsync()).RazorpayKeySecret;
        if (secret.Length == 0) return false;
        var expected = HmacHex(secret, Encoding.UTF8.GetBytes($"{orderId}|{paymentId}"));
        return CryptographicEquals(expected, signature ?? "");
    }

    public async Task<bool> VerifyWebhookSignatureAsync(byte[] body, string signature)
    {
        var secret = (await integrations.GetAsync()).RazorpayWebhookSecret;
        if (secret.Length == 0) return false;
        var expected = HmacHex(secret, body);
        return CryptographicEquals(expected, signature ?? "");
    }

    /// <summary>Test hook (reference: razorpay.transport): when set, every gateway send goes through this handler,
    /// so tests record each request and prove none leaves the box. Null keeps production transports.</summary>
    public static Func<HttpMessageHandler>? TransportFactory { get; set; }

    /// <summary>Test safeguard client: never follows redirects, so a mock cannot bounce a request off-box.
    /// Used while the egress policy is restricted.</summary>
    private static readonly HttpClient LoopbackClient =
        new(new HttpClientHandler { AllowAutoRedirect = false }, disposeHandler: true);

    /// <summary>Only literal loopback IPs pass: no hostnames to resolve, nothing to trick with DNS or /etc/hosts.</summary>
    private static bool IsLoopbackLiteral(string apiBase)
    {
        if (!Uri.TryCreate(apiBase, UriKind.Absolute, out var uri)) return false;
        if (uri.Host == "::1" || uri.Host == "[::1]") return true;
        var parts = uri.Host.Split('.');
        return parts.Length == 4 && parts[0] == "127" && parts.All(p => byte.TryParse(p, out _));
    }

    private static string HmacHex(string secret, byte[] data)
    {
        using var h = new System.Security.Cryptography.HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(h.ComputeHash(data)).ToLowerInvariant();
    }

    private static bool CryptographicEquals(string a, string b) =>
        a.Length == b.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));

    /// <summary>Reference: razorpay._call. Offline keys fail before any network; a 4xx/5xx carries the gateway's own
    /// description; a network failure reads as the gateway being unreachable.</summary>
    private async Task<JsonObject> CallAsync(HttpMethod method, string path, JsonObject? body)
    {
        var cfg = await integrations.GetAsync();
        if (!cfg.RazorpayEnabled) throw new GatewayException("Online payments are not configured");
        var apiBase = app.RazorpayApiBase.TrimEnd('/');
        var loopbackOnly = app.ExternalProviderMode != "open"; // fail closed: unset means restricted
        if (loopbackOnly && !IsLoopbackLiteral(apiBase))
            // Fail closed: unparsable or non-loopback base means no request is ever attempted.
            throw new GatewayException("External provider calls are restricted to a local mock in this environment");
        string text;
        int status;
        try
        {
            using var req = new HttpRequestMessage(method, apiBase + path);
            req.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{cfg.RazorpayKeyId}:{cfg.RazorpayKeySecret}")));
            if (body is not null)
                req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var resp = TransportFactory is { } factory
                ? await new HttpClient(factory(), disposeHandler: true).SendAsync(req, HttpCompletionOption.ResponseContentRead)
                : loopbackOnly
                    ? await LoopbackClient.SendAsync(req, HttpCompletionOption.ResponseContentRead)
                    : await http.CreateClient().SendAsync(req, HttpCompletionOption.ResponseContentRead);
            status = (int)resp.StatusCode;
            text = await resp.Content.ReadAsStringAsync();
        }
        catch (HttpRequestException)
        {
            throw new GatewayException("Payment gateway is not reachable right now");
        }
        catch (TaskCanceledException)
        {
            throw new GatewayException("Payment gateway is not reachable right now");
        }
        JsonObject? json = null;
        var readable = true;
        try { json = JsonNode.Parse(text) as JsonObject; } catch (JsonException) { readable = false; }
        if (status >= 400)
        {
            // a body that is not JSON (a proxy's error page) is shown as it is, shortened
            var desc = readable ? json?["error"]?["description"]?.GetValue<string>() ?? "" : (text.Length > 200 ? text[..200] : text);
            throw new GatewayException(desc.Length > 0 ? desc : $"Payment gateway error ({status})");
        }
        return json ?? new JsonObject();
    }
}
