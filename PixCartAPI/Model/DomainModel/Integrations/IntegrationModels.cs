using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Model.DomainModel.Integrations;

/// <summary>One field of a provider in Admin → Integrations.</summary>
public sealed class FieldDef
{
    public string Key { get; init; } = "";
    public string Label { get; init; } = "";
    /// <summary>The setting this field overrides, snake_case ("razorpay_key_id").</summary>
    public string Setting { get; init; } = "";
    /// <summary>text, secret, email, url, number, select or bool.</summary>
    public string Kind { get; init; } = "text";
    public bool Required { get; init; }
    /// <summary>Full-match regular expression for text values.</summary>
    public string? Pattern { get; init; }
    public string PatternHint { get; init; } = "";
    public string[] Options { get; init; } = [];
    public string Help { get; init; } = "";
    public string Placeholder { get; init; } = "";
    public double? Min { get; init; }
    public double? Max { get; init; }
    /// <summary>Longest text accepted (a service-account private key needs more).</summary>
    public int MaxLen { get; init; } = 500;
    public bool Secret => Kind == "secret";

    /// <summary>The cleaned value, or an <see cref="ArgumentException"/> with a message an admin can act on (registry.validate_value).</summary>
    public object Validate(JsonNode? value)
    {
        var kindOf = value?.GetValueKind();
        if (Kind == "bool")
        {
            if (kindOf is not (System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False)) throw new ArgumentException($"{Label}: choose on or off");
            return value!.GetValue<bool>();
        }
        if (Kind == "number")
        {
            double num;
            var isRate = Setting.EndsWith("rate");
            try
            {
                if (kindOf == System.Text.Json.JsonValueKind.Number) num = value!.GetValue<double>();
                else if (kindOf == System.Text.Json.JsonValueKind.String)
                    num = isRate ? double.Parse(value!.GetValue<string>().Trim(), CultureInfo.InvariantCulture) : int.Parse(value!.GetValue<string>().Trim(), CultureInfo.InvariantCulture);
                else if (kindOf is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False) num = value!.GetValue<bool>() ? 1 : 0;
                else throw new FormatException();
            }
            catch (Exception e) when (e is FormatException or OverflowException or InvalidOperationException)
            {
                throw new ArgumentException($"{Label}: enter a number");
            }
            if (!isRate) num = Math.Truncate(num);
            if ((Min is { } lo && num < lo) || (Max is { } hi && num > hi))
                throw new ArgumentException($"{Label}: must be between {G(Min)} and {G(Max)}");
            return isRate ? num : (object)(long)num;
        }
        if (kindOf != System.Text.Json.JsonValueKind.String) throw new ArgumentException($"{Label}: enter text");
        var v = StripControl(value!.GetValue<string>());
        if (v.Any(c => c < 32)) throw new ArgumentException($"{Label}: remove line breaks and hidden characters");
        if (v.Length > MaxLen) throw new ArgumentException($"{Label}: too long");
        if (Kind == "select" && !Options.Contains(v)) throw new ArgumentException($"{Label}: choose one of {string.Join(", ", Options)}");
        if (Kind == "email" && v.Length > 0 && !Regex.IsMatch(v, @"^[^@\s<>]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")) throw new ArgumentException($"{Label}: enter an email address");
        if (Kind == "url" && v.Length > 0 && !v.StartsWith("https://")) throw new ArgumentException($"{Label}: must start with https://");
        if (Pattern is not null && v.Length > 0 && !Regex.IsMatch(v, $"^(?:{Pattern})$")) throw new ArgumentException($"{Label}: {(PatternHint.Length > 0 ? PatternHint : "check the format")}");
        return v;
    }

    /// <summary>Python's "%g" for the limits in messages (1 → "1", 0.5 → "0.5").</summary>
    private static string G(double? v) => v is null ? "None" : v.Value.ToString("G6", CultureInfo.InvariantCulture);

    /// <summary>str.strip(): whitespace and control characters at both ends.</summary>
    private static string StripControl(string s) => s.Trim().Trim('\x1c', '\x1d', '\x1e', '\x1f', '\x0b', '\x0c');
}

/// <summary>A provider in Admin → Integrations (Razorpay, MSG91, email ...).</summary>
public sealed class ProviderDef
{
    public string Key { get; init; } = "";
    public string Name { get; init; } = "";
    /// <summary>payments, messaging, shipping, ai or monitoring.</summary>
    public string Group { get; init; } = "";
    public string Purpose { get; init; } = "";
    public FieldDef[] Fields { get; init; } = [];
    public string DocsUrl { get; init; } = "";
    public string[] SetupSteps { get; init; } = [];
    public bool NeededForLaunch { get; init; }
    /// <summary>Settings forced when switched on.</summary>
    public Dictionary<string, object> On { get; init; } = [];
    /// <summary>Settings forced when switched off.</summary>
    public Dictionary<string, object> Off { get; init; } = [];
    /// <summary>Settings expression deciding the switch when the admin never touched it ("smtp_host", "payout_mode==razorpayx").</summary>
    public string DefaultOn { get; init; } = "";
    public string WebhookPath { get; init; } = "";
    public string[] WebhookEvents { get; init; } = [];
    public bool Testable { get; init; } = true;
    public string RestartNote { get; init; } = "";

    public FieldDef? Field(string key) => Fields.FirstOrDefault(f => f.Key == key);
}

/// <summary>
/// The provider settings in effect: appsettings (section "App") with the values saved in Admin → Integrations on top.
/// Other modules read keys only from here (IIntegrationBAL.GetAsync), never from AppSettings directly.
/// </summary>
public sealed class IntegrationSettings
{
    public string Environment { get; set; } = "development";
    public string AppName { get; set; } = "PixCart";
    public string PublicWebUrl { get; set; } = "";

