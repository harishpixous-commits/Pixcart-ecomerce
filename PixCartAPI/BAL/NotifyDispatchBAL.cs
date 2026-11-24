using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.Extensions.Logging;
using DAL;
using MailKit.Net.Smtp;
using MailKit.Security;
using MimeKit;
using Model.DomainModel;
using Model.DomainModel.Integrations;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="INotifyDispatchBAL"/>
public class NotifyDispatchBAL(NotificationDAL dal, IntegrationBAL integrations, AppSettings app,
    IHttpClientFactory http, IMySqlDapperHelper db, ILogger<NotifyDispatchBAL> log) : INotifyDispatchBAL
{
    /// <summary>Only literal loopback IPs pass: no hostnames to resolve (same fail-closed rule as RazorpayBAL).</summary>
    private static bool IsLoopbackLiteral(string baseOrHost)
    {
        var host = baseOrHost;
        if (Uri.TryCreate(baseOrHost, UriKind.Absolute, out var uri)) host = uri.Host;
        if (host is "::1" or "[::1]") return true;
        var parts = host.Split('.');
        return parts.Length == 4 && parts[0] == "127" && parts.All(p => byte.TryParse(p, out _));
    }

    private bool Restricted => app.ExternalProviderMode != "open"; // fail closed: unset means restricted

    /// <summary>Reference: dispatch_pending.</summary>
    public async Task<int> DispatchPendingAsync(int limit = 100)
    {
        var cfg = await integrations.GetAsync();
        var sent = 0;
        await using var uow = await db.BeginAsync();
        var rows = (await dal.PendingForUpdateAsync(limit, uow.Transaction)).ToList();
        foreach (var n in rows)
        {
            n.Attempts += 1;
            try
            {
                switch (n.Channel)
                {
                    case "email": await SendEmailAsync(cfg, n); break;
                    case "sms": await SendSmsAsync(cfg, n); break;
                    case "whatsapp": await SendWhatsappAsync(cfg, n); break;
                    default: throw new InvalidOperationException($"unknown channel {n.Channel}");
                }
                n.Status = "sent";
                n.SentAt = DateTimeFunctions.UtcNow();
                n.Error = "";
                sent++;
            }
            catch (Exception e)
            {
                // Reference: provider errors are recorded and retried; a row fails for good after 5 attempts.
                n.Error = e.Message.Length > 500 ? e.Message[..500] : e.Message;
                if (n.Attempts >= 5) n.Status = "failed";
                log.LogWarning("notification {Id} via {Channel} failed: {Error}", n.Id, n.Channel, e.Message);
            }
            await dal.UpdateDeliveryAsync(n, uow.Transaction);
        }
        await uow.CommitAsync();
        return sent;
    }

    private static Dictionary<string, string> Vars(NotificationModel n)
    {
        var outp = new Dictionary<string, string>();
        if (JsonNode.Parse(n.Variables) is JsonObject o)
            foreach (var kv in o) outp[kv.Key] = kv.Value?.GetValue<string>() ?? "";
        return outp;
    }

    /// <summary>Reference: _send_email_sync. The subject cannot carry line breaks (header injection).</summary>
    private async Task SendEmailAsync(IntegrationSettings cfg, NotificationModel n)
    {
        if (cfg.SmtpHost.Length == 0) throw new InvalidOperationException("SMTP is not set up");
        if (Restricted && !IsLoopbackLiteral(cfg.SmtpHost))
            throw new InvalidOperationException("External provider calls are restricted to a local mock in this environment");
        var vars = Vars(n);
        var brand = vars.GetValueOrDefault("brand", app.AppName);
        var sender = cfg.SmtpFrom.Length > 0 ? cfg.SmtpFrom : cfg.SmtpUser;
        var msg = new MimeMessage();
        msg.From.Add(sender.Contains('<') ? MailboxAddress.Parse(sender) : new MailboxAddress(brand, sender));
        msg.To.Add(MailboxAddress.Parse(n.Recipient));
        msg.Subject = string.Join(' ', n.Subject.Split());
        msg.Body = new TextPart("plain") { Text = n.Body };
        using var client = new SmtpClient { Timeout = 20_000 };
        var secure = cfg.SmtpSecurity == "ssl" ? SecureSocketOptions.SslOnConnect
            : cfg.SmtpSecurity == "starttls" ? SecureSocketOptions.StartTls : SecureSocketOptions.None;
        await client.ConnectAsync(cfg.SmtpHost, cfg.SmtpPort, secure);
        if (cfg.SmtpUser.Length > 0) await client.AuthenticateAsync(cfg.SmtpUser, cfg.SmtpPassword);
        await client.SendAsync(new MailKit.SendRequest(msg));
        await client.DisconnectAsync(true);
    }

    /// <summary>Reference: _send_sms (MSG91 Flow API; variables passed by name).</summary>
    private async Task SendSmsAsync(IntegrationSettings cfg, NotificationModel n)
    {
        if (Restricted && !IsLoopbackLiteral(cfg.Msg91ApiBase))
            throw new InvalidOperationException("External provider calls are restricted to a local mock in this environment");
        var vars = Vars(n);
        var recipient = new JsonObject { ["mobiles"] = $"91{n.Recipient}" };
        foreach (var (k, v) in vars.Where(kv => !kv.Key.StartsWith('_'))) recipient[k] = v;
        var body = new JsonObject
        {
            ["template_id"] = vars.GetValueOrDefault("_template"),
            ["recipients"] = new JsonArray(recipient),
        };
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.Msg91ApiBase.TrimEnd('/')}/api/v5/flow");
        req.Headers.Add("authkey", cfg.Msg91AuthKey);
        req.Headers.Add("accept", "application/json");
        req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var resp = await http.CreateClient().SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        var isError = (int)resp.StatusCode >= 400;
        if (!isError)
            try
            {
                isError = JsonNode.Parse(text)?["type"]?.GetValue<string>() == "error";
            }
            catch (JsonException) { /* a non-JSON 2xx is not an error (local mocks) */ }
        if (isError) throw new InvalidOperationException($"MSG91 {(int)resp.StatusCode}: {text[..Math.Min(200, text.Length)]}");
    }

    /// <summary>Reference: _send_whatsapp (WhatsApp Cloud API template message).</summary>
    private async Task SendWhatsappAsync(IntegrationSettings cfg, NotificationModel n)
    {
        if (Restricted && !IsLoopbackLiteral(cfg.WhatsappApiBase))
            throw new InvalidOperationException("External provider calls are restricted to a local mock in this environment");
        var vars = Vars(n);
        var parameters = vars.GetValueOrDefault("_params").Split('|', StringSplitOptions.RemoveEmptyEntries);
        if (parameters.Length == 0) parameters = [n.Body[..Math.Min(1000, n.Body.Length)]];
        var body = new JsonObject
        {
            ["messaging_product"] = "whatsapp",
            ["to"] = $"91{n.Recipient}",
            ["type"] = "template",
            ["template"] = new JsonObject
            {
                ["name"] = vars.GetValueOrDefault("_template"),
                ["language"] = new JsonObject { ["code"] = cfg.WhatsappLanguage },
                ["components"] = new JsonArray(new JsonObject
                {
                    ["type"] = "body",
                    ["parameters"] = new JsonArray(parameters.Select(p => (JsonNode)new JsonObject { ["type"] = "text", ["text"] = p }).ToArray()),
                }),
            },
        };
        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"{cfg.WhatsappApiBase.TrimEnd('/')}/{cfg.WhatsappApiVersion}/{cfg.WhatsappPhoneNumberId}/messages");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.WhatsappToken);
        req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var resp = await http.CreateClient().SendAsync(req);
        if ((int)resp.StatusCode >= 400)
        {
            var text = await resp.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"WhatsApp {(int)resp.StatusCode}: {text[..Math.Min(200, text.Length)]}");
        }
    }
}
