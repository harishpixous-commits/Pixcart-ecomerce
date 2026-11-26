using Model.DomainModel;
using Model.DomainModel.Auth;

namespace BAL.Interface;

/// <summary>
/// A started (or renewed) session: the controller sets <see cref="RefreshToken"/> as the HttpOnly cookie for
/// <see cref="Days"/> days and answers with an access token and <see cref="UserPayload"/>.
/// </summary>
public record IssuedSession(UserModel User, string RefreshToken, int Days, Dictionary<string, object?> UserPayload);

/// <summary>A refused refresh and the reason to answer with (401).</summary>
public sealed class RefreshRefusedException(string message) : Utils.AppException(message, "unauthorized", 401);

/// <summary>
/// Sign-in (the reference version's routers/auth.py): one-time codes by SMS for customers, sellers and partners;
/// email and password with optional two-step sign-in for staff; refresh sessions (one per device, rotated on every use,
/// with theft detection and a 60-second grace for the same browser racing itself); signed-in devices; the profile.
/// </summary>
public interface IAuthBAL
{
    /// <summary>POST /api/auth/otp/request: rate-limited per network and number, with a resend wait; sends the code.</summary>
    Task<Dictionary<string, object?>> RequestOtpAsync(OtpRequestIn body);

    /// <summary>GET /api/auth/options: what the sign-in and create-account screens should offer.</summary>
    Task<Dictionary<string, object?>> OptionsAsync();

    /// <summary>POST /api/auth/otp/verify: checks the code, creates the account when allowed, starts a session.</summary>
    Task<(IssuedSession Session, bool IsNew)> VerifyOtpAsync(OtpVerifyIn body);

    /// <summary>POST /api/auth/login: staff sign-in with email, password and (when on) the authenticator code.</summary>
    Task<IssuedSession> PasswordLoginAsync(PasswordLoginIn body);

    /// <summary>POST /api/auth/password: changes the password (owner's policy) and ends every refresh session.</summary>
    Task ChangePasswordAsync(UserModel user, PasswordChangeIn body);

    /// <summary>POST /api/auth/totp/setup: a new authenticator secret and its otpauth:// address.</summary>
    Task<object> TotpSetupAsync(UserModel user);

    /// <summary>POST /api/auth/totp/enable.</summary>
    Task TotpEnableAsync(UserModel user, TotpCodeIn body);

    /// <summary>POST /api/auth/totp/disable: needs the code and (for password accounts) the password; the holder is told.</summary>
    Task TotpDisableAsync(UserModel user, TotpCodeIn body);

    /// <summary>POST /api/auth/refresh with the refresh cookie's value. Throws <see cref="RefreshRefusedException"/>.</summary>
    Task<IssuedSession> RefreshAsync(string? cookieToken);

    /// <summary>POST /api/auth/logout: ends this device's refresh session.</summary>
    Task LogoutAsync(string? cookieToken);

    /// <summary>GET /api/auth/sessions: the signed-in devices ("Chrome on Android", never the raw header).</summary>
    Task<object> SessionsAsync(UserModel user, string? cookieToken);

    /// <summary>POST /api/auth/sessions/sign-out-others: every other device is signed out; returns how many.</summary>
    Task<int> SignOutOthersAsync(UserModel user, string? cookieToken);

    /// <summary>The signed-in user as the web app reads it (also the "user" of sign-in answers).</summary>
    Task<Dictionary<string, object?>> UserPayloadAsync(UserModel user);

    /// <summary>PATCH /api/auth/me: name and email.</summary>
    Task<Dictionary<string, object?>> UpdateMeAsync(UserModel user, ProfileUpdateIn body);
}
