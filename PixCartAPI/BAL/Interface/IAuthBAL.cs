using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Sign-in and account security (reference: routers/auth.py).</summary>
public interface IAuthBAL
{
    /// <summary>Reference: user_payload.</summary>
    Task<JsonObject> UserPayloadAsync(UserModel user);

    /// <summary>Reference: request_otp. Returns the response body; the dev code is included only on test installs.</summary>
    Task<JsonObject> RequestOtpAsync(string phone, string purpose, bool forSeller, string ip);

    /// <summary>Reference: auth_options.</summary>
    Task<JsonObject> OptionsAsync();

    /// <summary>Reference: verify_otp. The controller adds the access token to the body.</summary>
    Task<(UserModel User, string RefreshToken, int Days, bool IsNew)> VerifyOtpAsync(string phone, string code, string purpose,
        string name, string? email, bool acceptTerms, bool marketingOptIn, bool forSeller, string userAgent);

    /// <summary>Reference: password_login. The controller adds the access token to the body.</summary>
    Task<(UserModel User, string RefreshToken, int Days)> PasswordLoginAsync(string email, string password,
        string totp, string ip, string userAgent);

    /// <summary>Reference: change_password.</summary>
    Task ChangePasswordAsync(UserModel user, string currentPassword, string newPassword);

    /// <summary>Reference: totp_setup.</summary>
    Task<JsonObject> TotpSetupAsync(UserModel user);

    /// <summary>Reference: totp_enable.</summary>
    Task TotpEnableAsync(UserModel user, string code);

    /// <summary>Reference: totp_disable.</summary>
    Task TotpDisableAsync(UserModel user, string code, string password);

    /// <summary>Reference: refresh. Renewed session for the raw cookie token.</summary>
    Task<(UserModel User, string RefreshToken, int Days)> RefreshAsync(string rawToken, string userAgent);

    /// <summary>Reference: logout.</summary>
    Task LogoutAsync(string? rawToken);

    /// <summary>Reference: list_sessions.</summary>
    Task<JsonObject> SessionsAsync(UserModel user, string? rawToken);

    /// <summary>Reference: sign_out_others.</summary>
    Task<JsonObject> SignOutOthersAsync(UserModel user, string? rawToken);

    /// <summary>Reference: update_me.</summary>
    Task<JsonObject> UpdateMeAsync(UserModel user, string? name, string? email);
}
