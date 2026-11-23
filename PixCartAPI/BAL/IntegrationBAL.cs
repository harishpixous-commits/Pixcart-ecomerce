using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using MimeKit;
using Model.Constants;
using Model.DomainModel;
using Model.DomainModel.Integrations;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IIntegrationBAL"/>
public class IntegrationBAL(
    SettingsDAL settingsDal, IntegrationDAL dal, IMySqlDapperHelper db, AppSettings env, EncryptDecrypt crypto, IHttpClientFactory http,
    IStepUpBAL stepUp, IRateLimitBAL limits, IAuditBAL audit, ILogger<IntegrationBAL> log) : IIntegrationBAL
{
    private const string RowKey = "integrations";
    private const double TtlSeconds = 15;
    private static readonly object Gate = new();
    private static (long At, JsonObject Raw)? _cache;

    /// <summary>The named HttpClient used for connection tests (tests replace its handler).</summary>
    public const string HttpClientName = "integrations";

    public void Invalidate()
    {
        lock (Gate) _cache = null;
    }

    private async Task<JsonObject> RawAsync()
    {
        lock (Gate)
        {
            if (!env.IsTest && _cache is { } c && Stopwatch.GetElapsedTime(c.At).TotalSeconds < TtlSeconds) return (JsonObject)c.Raw.DeepClone();
        }
        var raw = await settingsDal.GetAsync(RowKey);
        lock (Gate) _cache = (Stopwatch.GetTimestamp(), (JsonObject)raw.DeepClone());
        return raw;
    }

    // ---------------------------------------------------------------- effective settings

    private static readonly PropertyInfo[] EnvProps = typeof(AppSettings).GetProperties();

    /// <summary>The settings from appsettings alone (no admin overrides).</summary>
    private IntegrationSettings FromEnvironment()
    {
        var s = new IntegrationSettings();
        foreach (var p in EnvProps)
        {
            var name = IntegrationSettings.ToSnake(p.Name);
            if (IntegrationSettings.Has(name) && p.CanRead) s.Set(name, p.GetValue(env));
        }
        return s;
    }

    private static object? EnvDefault(string setting)
    {
        var defaults = new AppSettings();
        var p = EnvProps.FirstOrDefault(x => IntegrationSettings.ToSnake(x.Name) == setting);
        return p?.GetValue(defaults);
    }

    private object? EnvValue(string setting)
    {
        var p = EnvProps.FirstOrDefault(x => IntegrationSettings.ToSnake(x.Name) == setting);
        return p is not null ? p.GetValue(env) : FromEnvironment().Get(setting) ?? "";
    }

    /// <summary>(value, ok): a secret that no longer decrypts (key rotated) counts as not set.</summary>
    private (JsonNode? Value, bool Ok) Decrypt(JsonNode? stored)
    {
        if (stored is JsonObject o && o.ContainsKey("enc"))
        {
            var value = crypto.Decrypt(o["enc"]?.GetValue<string>());
            if (value.Length == 0)
            {
                log.LogWarning("integration secret could not be decrypted; re-enter it in the admin panel");
                return (JsonValue.Create(""), false);
            }
            return (JsonValue.Create(value), true);
        }
        return (stored?.DeepClone(), true);
    }

    private Dictionary<string, object?> Overrides(JsonObject raw)
    {
        var outp = new Dictionary<string, object?>();
        foreach (var p in IntegrationRegistry.Providers)
        {
            var entry = raw[p.Key] as JsonObject ?? [];
            if (entry["values"] is JsonObject values)
            {
                foreach (var (key, stored) in values)
                {
                    var f = p.Field(key);
                    if (f is null) continue;
                    var (value, ok) = Decrypt(stored);
                    if (ok) outp[f.Setting] = value;
                }
            }
            var enabled = entry["enabled"];
            if (enabled?.GetValueKind() == JsonValueKind.True) foreach (var (k, v) in p.On) outp[k] = v;
            else if (enabled?.GetValueKind() == JsonValueKind.False) foreach (var (k, v) in p.Off) outp[k] = v;
        }
        return outp;
    }

    private IntegrationSettings Effective(JsonObject raw)
    {
        var s = FromEnvironment();
        foreach (var (k, v) in Overrides(raw)) s.Set(k, v);
        return s;
    }

    public async Task<IntegrationSettings> GetAsync() => Effective(await RawAsync());

    // ---------------------------------------------------------------- admin view

    private static string Hint(string value) => value.Length >= 10 ? "••••" + value[^4..] : "••••";

    private static bool Truthy(object? v) => v switch
    {
        null => false,
        string s => s.Length > 0,
        bool b => b,
        int i => i != 0,
        long l => l != 0,
        double d => d != 0,
        _ => true,
    };

    private static string PyStr(object? v) => v switch
    {
        null => "None",
        bool b => b ? "True" : "False",
        double d => d.ToString(CultureInfo.InvariantCulture),
        _ => Convert.ToString(v, CultureInfo.InvariantCulture) ?? "",
    };

    /// <summary>Whether the provider counts as on when nobody has used its switch (registry.default_switch).</summary>
    private bool DefaultSwitch(ProviderDef p)
    {
        foreach (var part in p.DefaultOn.Split('|'))
        {
            if (part.Contains("=="))
            {
                var bits = part.Split("==", 2);
                if (PyStr(EnvValue(bits[0])) == bits[1]) return true;
            }
            else if (part.Length > 0 && Truthy(EnvValue(part))) return true;
        }
        return false;
    }

    private static bool IsEmpty(object? v) => v is null || (v is string s && s.Length == 0) || (v is JsonValue j && j.GetValueKind() == JsonValueKind.String && j.GetValue<string>().Length == 0)
                                                || (v is JsonNode n && n.GetValueKind() == JsonValueKind.Null);

    private static object? Plain(JsonNode? n) => n?.GetValueKind() switch
    {
        null or JsonValueKind.Null => null,
        JsonValueKind.String => n.GetValue<string>(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => n.ToJsonString().Contains('.') || n.ToJsonString().Contains('e') ? n.GetValue<double>() : n.GetValue<long>(),
        _ => n.DeepClone(),
    };

    private Dictionary<string, object?> ProviderStatus(ProviderDef p, JsonObject raw)
    {
        var entry = raw[p.Key] as JsonObject ?? [];
        var saved = entry["values"] as JsonObject ?? [];
        var fields = new List<Dictionary<string, object?>>();
        var missing = new List<string>();
        foreach (var f in p.Fields)
        {
            var source = "";
            object? value = null;
            var undecryptable = false;
            if (saved.ContainsKey(f.Key))
            {
                var (v, ok) = Decrypt(saved[f.Key]);
                value = Plain(v);
                source = ok ? "admin" : "";
                undecryptable = !ok;
            }
            if (source.Length == 0)
            {
                var envValue = EnvValue(f.Setting);
                value = envValue; // a built-in default is shown but does not count as configured
                if (!IsEmpty(envValue) && !Equals(envValue, EnvDefault(f.Setting))) source = "environment";
            }
            var isSet = source.Length > 0 && !IsEmpty(value);
            if (f.Required && !isSet) missing.Add(f.Label);
            var item = new Dictionary<string, object?>
            {
                ["key"] = f.Key, ["label"] = f.Label, ["kind"] = f.Kind, ["required"] = f.Required, ["options"] = f.Options, ["help"] = f.Help,
                ["placeholder"] = f.Placeholder, ["pattern_hint"] = f.PatternHint, ["min"] = f.Min, ["max"] = f.Max, ["set"] = isSet, ["source"] = source,
                ["undecryptable"] = undecryptable,
            };
            if (f.Secret) item["hint"] = isSet ? Hint(PyStr(value)) : "";
            else item["value"] = value ?? "";
            fields.Add(item);
        }
        var (enabled, switchSource) = entry["enabled"]?.GetValueKind() is JsonValueKind.True or JsonValueKind.False
            ? (entry["enabled"]!.GetValue<bool>(), "admin")
            : (DefaultSwitch(p), "environment");
        var eff = Effective(raw);
        var mode = "";
        if (p.Key == "razorpay" && eff.RazorpayKeyId.Length > 0) mode = eff.RazorpayKeyId.StartsWith("rzp_live_") ? "live" : "test";
        var warnings = new List<string>();
        if (p.Key == "razorpayx" && enabled && !eff.RazorpayEnabled)
            warnings.Add("RazorpayX uses the Razorpay API keys. Fill them in under Razorpay payments first.");
        if (p.Key == "razorpay" && mode == "test" && env.IsProduction)
            warnings.Add("Test keys: payments are not real. Switch to live keys before launch.");
        return new Dictionary<string, object?>
        {
            ["key"] = p.Key, ["name"] = p.Name, ["group"] = p.Group, ["purpose"] = p.Purpose, ["docs_url"] = p.DocsUrl, ["setup_steps"] = p.SetupSteps,
            ["needed_for_launch"] = p.NeededForLaunch, ["testable"] = p.Testable, ["restart_note"] = p.RestartNote,
            ["webhook_url"] = p.WebhookPath.Length > 0 ? env.PublicWebUrl.TrimEnd('/') + p.WebhookPath : "",
            ["webhook_events"] = p.WebhookEvents,
            ["enabled"] = enabled, ["switch_source"] = switchSource, ["ready"] = enabled && missing.Count == 0, ["missing"] = missing, ["mode"] = mode,
            ["warnings"] = warnings, ["fields"] = fields, ["last_test"] = entry["last_test"]?.DeepClone(), ["updated_at"] = entry["updated_at"]?.DeepClone(),
            ["updated_by"] = entry["updated_by"]?.DeepClone() ?? JsonValue.Create(""),
        };
    }

    public async Task<List<Dictionary<string, object?>>> StatusAsync()
    {
        var raw = await RawAsync();
        var last = await dal.LastWebhooksAsync();
        var outp = new List<Dictionary<string, object?>>();
        foreach (var p in IntegrationRegistry.Providers)
        {
            var item = ProviderStatus(p, raw);
            item["last_webhook"] = last.TryGetValue(p.Key, out var hit) && p.WebhookPath.Length > 0
                ? new Dictionary<string, object?> { ["at"] = DateTimeFunctions.Iso(hit.At), ["count"] = hit.Count }
                : null;
            outp.Add(item);
        }
        return outp;
    }

    // ---------------------------------------------------------------- writes

    private static string Canon(object? v) => v is JsonNode n ? n.ToJsonString() : JsonSerializer.Serialize(v);

    public async Task<List<string>> SaveAsync(string providerKey, JsonObject values, IReadOnlyList<string> clear, bool? enabled, string actorName)
    {
        if (!IntegrationRegistry.ByKey.TryGetValue(providerKey, out var p)) throw new AppException("Unknown integration", "invalid_integration");
        await using var uow = await db.BeginAsync();
        var data = await dal.GetSettingForUpdateAsync(RowKey, uow.Transaction);
        var entry = data[p.Key] as JsonObject is { } e ? (JsonObject)e.DeepClone() : [];
        var stored = entry["values"] as JsonObject is { } sv ? (JsonObject)sv.DeepClone() : [];
        var changed = new List<string>();
        foreach (var (key, value) in values)
        {
            var f = p.Field(key) ?? throw new AppException($"Unknown field: {key}", "invalid_integration");
            if (f.Secret && (value is null || value.GetValueKind() == JsonValueKind.Null ||
                             (value.GetValueKind() == JsonValueKind.String && value.GetValue<string>().Trim().Length == 0)))
                continue; // an empty secret box means "keep what is saved"
            object clean;
            try
            {
                clean = f.Validate(value);
            }
            catch (ArgumentException ex)
            {
                throw new AppException(ex.Message, "invalid_integration");
            }
            JsonNode newNode = f.Secret ? new JsonObject { ["enc"] = crypto.Encrypt((string)clean) } : JsonValue.Create(clean)!;
            var oldValue = stored.ContainsKey(key) ? Decrypt(stored[key]).Value : null;
            if (!stored.ContainsKey(key) || Canon(oldValue) != Canon(JsonSerializer.SerializeToNode(clean))) changed.Add(key);
            stored[key] = newNode;
        }
        foreach (var key in clear)
        {
            if (p.Field(key) is null) throw new AppException($"Unknown field: {key}", "invalid_integration");
            if (stored.Remove(key)) changed.Add(key);
        }
        entry["values"] = stored;
        var current = entry["enabled"];
        if (enabled is { } en && !(current?.GetValueKind() is JsonValueKind.True or JsonValueKind.False && current.GetValue<bool>() == en))
        {
            entry["enabled"] = en;
            changed.Add("enabled");
        }
        data[p.Key] = entry;
        var now = ProviderStatus(p, data);
        if ((bool)now["enabled"]! && ((List<string>)now["missing"]!).Count > 0)
            throw new AppException($"Fill in {string.Join(", ", (List<string>)now["missing"]!)} before switching {p.Name} on", "invalid_integration");
        if (changed.Count > 0)
        {
            entry["updated_at"] = DateTimeFunctions.Iso(DateTimeFunctions.UtcNow());
            entry["updated_by"] = actorName.Length > 80 ? actorName[..80] : actorName;
            entry.Remove("last_test"); // an old test result no longer describes these settings
        }
        await dal.SaveSettingAsync(RowKey, data, uow.Transaction);
        if (p.Key == "shiprocket" && changed.Count > 0) await dal.DeleteTokenAsync("shiprocket"); // log in again with the new user
        await uow.CommitAsync();
        Invalidate();
        return changed;
    }

    public async Task<JsonObject> RecordTestAsync(string providerKey, bool ok, string message)
    {
        await using var uow = await db.BeginAsync();
        var data = await dal.GetSettingForUpdateAsync(RowKey, uow.Transaction);
        var entry = data[providerKey] as JsonObject is { } e ? (JsonObject)e.DeepClone() : [];
        var last = new JsonObject { ["ok"] = ok, ["message"] = message.Length > 300 ? message[..300] : message, ["at"] = DateTimeFunctions.Iso(DateTimeFunctions.UtcNow()) };
        entry["last_test"] = last.DeepClone();
        data[providerKey] = entry;
        await dal.SaveSettingAsync(RowKey, data, uow.Transaction);
        await uow.CommitAsync();
        Invalidate();
        return last;
    }

    // ---------------------------------------------------------------- endpoints

    /// <summary>Set by the hosting (IIS, appsettings), not in the admin panel; shown so the checklist is complete.</summary>
    private List<Dictionary<string, object?>> Infrastructure()
    {
        var https = env.PublicWebUrl.StartsWith("https://");
        var remote = env.StorageBackend != "local";
        return
        [
            new() { ["key"] = "domain", ["name"] = "Domain and HTTPS", ["ready"] = https, ["detail"] = env.PublicWebUrl,
                ["how"] = "Terraform: domain_name, Route 53 zone and the ACM certificate (docs/GO_LIVE.md step 3)." },
            new() { ["key"] = "storage", ["name"] = "Cloud storage for images and KYC files", ["ready"] = remote,
                ["detail"] = remote ? (env.StorageBackend == "ftp" ? "FTP server" : env.StorageBackend) : "Local disk (development only)",
                ["how"] = "Terraform creates the S3 buckets and sets STORAGE_BACKEND=s3." },
            new() { ["key"] = "secrets", ["name"] = "Server secrets (JWT, encryption key, database)",
                ["ready"] = !env.IsProduction || !env.JwtSecret.StartsWith("dev-only"),
                ["detail"] = "Generated by Terraform in AWS Secrets Manager", ["how"] = "Nothing to do; Terraform generates them." },
        ];
    }

    public async Task<object> ListAsync() => new Dictionary<string, object?>
    {
        ["environment"] = env.Environment, ["groups"] = IntegrationRegistry.GroupLabels, ["items"] = await StatusAsync(), ["infrastructure"] = Infrastructure(),
    };

    public async Task<object> SaveFromAdminAsync(UserModel admin, string key, JsonObject values, IReadOnlyList<string> clear, bool? enabled, string password, string totp)
    {
        if (!IntegrationRegistry.ByKey.ContainsKey(key)) throw new AppException("Unknown integration", "not_found", 404);
        await stepUp.ConfirmIdentityAsync(admin, password, totp, "integrations-save");
        var actor = admin.Name.Length > 0 ? admin.Name : admin.Email ?? "";
        var changed = await SaveAsync(key, values, clear, enabled, actor);
        // field names only; values (and secrets) never reach the audit log
        await audit.AuditAsync(admin, "integration.update", "integration", key, changed.Count > 0 ? string.Join(", ", changed) : "no change");
        var items = await StatusAsync();
        return new Dictionary<string, object?> { ["changed"] = changed, ["item"] = items.First(i => (string)i["key"]! == key) };
    }

    public async Task<JsonObject> TestFromAdminAsync(UserModel admin, string key, string phone, string to)
    {
        if (!IntegrationRegistry.ByKey.ContainsKey(key)) throw new AppException("Unknown integration", "not_found", 404);
        await limits.RateLimitAsync($"integrations-test:{admin.Id}", 20, 600);
        var cfg = await GetAsync();
        var parameters = new Dictionary<string, string> { ["phone"] = phone };
        if (key == "email")
        {
            parameters["to"] = to.Length > 0 ? to : admin.Email ?? "";
            parameters["brand"] = await SiteSettingsReader.BrandNameAsync(settingsDal, env);
        }
        if (key == "ai")
        {
            var ai = await settingsDal.GetAsync("ai");
            parameters["model"] = ai["model"] is JsonValue mv && mv.TryGetValue<string>(out var m) ? m : env.AiModel;
        }
        var result = await RunCheckAsync(key, cfg, parameters);
        var last = await RecordTestAsync(key, result.Ok, result.Message);
        await audit.AuditAsync(admin, "integration.test", "integration", key, result.Ok ? "ok" : "failed");
        return last;
    }

    // ---------------------------------------------------------------- connection checks (integrations/checks.py)

    private HttpClient Client()
    {
        var c = http.CreateClient(HttpClientName);
        c.Timeout = TimeSpan.FromSeconds(10);
        return c;
    }

    private static string Err(string text)
    {
        try
        {
            var data = JsonNode.Parse(text);
            if (data is JsonObject o)
            {
                var e = o["error"];
                if (e is JsonObject eo) return Cut(Str(eo["description"]) is { Length: > 0 } d ? d : Str(eo["message"]), 160);
                var msg = Str(o["message"]);
                return Cut(msg.Length > 0 ? msg : e is null ? "" : Str(e), 160);
            }
            return "";
        }
        catch (JsonException)
        {
            return Cut(text, 160);
        }
    }

    private static string Str(JsonNode? n) => n is null ? "" : n.GetValueKind() == JsonValueKind.String ? n.GetValue<string>() : n.ToJsonString();

    private static string Cut(string s, int n) => s.Length > n ? s[..n] : s;

    private static string Url(string baseUrl, string path) => baseUrl.TrimEnd('/') + path;

    private static AuthenticationHeaderValue Basic(string user, string pass) =>
        new("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{user}:{pass}")));

    public async Task<CheckResult> RunCheckAsync(string providerKey, IntegrationSettings cfg, IReadOnlyDictionary<string, string> parameters)
    {
        string P(string k) => parameters.TryGetValue(k, out var v) ? v : "";
        try
        {
            return providerKey switch
            {
                "razorpay" => await CheckRazorpay(cfg),
                "razorpayx" => await CheckRazorpayx(cfg),
                "msg91" => await CheckMsg91(cfg, P("phone")),
                "email" => await CheckEmail(cfg, P("to"), P("brand")),
                "whatsapp" => await CheckWhatsapp(cfg),
                "firebase" => await CheckFirebase(cfg),
                "shiprocket" => await CheckShiprocket(cfg),
                "ai" => await CheckAi(cfg, P("model")),
                "sentry" => await CheckSentry(cfg),
                _ => new CheckResult(false, "This integration has no connection test."),
            };
        }
        catch (TaskCanceledException)
        {
            return new CheckResult(false, "The provider did not answer within 10 seconds. Try again in a minute.");
        }
        catch (HttpRequestException ex)
        {
            log.LogWarning("integration check {Key} failed: {Message}", providerKey, ex.Message);
            return new CheckResult(false, "Could not reach the provider from this server. Check outbound internet access (NAT gateway).");
        }
    }

    private async Task<CheckResult> CheckRazorpay(IntegrationSettings cfg)
    {
        if (!cfg.RazorpayEnabled) return new CheckResult(false, "Enter the Key ID and Key secret first.");
        using var req = new HttpRequestMessage(HttpMethod.Get, Url(cfg.RazorpayApiBase, "/orders?count=1"));
        req.Headers.Authorization = Basic(cfg.RazorpayKeyId, cfg.RazorpayKeySecret);
        using var r = await Client().SendAsync(req);
        var text = await r.Content.ReadAsStringAsync();
        if ((int)r.StatusCode == 401) return new CheckResult(false, "Razorpay rejected the Key ID or Key secret. Copy both again from the dashboard.");
        if ((int)r.StatusCode >= 400) return new CheckResult(false, $"Razorpay answered {(int)r.StatusCode}: {Err(text)}");
        var mode = cfg.RazorpayKeyId.StartsWith("rzp_test_") ? "test" : "live";
        var extra = cfg.RazorpayWebhookSecret.Length > 0 ? "" : " Add the webhook secret too.";
        return new CheckResult(true, $"Connected to Razorpay in {mode} mode.{extra}");
    }

    private async Task<CheckResult> CheckRazorpayx(IntegrationSettings cfg)
    {
        if (!cfg.RazorpayEnabled) return new CheckResult(false, "RazorpayX uses the Razorpay API keys. Fill them in under Razorpay payments first.");
        if (cfg.RazorpayxAccountNumber.Length == 0) return new CheckResult(false, "Enter your RazorpayX account number first.");
        using var req = new HttpRequestMessage(HttpMethod.Get,
            Url(cfg.RazorpayApiBase, $"/transactions?account_number={Uri.EscapeDataString(cfg.RazorpayxAccountNumber)}&count=1"));
        req.Headers.Authorization = Basic(cfg.RazorpayKeyId, cfg.RazorpayKeySecret);
        using var r = await Client().SendAsync(req);
        var text = await r.Content.ReadAsStringAsync();
        if ((int)r.StatusCode == 401) return new CheckResult(false, "RazorpayX rejected the API keys.");
        if ((int)r.StatusCode >= 400)
            return new CheckResult(false, $"RazorpayX answered {(int)r.StatusCode}: {Err(text)}. Check the account number and that this server's IP is allowlisted.");
        return new CheckResult(true, "Connected to RazorpayX. Payouts will be sent from this account.");
    }

    private async Task<CheckResult> CheckMsg91(IntegrationSettings cfg, string phone)
    {
        if (cfg.Msg91AuthKey.Length == 0 || cfg.Msg91OtpTemplateId.Length == 0) return new CheckResult(false, "Enter the auth key and OTP template ID first.");
        if (phone.Length == 0) return new CheckResult(false, "Enter your 10-digit mobile number to receive a test OTP.");
        using var req = new HttpRequestMessage(HttpMethod.Post,
            Url(cfg.Msg91ApiBase, $"/api/v5/otp?template_id={Uri.EscapeDataString(cfg.Msg91OtpTemplateId)}&mobile=91{phone}&otp=123456"));
        req.Headers.Add("authkey", cfg.Msg91AuthKey);
        req.Headers.Add("accept", "application/json");
        using var r = await Client().SendAsync(req);
        var text = await r.Content.ReadAsStringAsync();
        var bodyType = "";
        try
        {
            bodyType = JsonNode.Parse(text) is JsonObject o ? Str(o["type"]) : "";
        }
        catch (JsonException)
        {
        }
        if ((int)r.StatusCode >= 400 || bodyType == "error")
        {
            var e = Err(text);
            return new CheckResult(false, $"MSG91 did not send the SMS: {(e.Length > 0 ? e : ((int)r.StatusCode).ToString())}");
        }
        return new CheckResult(true, $"MSG91 accepted the test OTP 123456 for {phone[..2]}••••{phone[^2..]}. It should arrive within a minute.");
    }

    private async Task<CheckResult> CheckEmail(IntegrationSettings cfg, string to, string brand)
    {
        if (cfg.SmtpHost.Length == 0 || cfg.SmtpFrom.Length == 0) return new CheckResult(false, "Enter the SMTP host and sender address first.");
        brand = brand.Length > 0 ? brand : cfg.AppName;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        try
        {
            using var smtp = new SmtpClient { Timeout = 15000 };
            var security = cfg.SmtpSecurity switch { "ssl" => SecureSocketOptions.SslOnConnect, "starttls" => SecureSocketOptions.StartTls, _ => SecureSocketOptions.None };
            await smtp.ConnectAsync(cfg.SmtpHost, cfg.SmtpPort, security, cts.Token);
            if (cfg.SmtpUser.Length > 0) await smtp.AuthenticateAsync(cfg.SmtpUser, cfg.SmtpPassword, cts.Token);
            if (to.Length > 0)
            {
                var msg = new MimeMessage();
                var sender = cfg.SmtpFrom.Length > 0 ? cfg.SmtpFrom : cfg.SmtpUser;
                msg.From.Add(sender.Contains('<') ? MailboxAddress.Parse(sender) : new MailboxAddress(brand, sender));
                msg.To.Add(MailboxAddress.Parse(to));
                msg.Subject = $"{brand}: test email";
                msg.Body = new TextPart("plain") { Text = "This is a test email from Admin → Integrations. Email is working." };
                await smtp.SendAsync(FormatOptions.Default, new MailKit.SendRequest(msg), cts.Token);
            }
            await smtp.DisconnectAsync(true, cts.Token);
        }
        catch (AuthenticationException)
        {
            return new CheckResult(false, "The SMTP server rejected the user or password.");
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            var m = ex.Message.Length > 0 ? Cut(ex.Message, 160) : ex.GetType().Name;
            return new CheckResult(false, $"Could not reach the SMTP server: {m}");
        }
        return new CheckResult(true, $"Signed in to {cfg.SmtpHost}." + (to.Length > 0 ? $" A test email was sent to {to}." : ""));
    }

    private async Task<CheckResult> CheckWhatsapp(IntegrationSettings cfg)
    {
        if (cfg.WhatsappToken.Length == 0 || cfg.WhatsappPhoneNumberId.Length == 0) return new CheckResult(false, "Enter the phone number ID and token first.");
        using var req = new HttpRequestMessage(HttpMethod.Get,
            Url(cfg.WhatsappApiBase, $"/{cfg.WhatsappApiVersion}/{cfg.WhatsappPhoneNumberId}?fields=display_phone_number,verified_name"));
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.WhatsappToken);
        using var r = await Client().SendAsync(req);
        var text = await r.Content.ReadAsStringAsync();
        if ((int)r.StatusCode >= 400) return new CheckResult(false, $"WhatsApp answered {(int)r.StatusCode}: {Err(text)}");
        var data = JsonNode.Parse(text) as JsonObject ?? [];
        var name = Str(data["verified_name"]);
        var number = data["display_phone_number"] is null ? "number verified" : Str(data["display_phone_number"]);
        return new CheckResult(true, $"Connected to {(name.Length > 0 ? name : "your business")} ({number}).");
    }

    private async Task<CheckResult> CheckShiprocket(IntegrationSettings cfg)
    {
        if (cfg.ShiprocketEmail.Length == 0 || cfg.ShiprocketPassword.Length == 0) return new CheckResult(false, "Enter the API user email and password first.");
        using var r = await Client().PostAsJsonAsync(Url(cfg.ShiprocketApiBase, "/auth/login"), new { email = cfg.ShiprocketEmail, password = cfg.ShiprocketPassword });
        var text = await r.Content.ReadAsStringAsync();
        var isJson = r.Content.Headers.ContentType?.MediaType?.StartsWith("application/json") == true;
        var hasToken = false;
        if (isJson)
        {
            try { hasToken = JsonNode.Parse(text) is JsonObject o && o.ContainsKey("token"); } catch (JsonException) { }
        }
        if ((int)r.StatusCode >= 400 || !hasToken)
        {
            var e = Err(text);
            return new CheckResult(false, $"Shiprocket login failed: {(e.Length > 0 ? e : ((int)r.StatusCode).ToString())}. Use the API user, not your own login.");
        }
        return new CheckResult(true, "Signed in to Shiprocket.");
    }

    private async Task<CheckResult> CheckAi(IntegrationSettings cfg, string model)
    {
        if (cfg.AnthropicApiKey.Length == 0) return new CheckResult(false, "Enter the API key first.");
        using var req = new HttpRequestMessage(HttpMethod.Get, Url(cfg.AnthropicApiBase, "/v1/models?limit=100"));
        req.Headers.Add("x-api-key", cfg.AnthropicApiKey);
        req.Headers.Add("anthropic-version", "2023-06-01");
        using var r = await Client().SendAsync(req);
        var text = await r.Content.ReadAsStringAsync();
        if ((int)r.StatusCode == 401) return new CheckResult(false, "Anthropic rejected the API key. Create a new key at console.anthropic.com.");
        if ((int)r.StatusCode >= 400) return new CheckResult(false, $"Anthropic answered {(int)r.StatusCode}: {Err(text)}");
        var ids = (JsonNode.Parse(text)?["data"] as JsonArray ?? []).Select(m => Str(m?["id"])).ToList();
        if (model.Length > 0 && ids.Count > 0 && !ids.Contains(model))
            return new CheckResult(false, $"Connected, but the model chosen in AI studio ({model}) is not available to this key. Pick another model there.");
        return new CheckResult(true, "Connected to Claude." + (model.Length > 0 ? $" Model {model} is available." : ""));
    }

    /// <summary>Sends one test event to Sentry's envelope endpoint (the .NET stack has no Sentry SDK running).</summary>
    private async Task<CheckResult> CheckSentry(IntegrationSettings cfg)
    {
        if (cfg.SentryDsn.Length == 0) return new CheckResult(false, "Enter the DSN first.");
        try
        {
            var dsn = new Uri(cfg.SentryDsn);
            var key = dsn.UserInfo.Split(':')[0];
            var project = dsn.AbsolutePath.Trim('/');
            var eventId = Guid.NewGuid().ToString("N");
            var body = $"{{\"event_id\":\"{eventId}\"}}\n{{\"type\":\"event\"}}\n" +
                       JsonSerializer.Serialize(new { event_id = eventId, message = "Test event from Admin → Integrations", level = "info", platform = "csharp", environment = cfg.Environment }) + "\n";
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{dsn.Scheme}://{dsn.Authority}/api/{project}/envelope/")
            {
                Content = new StringContent(body, Encoding.UTF8, "application/x-sentry-envelope"),
            };
            req.Headers.TryAddWithoutValidation("X-Sentry-Auth", $"Sentry sentry_version=7, sentry_key={key}, sentry_client=pixcart-dotnet/1.0");
            using var r = await Client().SendAsync(req);
            if ((int)r.StatusCode >= 400) return new CheckResult(false, $"Could not send a test event: Sentry answered {(int)r.StatusCode}");
        }
        catch (Exception ex) when (ex is UriFormatException or HttpRequestException or TaskCanceledException)
        {
            return new CheckResult(false, $"Could not send a test event: {Cut(ex.Message, 160)}");
        }
        return new CheckResult(true, "A test event was sent. It shows up in Sentry → Issues within a minute.");
    }

    private async Task<CheckResult> CheckFirebase(IntegrationSettings cfg)
    {
        if (!cfg.PushConfigured) return new CheckResult(false, "Enter the project ID, service account email and private key first.");
        try
        {
            FcmClient.Reset(); // always ask Google again
            await FcmClient.AccessTokenAsync(http.CreateClient(PushBAL.HttpClientName), cfg);
        }
        catch (FormatException ex)
        {
            return new CheckResult(false, $"The private key could not be read: {Cut(ex.Message, 120)}. Copy private_key from the JSON file again.");
        }
        catch (InvalidOperationException ex)
        {
            return new CheckResult(false, Cut(ex.Message, 200));
        }
        return new CheckResult(true, $"Signed in to Firebase project {cfg.FirebaseProjectId}. Devices can now receive push notifications.");
    }
}
