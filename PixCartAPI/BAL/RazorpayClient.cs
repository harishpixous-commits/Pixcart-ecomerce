using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Utils;

namespace BAL;

/// <summary>
/// Razorpay customers and tokens (reference: services/razorpay.py create_customer, customer_tokens, delete_token).
/// Keys: the "razorpay" entry of the integrations settings (secrets stored as {"enc": Fernet token}) over appsettings.
/// </summary>
public class RazorpayClient(IHttpClientFactory http, SettingsDAL settings, EncryptDecrypt crypto, AppSettings app, ILogger<RazorpayClient> log) : IRazorpayClient
{
    public const string HttpClientName = "razorpay";

    private string Value(JsonObject values, string key, string fallback)
    {
        if (!values.TryGetPropertyValue(key, out var v) || v is null) return fallback;
        if (v is JsonObject enc && enc["enc"] is JsonValue token)
        {
            var plain = crypto.Decrypt(token.GetValue<string>());
            return plain.Length > 0 ? plain : fallback; // a secret that no longer decrypts counts as not set
        }
        return v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : fallback;
    }

    public async Task<RazorpayConfig> ConfigAsync()
    {
        var entry = (await settings.GetAsync("integrations"))["razorpay"] as JsonObject ?? [];
        var values = entry["values"] as JsonObject ?? [];
        var keyId = Value(values, "key_id", app.RazorpayKeyId);
        var secret = Value(values, "key_secret", app.RazorpayKeySecret);
        var checkout = entry["enabled"]?.GetValueKind() switch { JsonValueKind.False => false, _ => true };
        return new RazorpayConfig(keyId, secret, app.RazorpayApiBase, checkout);
    }

    public async Task<bool> OnlinePaymentsAsync() => (await ConfigAsync()).OnlinePayments;

    private async Task<JsonNode?> CallAsync(HttpMethod method, string path, JsonObject? body = null)
    {
        var cfg = await ConfigAsync();
        if (!cfg.Enabled) throw new RazorpayGatewayException("Online payments are not configured");
        var client = http.CreateClient(HttpClientName);
        client.Timeout = TimeSpan.FromSeconds(15);
        using var req = new HttpRequestMessage(method, cfg.ApiBase.TrimEnd('/') + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{cfg.KeyId}:{cfg.KeySecret}")));
        if (body != null) req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        HttpResponseMessage resp;
        try
        {
            resp = await client.SendAsync(req);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            log.LogError("razorpay {Method} {Path} network error: {Error}", method, path, e.Message);
            throw new RazorpayGatewayException("Payment gateway is not reachable right now");
        }
        var text = await resp.Content.ReadAsStringAsync();
        if ((int)resp.StatusCode >= 400)
        {
            string desc;
            try
            {
                desc = JsonNode.Parse(text)?["error"]?["description"]?.GetValue<string>() ?? "";
            }
            catch (Exception)
            {
                desc = text.Length > 200 ? text[..200] : text;
            }
            log.LogError("razorpay {Method} {Path} -> {Status} {Desc}", method, path, (int)resp.StatusCode, desc);
            throw new RazorpayGatewayException(desc.Length > 0 ? desc : $"Payment gateway error ({(int)resp.StatusCode})");
        }
        return JsonNode.Parse(text);
    }

    public async Task<JsonObject> CreateCustomerAsync(string name, string contact, string email)
    {
        var n = string.IsNullOrEmpty(name) ? "Customer" : name;
        var body = new JsonObject { ["name"] = n.Length > 50 ? n[..50] : n, ["fail_existing"] = "0" };
        if (!string.IsNullOrEmpty(contact)) body["contact"] = contact;
        if (!string.IsNullOrEmpty(email)) body["email"] = email;
        return await CallAsync(HttpMethod.Post, "/customers", body) as JsonObject ?? [];
    }

    public async Task<List<JsonObject>> CustomerTokensAsync(string customerId)
    {
        var data = await CallAsync(HttpMethod.Get, $"/customers/{Uri.EscapeDataString(customerId)}/tokens");
        return (data?["items"] as JsonArray ?? []).OfType<JsonObject>().ToList();
    }

    public async Task DeleteTokenAsync(string customerId, string tokenId) =>
        await CallAsync(HttpMethod.Delete, $"/customers/{Uri.EscapeDataString(customerId)}/tokens/{Uri.EscapeDataString(tokenId)}");
}
