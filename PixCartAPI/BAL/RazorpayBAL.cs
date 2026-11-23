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
        var body = new JsonObject
        {
            ["name"] = name.Length > 100 ? name[..100] : name,
            ["contact"] = contact.Length > 15 ? contact[..15] : contact,
            ["email"] = email.Length > 100 ? email[..100] : email,
            ["fail_existing"] = "0",
        };
        return CallAsync(HttpMethod.Post, "/customers", body);
    }

    /// <summary>Reference: razorpay._call. Offline keys fail before any network; a 4xx/5xx carries the gateway's own
    /// description; a network failure reads as the gateway being unreachable.</summary>
    private async Task<JsonObject> CallAsync(HttpMethod method, string path, JsonObject body)
    {
        var cfg = await integrations.GetAsync();
        if (!cfg.RazorpayEnabled) throw new GatewayException("Online payments are not configured");
        string text;
        int status;
        try
        {
            using var req = new HttpRequestMessage(method, app.RazorpayApiBase.TrimEnd('/') + path);
            req.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{cfg.RazorpayKeyId}:{cfg.RazorpayKeySecret}")));
            req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var resp = await http.CreateClient().SendAsync(req, HttpCompletionOption.ResponseContentRead);
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
        try { json = JsonNode.Parse(text) as JsonObject; } catch (JsonException) { /* handled below */ }
        if (status >= 400)
        {
            var desc = json?["error"]?["description"]?.GetValue<string>() ?? "";
            throw new GatewayException(desc.Length > 0 ? desc : $"Payment gateway error ({status})");
        }
        return json ?? new JsonObject();
    }
}
