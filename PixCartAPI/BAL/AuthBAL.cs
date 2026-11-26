using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.CustomeAttributes;
using Model.DomainModel;
using Model.DomainModel.Auth;
using Utils;
using Utils.Interface;
using Utils.UtilModels;

namespace BAL;

/// <inheritdoc cref="IAuthBAL"/>
public class AuthBAL(
    AccountDAL accounts, SettingsDAL settings, IMySqlDapperHelper db, IAuthSettingsBAL authSettings, IIntegrationBAL integrations,
    IRateLimitBAL limits, IAuditBAL audit, INotifyBAL notify, ICurrentUser me, ISMSHelper sms, EncryptDecrypt crypto, AppSettings env) : IAuthBAL
{
    /// <summary>A rotated cookie that comes back within this time from the same browser is a reload race, not theft.</summary>
    public static readonly TimeSpan ReuseGrace = TimeSpan.FromSeconds(60);

    private string HashOtp(string phone, string code) => EncryptDecrypt.HmacSha256Hex(env.JwtSecret, $"{phone}:{code}");

    private static string Collapse(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    // ---------------------------------------------------------------- payloads

    public async Task<Dictionary<string, object?>> UserPayloadAsync(UserModel user)
    {
        var seller = await accounts.GetSellerByUserAsync(user.Id);
        var partner = await accounts.GetDeliveryPartnerByUserAsync(user.Id);
        return new Dictionary<string, object?>
        {
            // delivery partner summary: the web app sends partners to /delivery with it
            ["delivery"] = partner is null ? null : new Dictionary<string, object?> { ["id"] = partner.Id.ToString(), ["kyc_status"] = partner.KycStatus, ["is_active"] = partner.IsActive },
            ["id"] = user.Id.ToString(),
            ["name"] = user.Name,
            ["phone"] = user.Phone,
            ["email"] = user.Email,
            ["is_admin"] = user.IsAdmin,
            ["admin_role"] = user.IsAdmin ? (string.IsNullOrEmpty(user.AdminRole) ? "owner" : user.AdminRole) : null,
            ["marketing_opt_in"] = user.MarketingOptIn,
            ["totp_enabled"] = user.TotpEnabled,
            ["seller"] = seller is null ? null : new Dictionary<string, object?> { ["id"] = seller.Id.ToString(), ["status"] = seller.Status, ["display_name"] = seller.DisplayName },
        };
    }

    /// <summary>A short, readable name for the browser and system ("Chrome on Android"); never the raw header.</summary>
    public static string Device(string? userAgent)
    {
        var ua = userAgent ?? "";
        var browser = new[] { ("Edg/", "Edge"), ("OPR/", "Opera"), ("SamsungBrowser", "Samsung Internet"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari") }
            .FirstOrDefault(x => ua.Contains(x.Item1)).Item2 ?? "";
        var system = new[] { ("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Windows", "Windows"), ("Mac OS X", "Mac"), ("Linux", "Linux") }
            .FirstOrDefault(x => ua.Contains(x.Item1)).Item2 ?? "";
        if (ua.Contains("PixCartPartner")) browser = "Partner app";
        var name = string.Join(" on ", new[] { browser, system }.Where(x => x.Length > 0));
        return name.Length > 0 ? name : "Unknown device";
    }

    // ---------------------------------------------------------------- sessions

    /// <summary>Starts (or, for a refresh, renews) a session inside the unit of work and commits it.</summary>
    private async Task<IssuedSession> IssueSessionAsync(IUnitOfWork uow, UserModel user, bool newSignIn = true)
    {
        var cfg = await authSettings.GetAsync();
        var days = authSettings.SessionDays(cfg, user.IsAdmin);
        var token = EncryptDecrypt.NewOpaqueToken();
        var now = DateTimeFunctions.UtcNow();
        var agent = me.UserAgent;
        if (newSignIn) await AlertNewDeviceAsync(uow, cfg, user, agent);
        await accounts.InsertSessionAsync(new RefreshSessionModel
        {
            Id = Guid.NewGuid(), UserId = user.Id, TokenHash = EncryptDecrypt.Sha256(token), CreatedAt = now, ExpiresAt = now.AddDays(days), UserAgent = agent,
        }, uow.Transaction);
        user.LastLoginAt = now;
        user.UpdatedAt = now;
        await accounts.SaveUserAsync(user, uow.Transaction);
        await uow.CommitAsync();
        return new IssuedSession(user, token, days, await UserPayloadAsync(user));
    }

    /// <summary>
    /// Sign-in alert (Admin → Sign-in → Sign-in alerts) when the browser and system match none of the account's signed-in
    /// devices. The first sign-in of a new account is not an alert.
    /// </summary>
    private async Task AlertNewDeviceAsync(IUnitOfWork uow, JsonObject cfg, UserModel user, string agent)
    {
        var mode = cfg.Str("login_alerts");
        if (mode == "off" || (mode == "staff" && !user.IsAdmin) || user.LastLoginAt is null) return;
        var known = await accounts.ActiveSessionsAsync(user.Id, DateTimeFunctions.UtcNow(), int.MaxValue, uow.Transaction);
        var device = Device(agent);
        if (known.Any(s => Device(s.UserAgent) == device)) return;
        await notify.NotifyAsync("security_notice", user, new Dictionary<string, object?>
        {
            ["what"] = $"new sign-in on {device}",
            ["message"] = $"Your account was just signed in on {device}. If this was you, there is nothing to do.",
        }, channels: ["inapp", "email"], uow: uow);
    }

    // ---------------------------------------------------------------- one-time codes

    /// <summary>Sign in needs an existing, active account; create-account needs a number that has none.</summary>
    private async Task CheckPurposeAsync(OtpRequestIn body, string phone)
    {
        var user = await accounts.GetUserByPhoneAsync(phone);
        if (body.Purpose == "signin")
        {
            if (user is null) throw new AppException("No account uses this mobile number yet. Create an account to continue.", "no_account", 404);
            if (!user.IsActive) throw new ForbiddenException("This account has been blocked. Contact support.");
        }
        else if (body.Purpose == "signup")
        {
            if (user is not null) throw new AppException("This mobile number already has an account. Sign in instead.", "account_exists", 409);
            var cfg = await authSettings.GetAsync();
            if (!cfg.Bool(body.ForSeller ? "seller_signup" : "customer_signup"))
                throw new AppException("New accounts are paused right now. Please try again later.", "signup_closed", 403);
        }
    }

    public async Task<Dictionary<string, object?>> RequestOtpAsync(OtpRequestIn body)
    {
        var phone = IndianFormats.NormalizeMobile(body.Phone);
        var cfg = await authSettings.GetAsync();
        // count the attempt before telling anyone whether a number has an account (limits number probing)
        await limits.RateLimitAsync($"otp:ip:{me.IpAddress}", cfg.Int("otp_max_per_ip_hour"), 3600);
        await CheckPurposeAsync(body, phone);
        var now = DateTimeFunctions.UtcNow();
        var cooldown = cfg.Int("otp_resend_cooldown_seconds");
        var latest = await accounts.LatestChallengeAsync(phone);
        if (latest is not null && (now - latest.CreatedAt).TotalSeconds < cooldown)
        {
            var wait = cooldown - (int)(now - latest.CreatedAt).TotalSeconds;
            throw new TooManyRequestsException($"Please wait {wait} seconds before requesting another OTP");
        }
        await limits.RateLimitAsync($"otp:phone:{phone}", cfg.Int("otp_max_per_hour"), 3600);

        var code = EncryptDecrypt.NumericCode(cfg.Int("otp_length"));
        await using (var uow = await db.BeginAsync())
        {
            // only the newest challenge for a phone is valid
            await accounts.ConsumeOpenChallengesAsync(phone, now, uow.Transaction);
            await accounts.InsertChallengeAsync(new OtpChallengeModel
            {
                Id = Guid.NewGuid(), Phone = phone, CodeHash = HashOtp(phone, code), Attempts = 0,
                ExpiresAt = now.AddSeconds(cfg.Int("otp_ttl_seconds")), CreatedAt = now, Ip = me.IpAddress,
            }, uow.Transaction);
            await uow.CommitAsync();
        }
        await SendOtpAsync(phone, code);
        var outp = new Dictionary<string, object?>
        {
            ["sent"] = true, ["expires_in"] = cfg.Int("otp_ttl_seconds"), ["resend_in"] = cooldown, ["length"] = cfg.Int("otp_length"),
        };
        if ((await authSettings.DevOtpStatusAsync()).Active) outp["dev_otp"] = code; // test installs only: never in production or with real SMS
        return outp;
    }

    /// <summary>Console (development: log and test outbox) or MSG91 (a DLT-registered OTP SMS). The reference services/sms.py.</summary>
    private async Task SendOtpAsync(string phone, string code)
    {
        var cfg = await integrations.GetAsync();
        if (cfg.SmsProvider == "console" && env.IsProduction)
            // never print codes in production logs; switch on MSG91 in Admin → Integrations
            throw new AppException("Sign-in by OTP is not set up yet. Please try again later.", "sms_failed", 503);
        if (cfg.SmsProvider == "msg91" && (cfg.Msg91AuthKey.Length == 0 || cfg.Msg91OtpTemplateId.Length == 0))
            throw new AppException("MSG91 is not configured", "sms_failed", 503);
        try
        {
            await sms.SendOtpAsync(new SMSModel { Phone = phone, OtpCode = code },
                new SmsConfig { Provider = cfg.SmsProvider, AuthKey = cfg.Msg91AuthKey, OtpTemplateId = cfg.Msg91OtpTemplateId, SenderId = cfg.Msg91SenderId, ApiBase = cfg.Msg91ApiBase });
        }
        catch (AppException)
        {
            throw new AppException("Could not send the OTP right now", "sms_failed", 503);
        }
        catch (HttpRequestException)
        {
            throw new AppException("Could not send the OTP right now", "sms_failed", 503);
        }
    }

    public async Task<Dictionary<string, object?>> OptionsAsync()
    {
        var cfg = await authSettings.GetAsync();
        return new Dictionary<string, object?>
        {
            ["customer_signup"] = cfg.Bool("customer_signup"), ["seller_signup"] = cfg.Bool("seller_signup"), ["signup_email"] = cfg.Str("signup_email"),
            ["otp_length"] = cfg.Int("otp_length"), ["dev_otp"] = (await authSettings.DevOtpStatusAsync()).Active,
            ["password_min_length"] = cfg.Int("password_min_length"), ["password_require_mixed"] = cfg.Bool("password_require_mixed"),
        };
    }

    public async Task<(IssuedSession Session, bool IsNew)> VerifyOtpAsync(OtpVerifyIn body)
    {
        var phone = IndianFormats.NormalizeMobile(body.Phone);
        var now = DateTimeFunctions.UtcNow();
        var signup = body.Purpose == "signup";
        var name = Collapse(body.Name);
        var email = body.Email?.ToLowerInvariant();
        var cfg = await authSettings.GetAsync();
        if (signup)
        {
            if (name.Length < 2) throw new AppException("Enter your name", "name_required", fields: new Dictionary<string, string> { ["name"] = "Required" });
            if (!body.AcceptTerms)
                throw new AppException("Please accept the terms of use and privacy policy", "terms_required", fields: new Dictionary<string, string> { ["accept_terms"] = "Required" });
            if (cfg.Str("signup_email") == "required" && string.IsNullOrEmpty(email))
                throw new AppException("Enter your email", "email_required", fields: new Dictionary<string, string> { ["email"] = "Required" });
            if (cfg.Str("signup_email") == "hidden") email = null;
            if (!string.IsNullOrEmpty(email) && await accounts.EmailTakenAsync(email))
                throw new AppException("This email is already used by another account", "email_taken", fields: new Dictionary<string, string> { ["email"] = "Already in use" });
        }
        await using var uow = await db.BeginAsync();
        var challenge = await accounts.LatestOpenChallengeForUpdateAsync(phone, uow.Transaction);
        if (challenge is null || challenge.ExpiresAt < now) throw new AppException("This OTP has expired. Please request a new one.", "otp_expired");
        var maxAttempts = cfg.Int("otp_max_attempts");
        if (challenge.Attempts >= maxAttempts) throw new TooManyRequestsException("Too many wrong attempts. Please request a new OTP.");
        if (HashOtp(phone, (body.Code ?? "").Trim()) != challenge.CodeHash)
        {
            challenge.Attempts += 1;
            await accounts.UpdateChallengeAsync(challenge, uow.Transaction);
            await uow.CommitAsync();
            var left = maxAttempts - challenge.Attempts;
            throw new AppException(left > 0 ? $"Incorrect OTP. {left} attempt(s) left." : "Incorrect OTP.", "otp_invalid");
        }
        challenge.ConsumedAt = now;
        await accounts.UpdateChallengeAsync(challenge, uow.Transaction);

        var user = await accounts.GetUserByPhoneAsync(phone, uow.Transaction);
        var isNew = user is null;
        if (user is null)
        {
            if (body.Purpose == "signin")
            {
                await uow.CommitAsync();
                throw new AppException("No account uses this mobile number yet. Create an account to continue.", "no_account", 404);
            }
            // creating an account records acceptance of the terms and privacy notice shown on the screen
            user = new UserModel
            {
                Id = Guid.NewGuid(), Phone = phone, Name = name, Email = string.IsNullOrEmpty(email) ? null : email, TermsAcceptedAt = now,
                MarketingOptIn = signup && body.MarketingOptIn, IsActive = true, UiPrefs = "{}", CreatedAt = now, UpdatedAt = now,
            };
            await accounts.InsertUserAsync(user, uow.Transaction);
        }
        else if (name.Length > 0 && user.Name.Length == 0) user.Name = name;
        if (!user.IsActive)
        {
            await uow.CommitAsync();
            throw new ForbiddenException("This account has been blocked. Contact support.");
        }
        return (await IssueSessionAsync(uow, user), isNew);
    }

    // ---------------------------------------------------------------- passwords and two-step sign-in

    public async Task<IssuedSession> PasswordLoginAsync(PasswordLoginIn body)
    {
        var email = body.Email!.ToLowerInvariant();
        var cfg = await authSettings.GetAsync();
        var window = cfg.Int("login_lockout_minutes") * 60;
        await limits.RateLimitAsync($"login:{email}", cfg.Int("login_max_attempts"), window);
        await limits.RateLimitAsync($"login-ip:{me.IpAddress}", Math.Max(50, cfg.Int("login_max_attempts") * 5), window);
        var user = await accounts.GetUserByEmailAsync(email);
        if (user is null || !EncryptDecrypt.VerifyPassword(body.Password!, user.PasswordHash)) throw new UnauthorizedException("Incorrect email or password");
        if (!user.IsActive) throw new ForbiddenException("This account has been blocked");
        if (user.TotpEnabled)
        {
            if (body.Totp.Length == 0) throw new AppException("Enter the 6-digit code from your authenticator app", "totp_required", 401);
            if (!TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), body.Totp)) throw new UnauthorizedException("The authenticator code is not correct");
        }
        await using var uow = await db.BeginAsync();
        return await IssueSessionAsync(uow, user);
    }

    public async Task ChangePasswordAsync(UserModel user, PasswordChangeIn body)
    {
        if (!EncryptDecrypt.VerifyPassword(body.CurrentPassword!, user.PasswordHash))
            throw new AppException("Your current password is not correct", "wrong_password", fields: new Dictionary<string, string> { ["current_password"] = "Incorrect" });
        var problem = authSettings.PasswordProblem(await authSettings.GetAsync(), body.NewPassword!);
        if (problem is not null) throw new AppException(problem, "weak_password", fields: new Dictionary<string, string> { ["new_password"] = problem });
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        user.PasswordHash = EncryptDecrypt.HashPassword(body.NewPassword!);
        user.UpdatedAt = now;
        await accounts.SaveUserAsync(user, uow.Transaction);
        await accounts.RevokeAllSessionsAsync(user.Id, now, uow.Transaction);
        await uow.CommitAsync();
    }

    public async Task<object> TotpSetupAsync(UserModel user)
    {
        if (user.TotpEnabled) throw new AppException("Two-step sign-in is already on", "totp_on");
        var secret = TotpHelper.NewSecret();
        user.TotpSecretEnc = crypto.Encrypt(secret);
        user.UpdatedAt = DateTimeFunctions.UtcNow();
        await accounts.SaveUserAsync(user);
        var account = !string.IsNullOrEmpty(user.Email) ? user.Email : !string.IsNullOrEmpty(user.Phone) ? user.Phone : user.Id.ToString();
        return new { secret, uri = TotpHelper.Uri(secret, account, await SiteSettingsReader.BrandNameAsync(settings, env)) };
    }

    /// <summary>Counts a code attempt (kept even when the code is wrong): 5 per 15 minutes, so codes cannot be guessed.</summary>
    private Task TotpAttemptAsync(UserModel user) => limits.RateLimitAsync($"totp:{user.Id}", 5, 900);

    public async Task TotpEnableAsync(UserModel user, TotpCodeIn body)
    {
        await TotpAttemptAsync(user);
        if (string.IsNullOrEmpty(user.TotpSecretEnc) || !TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), body.Code))
            throw new AppException("That code is not correct. Check the time on your phone and try again.", "totp_invalid");
        await using var uow = await db.BeginAsync();
        user.TotpEnabled = true;
        user.UpdatedAt = DateTimeFunctions.UtcNow();
        await accounts.SaveUserAsync(user, uow.Transaction);
        await audit.AuditAsync(user, "account.totp_on", "user", user.Id, uow: uow);
        await uow.CommitAsync();
    }

    public async Task TotpDisableAsync(UserModel user, TotpCodeIn body)
    {
        await TotpAttemptAsync(user);
        if (!string.IsNullOrEmpty(user.PasswordHash) && !EncryptDecrypt.VerifyPassword(body.Password, user.PasswordHash))
            throw new AppException("Enter your current password to turn off two-step sign-in", "wrong_password", fields: new Dictionary<string, string> { ["password"] = "Incorrect" });
        if (!user.TotpEnabled || !TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), body.Code)) throw new AppException("That code is not correct", "totp_invalid");
        await using var uow = await db.BeginAsync();
        user.TotpEnabled = false;
        user.TotpSecretEnc = null;
        user.UpdatedAt = DateTimeFunctions.UtcNow();
        await accounts.SaveUserAsync(user, uow.Transaction);
        await audit.AuditAsync(user, "account.totp_off", "user", user.Id, uow: uow);
        await notify.NotifyAsync("security_notice", user, new Dictionary<string, object?>
        {
            ["what"] = "two-step sign-in turned off",
            ["message"] = "Two-step sign-in was turned off on your account. Only your password is now needed to sign in.",
        }, channels: ["inapp", "email", "sms"], uow: uow);
        await uow.CommitAsync();
    }

    // ---------------------------------------------------------------- refresh, sign out, devices

    public async Task<IssuedSession> RefreshAsync(string? cookieToken)
    {
        if (string.IsNullOrEmpty(cookieToken)) throw new RefreshRefusedException("Please sign in");
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        var row = await accounts.GetSessionByHashForUpdateAsync(EncryptDecrypt.Sha256(cookieToken), uow.Transaction)
                  ?? throw new RefreshRefusedException("Please sign in");
        if (row.RevokedAt is { } revokedAt)
        {
            var owner = await accounts.GetUserAsync(row.UserId, uow.Transaction);
            if (owner?.SessionsValidAfter is { } after && revokedAt == after)
                // this device was signed out from another one ("Sign out of other devices"): refuse it, nothing more
                throw new RefreshRefusedException("You were signed out on this device. Please sign in again.");
            // The same browser racing itself: a page reloaded (or a second tab opened) while a refresh was on its way, so the
            // old cookie came back moments after it was rotated. Not theft: renew quietly. Only when this token was rotated
            // (a newer session from the same browser began right then) and within a minute.
            var agent = me.UserAgent;
            if (now - revokedAt <= ReuseGrace && (row.UserAgent ?? "") == agent)
            {
                var rotated = await accounts.RotatedSessionExistsAsync(row.UserId, row.UserAgent, revokedAt, revokedAt.AddSeconds(5), uow.Transaction);
                if (rotated && owner is { IsActive: true }) return await IssueSessionAsync(uow, owner, newSignIn: false);
            }
            // a rotated token was replayed: assume theft and end every session of this user
            await accounts.RevokeAllSessionsAsync(row.UserId, now, uow.Transaction);
            await uow.CommitAsync();
            throw new RefreshRefusedException("Please sign in");
        }
        if (row.ExpiresAt < now) throw new RefreshRefusedException("Please sign in");
        var user = await accounts.GetUserAsync(row.UserId, uow.Transaction);
        if (user is null || !user.IsActive) throw new RefreshRefusedException("Please sign in");
        await accounts.RevokeSessionAsync(row.Id, now, uow.Transaction);
        return await IssueSessionAsync(uow, user, newSignIn: false);
    }

    public async Task LogoutAsync(string? cookieToken)
    {
        if (!string.IsNullOrEmpty(cookieToken)) await accounts.RevokeSessionByHashAsync(EncryptDecrypt.Sha256(cookieToken), DateTimeFunctions.UtcNow());
    }

    public async Task<object> SessionsAsync(UserModel user, string? cookieToken)
    {
        var current = EncryptDecrypt.Sha256(cookieToken ?? "");
        var rows = await accounts.ActiveSessionsAsync(user.Id, DateTimeFunctions.UtcNow(), 50);
        return new
        {
            sessions = rows.Select(r => new
            {
                id = r.Id.ToString(), device = Device(r.UserAgent), last_active = DateTimeFunctions.Iso(r.CreatedAt), expires_at = DateTimeFunctions.Iso(r.ExpiresAt),
                current = r.TokenHash == current,
            }),
        };
    }

    public async Task<int> SignOutOthersAsync(UserModel user, string? cookieToken)
    {
        var now = DateTimeFunctions.UtcNow();
        var current = EncryptDecrypt.Sha256(cookieToken ?? "");
        await using var uow = await db.BeginAsync();
        var n = await accounts.RevokeOtherSessionsAsync(user.Id, current, now, uow.Transaction);
        user.SessionsValidAfter = now;
        user.UpdatedAt = now;
        await accounts.SaveUserAsync(user, uow.Transaction);
        await audit.AuditAsync(user, "account.sign_out_others", "user", user.Id, $"sessions={n}", uow);
        await notify.NotifyAsync("security_notice", user, new Dictionary<string, object?>
        {
            ["what"] = "other devices signed out",
            ["message"] = "All other devices were signed out of your account. If this was not you, change your password now.",
        }, channels: ["inapp"], uow: uow);
        await uow.CommitAsync();
        return n;
    }

    public async Task<Dictionary<string, object?>> UpdateMeAsync(UserModel user, ProfileUpdateIn body)
    {
        if (body.Name is not null) user.Name = body.Name.Trim();
        if (body.Email is not null)
        {
            var email = body.Email.ToLowerInvariant();
            if (await accounts.EmailTakenAsync(email, user.Id))
                throw new AppException("This email is already used by another account", "email_taken", fields: new Dictionary<string, string> { ["email"] = "Already in use" });
            user.Email = email;
        }
        user.UpdatedAt = DateTimeFunctions.UtcNow();
        await accounts.SaveUserAsync(user);
        return await UserPayloadAsync(user);
    }
}
