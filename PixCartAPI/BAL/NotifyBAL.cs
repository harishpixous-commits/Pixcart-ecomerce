using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Model.Constants;
using Model.DomainModel;
using Utils;
using Utils.Interface;
using Utils.UtilModels;

namespace BAL;

/// <summary>A push waiting to be sent: the user, title, body, link and data.</summary>
public record PushItem(Guid UserId, string Title, string Body, string Link, IReadOnlyDictionary<string, string> Data);

/// <inheritdoc cref="INotifyBAL"/>
public class NotifyBAL(
    NotificationDAL dal, AccountDAL accounts, StaffDAL staff, SettingsDAL settings, IIntegrationBAL integrations, IAccessBAL access,
    IMailHelper mail, ISMSHelper sms, IHttpClientFactory http, IServiceScopeFactory scopes, AppSettings env, IMySqlDapperHelper db,
    ILogger<NotifyBAL> log) : INotifyBAL, IAsyncDisposable, IDisposable
{
    // Nontransactional pushes flush when this scope is disposed. Transactional pushes use commit callbacks.
    private readonly List<PushItem> _pushes = [];

    /// <summary>Fills {{name}} placeholders; unknown names become empty.</summary>
    public static string Render(string text, IReadOnlyDictionary<string, string> variables) => EmailSMSTemplate.Render(text, variables);

    /// <summary>Python's str() for variable values (True/False/None, invariant numbers).</summary>
    public static string TextOf(object? v) => v switch
    {
        null => "None",
        bool b => b ? "True" : "False",
        double d => d.ToString(CultureInfo.InvariantCulture),
        decimal m => m.ToString(CultureInfo.InvariantCulture),
        Guid g => g.ToString(),
        _ => Convert.ToString(v, CultureInfo.InvariantCulture) ?? "",
    };

    private async Task<(string Subject, string Body, string ProviderTemplate, bool Active)?> TemplateAsync(string evt, string channel, IUnitOfWork? uow)
    {
        var row = await dal.GetTemplateAsync(evt, channel, uow?.Transaction);
        if (row is not null) return (row.Subject, row.Body, row.ProviderTemplate, row.IsActive);
        if (NotificationEvents.Events.TryGetValue(evt, out var chans) && chans.TryGetValue(channel, out var d)) return (d.Subject, d.Body, "", true);
        return null;
    }

    private static string Cut(string s, int n) => s.Length > n ? s[..n] : s;

    /// <summary>Who is writing and how to reach them, under every email (Admin → Storefront → Business).</summary>
    public static string EmailFooter(BusinessInfo b)
    {
        var lines = new List<string> { b.LegalName, b.RegisteredAddress };
        var contact = string.Join(", ", new[] { b.SupportEmail, b.SupportPhone }.Where(x => x.Length > 0));
        if (contact.Length > 0) lines.Add($"Customer care: {contact}");
        if (b.GrievanceEmail.Length > 0) lines.Add($"Grievance officer: {b.GrievanceName}, {b.GrievanceEmail}".Replace(" , ", " "));
        return "\n\n--\n" + string.Join("\n", lines.Where(x => x.Length > 0));
    }

    public async Task NotifyAsync(string evt, UserModel? user, IDictionary<string, object?> variables, string link = "", IEnumerable<string>? channels = null,
        IUnitOfWork? uow = null)
    {
        if (user is null || user.DeletedAt is not null) return;
        var business = await SiteSettingsReader.PublicBusinessAsync(settings, env);
        var cfg = await integrations.GetAsync();
        var vars = new Dictionary<string, string>
        {
            ["name"] = user.Name.Length > 0 ? user.Name : "there",
            ["brand"] = business.Brand,
            ["link"] = link.StartsWith('/') ? $"{env.PublicWebUrl}{link}" : link,
        };
        foreach (var (k, v) in variables) vars[k] = TextOf(v);
        var now = DateTimeFunctions.UtcNow();
        var pushes = new List<PushItem>();
        foreach (var channel in channels ?? INotifyBAL.AllChannels)
        {
            if (channel == "push")
            {
                // the in-app text, sent to the user's phones and browsers once this change is saved
                var ptpl = await TemplateAsync(evt, "push", uow) ?? await TemplateAsync(evt, "inapp", uow);
                if (ptpl is null || !ptpl.Value.Active || !cfg.PushConfigured) continue;
                var data = new Dictionary<string, string> { ["event"] = evt };
                if (evt is "delivery_new_offer" or "delivery_new_return_pickup") data["urgent"] = "1";
                pushes.Add(new PushItem(user.Id, Cut(Render(ptpl.Value.Subject, vars), 120), Cut(Render(ptpl.Value.Body, vars), 400), link, data));
                continue;
            }
            var tpl = await TemplateAsync(evt, channel, uow);
            if (tpl is null) continue;
            var (subject, body, providerTemplate, active) = tpl.Value;
            if (!active) continue;
            var recipient = "";
            if (channel == "email")
            {
                if (string.IsNullOrEmpty(user.Email) || cfg.SmtpHost.Length == 0) continue;
                recipient = user.Email;
            }
            else if (channel == "sms")
            {
                if (string.IsNullOrEmpty(user.Phone) || cfg.SmsProvider != "msg91" || providerTemplate.Length == 0) continue;
                recipient = user.Phone;
            }
            else if (channel == "whatsapp")
            {
                if (string.IsNullOrEmpty(user.Phone) || cfg.WhatsappToken.Length == 0 || providerTemplate.Length == 0) continue;
                recipient = user.Phone;
            }
            var stored = new JsonObject();
            foreach (var (k, v) in vars) stored[k] = v;
            if (providerTemplate.Length > 0) stored["_template"] = providerTemplate;
            var row = new NotificationModel
            {
                Id = Guid.NewGuid(), UserId = user.Id, Event = evt, Channel = channel, Recipient = recipient,
                Subject = Cut(Render(subject, vars), 200),
                Body = Render(body, vars) + (channel == "email" ? EmailFooter(business) : ""),
                Link = Cut(link, 300), Variables = stored.ToJsonString(), Status = channel == "inapp" ? "sent" : "pending",
                Attempts = 0, Error = "", SentAt = channel == "inapp" ? now : null, CreatedAt = now,
            };
            await dal.InsertAsync(row, uow?.Transaction);
        }
        if (pushes.Count > 0)
        {
            if (uow is not null) uow.AfterCommit(() => DispatchPush(pushes));
            else lock (_pushes) foreach (var p in pushes) _pushes.Add(p);
        }
    }

    public async Task NotifySellerAsync(Guid sellerId, string evt, IDictionary<string, object?> variables, string link = "", IUnitOfWork? uow = null)
    {
        var seller = await db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @sellerId", new { sellerId }, uow?.Transaction);
        if (seller is null) return;
        var user = await accounts.GetUserAsync(seller.UserId, uow?.Transaction);
        await NotifyAsync(evt, user, variables, link, uow: uow);
    }

    public async Task<int> NotifyStaffAsync(string permission, string evt, IDictionary<string, object?> variables, string link = "", IUnitOfWork? uow = null)
    {
        access.Invalidate();
        var told = 0;
        foreach (var u in await staff.ActiveStaffAsync(uow?.Transaction))
        {
            if (!(await access.PermissionsForAsync(u)).Contains(permission)) continue;
            await NotifyAsync(evt, u, variables, link, ["inapp", "push"], uow);
            told++;
        }
        return told;
    }

    // ---------------------------------------------------------------- push after the change is saved

    public void FlushPush()
    {
        List<PushItem> items;
        lock (_pushes)
        {
            items = [.. _pushes];
            _pushes.Clear();
        }
        if (items.Count == 0) return;
        DispatchPush(items);
    }

    private void DispatchPush(IReadOnlyList<PushItem> items)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<IPushBAL>().SendToUsersAsync(items);
            }
            catch (Exception e) { log.LogError(e, "sending push notifications failed"); }
        });
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    /// <summary>Same as <see cref="DisposeAsync"/> (the push hand-off is synchronous), so a scope disposed with a plain
    /// <c>using</c> works too.</summary>
    public void Dispose()
    {
        FlushPush();
        GC.SuppressFinalize(this);
    }

    // ---------------------------------------------------------------- the dispatcher

    public async Task<int> DispatchPendingAsync(int limit = 100)
    {
        await using var uow = await db.BeginAsync();
        var rows = (await dal.PendingForUpdateAsync(limit, uow.Transaction)).ToList();
        var sent = 0;
        var cfg = await integrations.GetAsync();
        foreach (var n in rows)
        {
            n.Attempts += 1;
            var variables = JsonHelper.Object(n.Variables);
            string V(string k) => variables[k] is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : "";
            try
            {
                if (n.Channel == "email") await SendEmailAsync(cfg, n, variables.ContainsKey("brand") ? V("brand") : env.AppName);
                else if (n.Channel == "sms")
                {
                    var vars = variables.Where(kv => !kv.Key.StartsWith('_')).ToDictionary(kv => kv.Key, kv => kv.Value is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : "");
                    await sms.SendMessageAsync(new SMSModel { Phone = n.Recipient, TemplateId = V("_template"), Variables = vars, Message = n.Body },
                        new SmsConfig { Provider = "msg91", AuthKey = cfg.Msg91AuthKey, OtpTemplateId = cfg.Msg91OtpTemplateId, SenderId = cfg.Msg91SenderId, ApiBase = cfg.Msg91ApiBase });
                }
                else if (n.Channel == "whatsapp") await SendWhatsappAsync(cfg, n, V("_template"), V("_params"));
                n.Status = "sent";
                n.SentAt = DateTimeFunctions.UtcNow();
                n.Error = "";
                sent++;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                // provider errors are recorded and retried
                n.Error = Cut(e.Message, 500);
                if (n.Attempts >= 5) n.Status = "failed";
                log.LogWarning("notification {Id} via {Channel} failed: {Message}", n.Id, n.Channel, e.Message);
            }
            await dal.UpdateDeliveryAsync(n, uow.Transaction);
        }
        await uow.CommitAsync();
        return sent;
    }

    private Task SendEmailAsync(Model.DomainModel.Integrations.IntegrationSettings cfg, NotificationModel n, string fromName)
    {
        var sender = cfg.SmtpFrom.Length > 0 ? cfg.SmtpFrom : cfg.SmtpUser;
        var from = sender;
        // a configured "Name <address>" wins; a bare address gets the storefront's brand name
        if (sender.Contains('<') && MimeKit.MailboxAddress.TryParse(sender, out var parsed))
        {
            fromName = parsed.Name;
            from = parsed.Address;
        }
        return mail.SendAsync(
            new EmailModel { To = n.Recipient, Subject = string.Join(' ', n.Subject.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), Body = n.Body, FromName = fromName },
            new MailConfig(cfg.SmtpHost, cfg.SmtpPort, cfg.SmtpUser, cfg.SmtpPassword, from, cfg.SmtpSecurity));
    }

    /// <summary>WhatsApp Cloud API template message; body parameters follow the order of "_params" (or the whole text).</summary>
    private async Task SendWhatsappAsync(Model.DomainModel.Integrations.IntegrationSettings cfg, NotificationModel n, string template, string rawParams)
    {
        var parameters = rawParams.Split('|').Where(p => p.Length > 0).ToList();
        if (parameters.Count == 0) parameters.Add(Cut(n.Body, 1000));
        var client = http.CreateClient("whatsapp");
        client.Timeout = TimeSpan.FromSeconds(15);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.WhatsappApiBase}/{cfg.WhatsappApiVersion}/{cfg.WhatsappPhoneNumberId}/messages")
        {
            Content = JsonContent.Create(new
            {
                messaging_product = "whatsapp",
                to = $"91{n.Recipient}",
                type = "template",
                template = new
                {
                    name = template,
                    language = new { code = cfg.WhatsappLanguage },
                    components = new[] { new { type = "body", parameters = parameters.Select(p => new { type = "text", text = p }).ToArray() } },
                },
            }),
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.WhatsappToken);
        using var r = await client.SendAsync(req);
        if ((int)r.StatusCode >= 400)
        {
            var text = await r.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"WhatsApp {(int)r.StatusCode}: {Cut(text, 200)}");
        }
    }

    // ---------------------------------------------------------------- the customer's own notifications

    public async Task<object> MyNotificationsAsync(UserModel user, int page)
    {
        var rows = await dal.InAppPageAsync(user.Id, (page - 1) * 20, 20);
        var unread = await dal.UnreadCountAsync(user.Id);
        return new
        {
            unread,
            items = rows.Select(n => new
            {
                id = n.Id.ToString(), title = n.Subject, body = n.Body, link = n.Link, read = n.ReadAt is not null, at = DateTimeFunctions.Iso(n.CreatedAt),
            }),
        };
    }

    public Task MarkAllReadAsync(UserModel user) => dal.MarkAllReadAsync(user.Id, DateTimeFunctions.UtcNow());
}
