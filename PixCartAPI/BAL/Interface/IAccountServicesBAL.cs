using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils.Interface;

namespace BAL.Interface;

/// <summary>
/// Fixed-window rate limits stored in MySQL (<c>rate_limit_events</c>), so they hold across every server. The reference
/// version's <c>core.deps.rate_limit</c>.
/// </summary>
public interface IRateLimitBAL
{
    /// <summary>
    /// Counts one attempt for <paramref name="key"/> and throws 429 ("Too many attempts. Please try again later.") when
    /// <paramref name="limit"/> attempts were already counted in the last <paramref name="windowSeconds"/>. Without a unit of
    /// work the attempt is saved at once (it is kept even when the request then fails).
    /// </summary>
    Task RateLimitAsync(string key, int limit, int windowSeconds, IUnitOfWork? uow = null);

    /// <summary>True when <paramref name="limit"/> attempts are already counted for the key in the window. Counts nothing.</summary>
    Task<bool> IsOverAsync(string key, int limit, int windowSeconds);

    /// <summary>Counts one attempt for the key without ever refusing.</summary>
    Task CountAsync(string key);

    /// <summary>Deletes attempts older than a day (cleanup job).</summary>
    Task PruneRateLimitsAsync();
}

/// <summary>The audit log (Admin → Audit log): who changed what. The reference version's <c>core.deps.audit</c>.</summary>
public interface IAuditBAL
{
    /// <summary>
    /// Records one change, e.g. <c>AuditAsync(admin, "staff.update", "user", u.Id, "role support→finance")</c>. Never put
    /// secrets or personal data in <paramref name="detail"/> (cut to 2000 characters). <paramref name="actor"/> null means the
    /// system. Pass the unit of work so the entry is saved only if the change commits.
    /// </summary>
    Task AuditAsync(UserModel? actor, string action, string entityType, object entityId, string detail = "", IUnitOfWork? uow = null);
}

/// <summary>Whether the sign-in screen shows the one-time code (test installs only), and why.</summary>
public record DevOtpStatus(bool Active, string Reason);

/// <summary>
/// Sign-in and account settings (Admin → Sign-in and accounts), stored in <c>platform_settings['auth']</c> over defaults
/// from appsettings. The reference version's <c>services/auth_settings.py</c>.
/// </summary>
public interface IAuthSettingsBAL
{
    /// <summary>Every setting: the saved values over the defaults (unknown saved keys are ignored).</summary>
    Task<JsonObject> GetAsync();

    /// <summary>
    /// Validates and saves some settings (400 "invalid_settings" with the reason when a key is unknown or a value is out of
    /// range); returns all settings after the change.
    /// </summary>
    Task<JsonObject> UpdateAsync(JsonObject data);

    /// <summary>Why a new password is not allowed under the owner's policy, or null. One rule for every password screen.</summary>
    string? PasswordProblem(JsonObject cfg, string password);

    /// <summary>The owner's policy check, throwing 400 "weak_password" with <paramref name="field"/> marked.</summary>
    Task RequireStrongPasswordAsync(string password, string field = "password");

    /// <summary>How many days staff or customers stay signed in.</summary>
    int SessionDays(JsonObject cfg, bool isStaff);

    /// <summary>Whether the code is shown on screen right now (never in production or with real SMS), and why.</summary>
    Task<DevOtpStatus> DevOtpStatusAsync();

    /// <summary>The lowest and highest value of every number setting.</summary>
    IReadOnlyDictionary<string, (int Min, int Max)> Limits { get; }
}
