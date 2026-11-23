using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using Utils.Interface;
using Utils.UtilModels;

namespace Utils;

/// <summary>SMS through MSG91 (DLT-registered templates), or the log in development.</summary>
public class SMSHelper(IHttpClientFactory http, ILogger<SMSHelper> log) : ISMSHelper
{
    /// <summary>
    /// Development and test outbox: the last code sent to each number with the "console" provider, so local runs and
    /// automated tests can read it (the reference version's sms.DEV_OUTBOX). Never filled with the msg91 provider.
    /// </summary>
    public static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> DevOutbox = new();

    public async Task SendOtpAsync(SMSModel sms, SmsConfig config, CancellationToken ct = default)
    {
        if (config.Provider != "msg91")
        {
            DevOutbox[sms.Phone] = sms.OtpCode ?? "";
            log.LogWarning("DEV OTP for {Phone}: {Code}", sms.Phone, sms.OtpCode);
            return;
        }
        if (string.IsNullOrEmpty(config.AuthKey) || string.IsNullOrEmpty(config.OtpTemplateId))
            throw new AppException("SMS is not set up (Admin → Integrations → MSG91)", "sms_not_configured", 503);
        var client = Client(config);
        var url = $"/api/v5/otp?template_id={Uri.EscapeDataString(config.OtpTemplateId)}&mobile=91{sms.Phone}&otp={sms.OtpCode}";
        using var resp = await client.PostAsync(url, null, ct);
        await Check(resp, ct);
    }

    public async Task SendMessageAsync(SMSModel sms, SmsConfig config, CancellationToken ct = default)
    {
        if (config.Provider != "msg91")
        {
            log.LogInformation("DEV SMS to {Phone}: {Message}", sms.Phone, sms.Message);
            return;
        }
        if (string.IsNullOrEmpty(config.AuthKey) || string.IsNullOrEmpty(sms.TemplateId))
            throw new AppException("SMS is not set up (Admin → Integrations → MSG91)", "sms_not_configured", 503);
        var client = Client(config);
        var recipient = new Dictionary<string, string>(sms.Variables) { ["mobiles"] = $"91{sms.Phone}" };
        using var resp = await client.PostAsJsonAsync("/api/v5/flow", new { template_id = sms.TemplateId, short_url = "0", recipients = new[] { recipient } }, ct);
        await Check(resp, ct);
    }

    private HttpClient Client(SmsConfig config)
    {
        var client = http.CreateClient("msg91");
        client.BaseAddress = new Uri(config.ApiBase);
        client.Timeout = TimeSpan.FromSeconds(10);
        client.DefaultRequestHeaders.Remove("authkey");
        client.DefaultRequestHeaders.Add("authkey", config.AuthKey);
        return client;
    }

    private static async Task Check(HttpResponseMessage resp, CancellationToken ct)
    {
        var text = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode || text.Contains("\"type\":\"error\"", StringComparison.OrdinalIgnoreCase))
            throw new AppException("Could not send the SMS. Please try again in a minute.", "sms_failed", 502);
    }
}
