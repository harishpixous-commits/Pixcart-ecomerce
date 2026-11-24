using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.Integrations;

namespace BAL.Interface;

/// <summary>The answer of a "Test connection" call.</summary>
public record CheckResult(bool Ok, string Message);

/// <summary>
/// Third-party connections (Admin → Integrations): Razorpay, RazorpayX, MSG91 SMS, email (SMTP), WhatsApp, Firebase push,
/// Shiprocket, AI (Anthropic) and Sentry. Keys saved in the admin panel are encrypted in <c>platform_settings['integrations']</c>
/// and win over appsettings. The reference version's <c>app.integrations</c> (store, checks, registry).
/// </summary>
public interface IIntegrationBAL
{
    /// <summary>
    /// The provider settings in effect right now (decrypted): appsettings with the admin's values and on/off switches on top.
    /// Read every provider key through this (e.g. <c>(await integrations.GetAsync()).RazorpayKeySecret</c>), never from
    /// AppSettings. Cached for 15 seconds (not in tests); <see cref="Invalidate"/> clears it. The reference <c>integrations.get()</c>.
    /// </summary>
    Task<IntegrationSettings> GetAsync();

    /// <summary>Forget the cached settings (after a save).</summary>
    void Invalidate();

    /// <summary>Every provider for Admin → Integrations: fields (secrets only as ••••last4), switch, readiness, last test and last webhook.</summary>
    Task<List<Dictionary<string, object?>>> StatusAsync();

    /// <summary>
    /// Validates and stores one provider's values (empty secret boxes keep what is saved), the fields to clear and the
    /// switch. Returns the field keys that changed (never values). Throws 400 "invalid_integration" with a message an admin can act on.
    /// </summary>
    Task<List<string>> SaveAsync(string providerKey, JsonObject values, IReadOnlyList<string> clear, bool? enabled, string actorName);

    /// <summary>Runs the provider's "Test connection" check with the given settings (phone, to, brand, model as the check needs).</summary>
    Task<CheckResult> RunCheckAsync(string providerKey, IntegrationSettings cfg, IReadOnlyDictionary<string, string> parameters);

    /// <summary>Saves the result of a connection test on the provider and returns it ({ok, message, at}).</summary>
    Task<JsonObject> RecordTestAsync(string providerKey, bool ok, string message);

    /// <summary>GET /api/admin/integrations: {environment, groups, items, infrastructure}.</summary>
    Task<object> ListAsync();

    /// <summary>PUT /api/admin/integrations/{key}: confirms the admin's identity, saves, audits, returns {changed, item}.</summary>
    Task<object> SaveFromAdminAsync(UserModel admin, string key, JsonObject values, IReadOnlyList<string> clear, bool? enabled, string password, string totp);

    /// <summary>POST /api/admin/integrations/{key}/test: rate-limited connection test, recorded and audited.</summary>
    Task<JsonObject> TestFromAdminAsync(UserModel admin, string key, string phone, string to);
}