    // SMS (MSG91)
    public string SmsProvider { get; set; } = "console";
    public string Msg91AuthKey { get; set; } = "";
    public string Msg91OtpTemplateId { get; set; } = "";
    public string Msg91SenderId { get; set; } = "";
    public string Msg91DltEntityId { get; set; } = "";
    public string Msg91ApiBase { get; set; } = "https://control.msg91.com";

    // payments
    public string RazorpayKeyId { get; set; } = "";
    public string RazorpayKeySecret { get; set; } = "";
    public string RazorpayWebhookSecret { get; set; } = "";
    public string RazorpayApiBase { get; set; } = "https://api.razorpay.com/v1";
    public bool RazorpayCheckout { get; set; } = true;
    public string RazorpayCheckoutUrl { get; set; } = "https://checkout.razorpay.com/v1/checkout.js";
    public int PaymentWindowMinutes { get; set; } = 30;

    // payouts (RazorpayX)
    public string PayoutMode { get; set; } = "manual";
    public string RazorpayxAccountNumber { get; set; } = "";
    public string RazorpayxWebhookSecret { get; set; } = "";

    // email and WhatsApp
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    public string SmtpUser { get; set; } = "";
    public string SmtpPassword { get; set; } = "";
    public string SmtpFrom { get; set; } = "";
    public string SmtpSecurity { get; set; } = "starttls";
    public string WhatsappPhoneNumberId { get; set; } = "";
    public string WhatsappToken { get; set; } = "";
    public string WhatsappLanguage { get; set; } = "en";
    public string WhatsappApiVersion { get; set; } = "v21.0";
    public string WhatsappApiBase { get; set; } = "https://graph.facebook.com";

    // push (Firebase Cloud Messaging)
    public string FirebaseProjectId { get; set; } = "";
    public string FirebaseClientEmail { get; set; } = "";
    public string FirebasePrivateKey { get; set; } = "";
    public string FirebaseApiKey { get; set; } = "";
    public string FirebaseSenderId { get; set; } = "";
    public string FirebaseAppId { get; set; } = "";
    public string FirebaseVapidKey { get; set; } = "";
    public string FirebaseOauthUrl { get; set; } = "https://oauth2.googleapis.com/token";
    public string FirebaseFcmBase { get; set; } = "https://fcm.googleapis.com";

    // shipping
    public string ShippingProvider { get; set; } = "manual";
    public string ShiprocketEmail { get; set; } = "";
    public string ShiprocketPassword { get; set; } = "";
    public string ShiprocketWebhookToken { get; set; } = "";
    public string ShiprocketApiBase { get; set; } = "https://apiv2.shiprocket.in/v1/external";

    // AI (Anthropic)
    public string AiProvider { get; set; } = "anthropic";
    public string AnthropicApiKey { get; set; } = "";
    public string AnthropicApiBase { get; set; } = "https://api.anthropic.com";
    public string AiModel { get; set; } = "claude-haiku-5-5";

    // monitoring
    public string SentryDsn { get; set; } = "";
    public double SentryTracesSampleRate { get; set; } = 0.05;

    /// <summary>Gateway calls are possible (refunds still work after checkout is switched off).</summary>
    public bool RazorpayEnabled => RazorpayKeyId.Length > 0 && RazorpayKeySecret.Length > 0;

    /// <summary>Customers can choose online payment at checkout.</summary>
    public bool OnlinePayments => RazorpayEnabled && RazorpayCheckout;

    /// <summary>Firebase push can be sent (project, service account email and private key are set).</summary>
    public bool PushConfigured => FirebaseProjectId.Length > 0 && FirebaseClientEmail.Length > 0 && FirebasePrivateKey.Length > 0;

    // ------------------------------------------------------------------ access by setting name ("razorpay_key_id")

    private static readonly Dictionary<string, PropertyInfo> Props = typeof(IntegrationSettings).GetProperties()
        .Where(p => p.CanWrite).ToDictionary(p => ToSnake(p.Name));

    public static bool Has(string setting) => Props.ContainsKey(setting);

    /// <summary>The value of a setting by its snake_case name, or null when there is no such setting.</summary>
    public object? Get(string setting) => Props.TryGetValue(setting, out var p) ? p.GetValue(this) : null;

    /// <summary>Sets a setting by name, converting the value to the setting's type (unknown names are ignored).</summary>
    public void Set(string setting, object? value)
    {
        if (!Props.TryGetValue(setting, out var p)) return;
        if (value is JsonNode node) value = node.GetValueKind() switch
        {
            System.Text.Json.JsonValueKind.String => node.GetValue<string>(),
            System.Text.Json.JsonValueKind.Number => node.GetValue<double>(),
            System.Text.Json.JsonValueKind.True => true,
            System.Text.Json.JsonValueKind.False => false,
            _ => null,
        };
        try
        {
            object? converted = p.PropertyType == typeof(string) ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""
                : p.PropertyType == typeof(bool) ? value is bool b ? b : value is string s ? s.Length > 0 && s != "false" : Convert.ToDouble(value, CultureInfo.InvariantCulture) != 0
                : p.PropertyType == typeof(int) ? (int)Convert.ToDouble(value, CultureInfo.InvariantCulture)
                : p.PropertyType == typeof(double) ? Convert.ToDouble(value, CultureInfo.InvariantCulture)
                : value;
            p.SetValue(this, converted);
        }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException)
        {
            // a damaged stored value: keep the environment value
        }
    }

    public IntegrationSettings Clone() => (IntegrationSettings)MemberwiseClone();

    public static string ToSnake(string pascal) =>
        string.Concat(pascal.Select((c, i) => char.IsUpper(c) && i > 0 ? "_" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));
}
