using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Utils;

namespace BAL;

/// <inheritdoc cref="IAuthSettingsBAL"/>
public partial class AuthSettingsBAL(SettingsDAL settings, IIntegrationBAL integrations, AppSettings env) : IAuthSettingsBAL
{
    public const string Key = "auth";
    private static readonly string[] EmailModes = ["optional", "required", "hidden"];
    private static readonly string[] AlertModes = ["off", "staff", "everyone"];

    private static readonly Dictionary<string, (int Min, int Max)> Ints = new()
    {
        ["otp_length"] = (4, 8),
        ["otp_ttl_seconds"] = (60, 900),
        ["otp_resend_cooldown_seconds"] = (15, 120),
        ["otp_max_attempts"] = (3, 10),
        ["otp_max_per_hour"] = (3, 20),
        ["otp_max_per_ip_hour"] = (10, 500),
        ["login_max_attempts"] = (3, 50),
        ["login_lockout_minutes"] = (5, 1440),
        ["password_min_length"] = (8, 64),
        ["customer_session_days"] = (1, 365),
        ["staff_session_days"] = (1, 90),
    };

    private static readonly Dictionary<string, string[]> Choices = new() { ["signup_email"] = EmailModes, ["login_alerts"] = AlertModes };

    public IReadOnlyDictionary<string, (int Min, int Max)> Limits => Ints;

    /// <summary>The defaults (the reference DEFAULTS dict; code rules and session length come from appsettings).</summary>
    public JsonObject Defaults() => new()
    {
        ["show_dev_otp"] = true,         // testing only; ignored in production and when SMS is connected
        ["customer_signup"] = true,      // new customers can create an account
        ["seller_signup"] = true,        // new sellers can register from "Become a seller"
        ["signup_email"] = "optional",   // ask for an email when creating an account: optional | required | hidden
        ["otp_length"] = env.OtpLength,
        ["otp_ttl_seconds"] = env.OtpTtlSeconds,
        ["otp_resend_cooldown_seconds"] = env.OtpResendCooldownSeconds,
        ["otp_max_attempts"] = env.OtpMaxAttempts,
        ["otp_max_per_hour"] = env.OtpMaxPerHour,  // codes per mobile number per hour
        ["otp_max_per_ip_hour"] = 30,              // codes per network per hour (stops number probing)
        ["login_max_attempts"] = 10,               // wrong passwords before the account waits
        ["login_lockout_minutes"] = 15,
        ["password_min_length"] = 12,
        ["password_require_mixed"] = true,         // upper and lower case letters and a number
        ["staff_require_two_step"] = false,        // staff must turn on two-step sign-in to use the admin panel
        ["customer_session_days"] = env.RefreshTokenDays,
        ["staff_session_days"] = env.RefreshTokenDays,
        ["login_alerts"] = "staff",                // tell people about a sign-in from a new device: off | staff | everyone
    };

    public async Task<JsonObject> GetAsync() => SettingsDAL.Merge(Defaults(), await settings.GetAsync(Key));

    public async Task<JsonObject> UpdateAsync(JsonObject data)
    {
        var defaults = Defaults();
        var clean = new JsonObject();
        foreach (var (k, v) in data)
        {
            if (!defaults.ContainsKey(k)) throw new AppException($"Unknown setting: {k}", "invalid_settings");
            var kind = v?.GetValueKind();
            if (Choices.TryGetValue(k, out var choices))
            {
                if (kind != JsonValueKind.String || !choices.Contains(v!.GetValue<string>()))
                    throw new AppException($"{k} must be one of: {string.Join(", ", choices)}", "invalid_settings");
            }
            else if (Ints.TryGetValue(k, out var range))
            {
                if (kind != JsonValueKind.Number || !int.TryParse(v!.ToJsonString(), out var n) || n < range.Min || n > range.Max)
                    throw new AppException($"{k} must be a whole number from {range.Min} to {range.Max}", "invalid_settings");
            }
            else if (kind is not (JsonValueKind.True or JsonValueKind.False))
                throw new AppException($"{k} must be on or off", "invalid_settings");
            clean[k] = v!.DeepClone();
        }
        var saved = await settings.GetAsync(Key);
        foreach (var (k, v) in clean) saved[k] = v?.DeepClone();
        await settings.SaveAsync(Key, saved);
        return await GetAsync();
    }

    [GeneratedRegex("[a-z]")] private static partial Regex Lower();
    [GeneratedRegex("[A-Z]")] private static partial Regex Upper();
    [GeneratedRegex(@"\d")] private static partial Regex Digit();

    public string? PasswordProblem(JsonObject cfg, string password)
    {
        var min = cfg.Int("password_min_length");
        if (password.Length < min) return $"Use at least {min} characters";
        if (cfg.Bool("password_require_mixed") && !(Lower().IsMatch(password) && Upper().IsMatch(password) && Digit().IsMatch(password)))
            return "Use upper and lower case letters and a number";
        return null;
    }

    public async Task RequireStrongPasswordAsync(string password, string field = "password")
    {
        var problem = PasswordProblem(await GetAsync(), password);
        if (problem is not null) throw new AppException(problem, "weak_password", fields: new Dictionary<string, string> { [field] = problem });
    }

    public int SessionDays(JsonObject cfg, bool isStaff) => cfg.Int(isStaff ? "staff_session_days" : "customer_session_days");

    public async Task<DevOtpStatus> DevOtpStatusAsync()
    {
        var cfg = await GetAsync();
        var sms = (await integrations.GetAsync()).SmsProvider;
        if (env.IsProduction) return new DevOtpStatus(false, "Never shown in production.");
        if (sms != "console") return new DevOtpStatus(false, "Real SMS is connected, so codes go by SMS only.");
        if (!cfg.Bool("show_dev_otp")) return new DevOtpStatus(false, "Switched off. Codes are only in the server log.");
        return new DevOtpStatus(true, "Test mode: the code appears under the code box on the sign-in screen.");
    }
}

/// <summary>Reading values from settings documents (JSON objects merged over defaults).</summary>
public static class JsonSettingsExtensions
{
    public static int Int(this JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<int>(out var n) ? n : Convert.ToInt32(o[key]?.GetValue<double>() ?? 0);

    public static bool Bool(this JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    public static string Str(this JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : o[key]?.ToJsonString() ?? "";
}
