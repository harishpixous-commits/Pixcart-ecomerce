using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
using Utils.UtilModels;

namespace BAL;

/// <summary>Sign-in and account security (reference: routers/auth.py).</summary>
public class AuthBAL(
    AccountDAL accounts,
    IAuthSettingsBAL authSettings,
    IIntegrationBAL integrations,
    ISiteBAL site,
    ICatalogNotifyBAL notify,
    EncryptDecrypt crypto,
    ISMSHelper sms,
    IRateLimitBAL rateLimit,
    AppSettings app,
    IMySqlDapperHelper db) : IAuthBAL
{
    private static readonly TimeSpan ReuseGrace = TimeSpan.FromSeconds(60);

    /// <summary>Reference: core.validators.normalize_mobile (10 digits or an error).</summary>
    private static string NormalizeMobile(string value)
    {
        var digits = new string((value ?? "").Where(char.IsDigit).ToArray());
        if (digits.Length == 12 && digits.StartsWith("91")) digits = digits[2..];
        else if (digits.Length == 11 && digits.StartsWith('0')) digits = digits[1..];
        if (!System.Text.RegularExpressions.Regex.IsMatch(digits, "^[6-9]\\d{9}$"))
            throw new AppException("Enter a valid 10-digit Indian mobile number", "validation_error", 422);
        return digits;
    }

    /// <summary>Reference: _device — a short readable name, never the raw header.</summary>
    private static string Device(string? userAgent)
    {
        var ua = userAgent ?? "";
        var browser = new (string Key, string Name)[] { ("Edg/", "Edge"), ("OPR/", "Opera"), ("SamsungBrowser", "Samsung Internet"),
            ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari") }
            .Where(x => ua.Contains(x.Key)).Select(x => x.Name).FirstOrDefault() ?? "";
        var system = new (string Key, string Name)[] { ("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"),
            ("Windows", "Windows"), ("Mac OS X", "Mac"), ("Linux", "Linux") }
            .Where(x => ua.Contains(x.Key)).Select(x => x.Name).FirstOrDefault() ?? "";
        if (ua.Contains("PixCartPartner")) browser = "Partner app";
        return string.Join(" on ", new[] { browser, system }.Where(x => x.Length > 0)) is { Length: > 0 } d ? d : "Unknown device";
    }

    /// <summary>Reference: user_payload.</summary>
    public async Task<JsonObject> UserPayloadAsync(UserModel user)
    {
        var seller = await accounts.GetSellerByUserAsync(user.Id);
        var partner = await db.QueryFirstOrDefaultAsync<DeliveryBoyModel>(
            "SELECT * FROM delivery_boys WHERE user_id = @uid", new { uid = user.Id });
        return new JsonObject
        {
            ["delivery"] = partner is null
                ? null
                : new JsonObject { ["id"] = partner.Id.ToString(), ["kyc_status"] = partner.KycStatus, ["is_active"] = partner.IsActive },
            ["id"] = user.Id.ToString(), ["name"] = user.Name, ["phone"] = user.Phone, ["email"] = user.Email,
            ["is_admin"] = user.IsAdmin,
            ["admin_role"] = user.IsAdmin ? (string.IsNullOrEmpty(user.AdminRole) ? "owner" : user.AdminRole) : null,
            ["marketing_opt_in"] = user.MarketingOptIn, ["totp_enabled"] = user.TotpEnabled,
            ["seller"] = seller is null
                ? null
                : new JsonObject { ["id"] = seller.Id.ToString(), ["status"] = seller.Status, ["display_name"] = seller.DisplayName },
        };
    }

    /// <summary>Reference: _alert_new_device (in-app only in this build; email/sms channels are not ported).</summary>
    private async Task AlertNewDeviceAsync(JsonObject cfg, UserModel user, string agent)
    {
        var mode = cfg["login_alerts"]?.GetValue<string>() ?? "staff";
        if (mode == "off" || (mode == "staff" && !user.IsAdmin) || user.LastLoginAt is null)
            return;
        var known = await db.QueryAsync<string?>(
            "SELECT user_agent FROM refresh_sessions WHERE user_id = @uid AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(6)",
            new { uid = user.Id });
        var device = Device(agent);
        if (known.Any(a => Device(a) == device))
            return;
        await notify.NotifyUserAsync(user.Id, "security_notice", new Dictionary<string, string>
        {
            ["what"] = $"new sign-in on {device}",
            ["message"] = $"Your account was just signed in on {device}. If this was you, there is nothing to do.",
        });
    }

    /// <summary>Reference: _issue_session. Returns the raw refresh token (cookie) and its lifetime in days.</summary>
    private async Task<(string Token, int Days)> IssueSessionAsync(UserModel user, string userAgent, bool newSignIn)
    {
        var cfg = await authSettings.GetAsync();
        var days = authSettings.SessionDays(cfg, user.IsAdmin);
        var token = EncryptDecrypt.NewOpaqueToken();
        var now = DateTimeFunctions.UtcNow();
        if (newSignIn)
            await AlertNewDeviceAsync(cfg, user, userAgent);
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync(
            "INSERT INTO refresh_sessions (user_id, token_hash, created_at, expires_at, user_agent, id) " +
            "VALUES (@uid, @hash, @now, @exp, @agent, @id)",
            new { uid = user.Id, hash = EncryptDecrypt.Sha256(token), now, exp = now.AddDays(days), agent = userAgent, id = Guid.NewGuid() });
        await uow.ExecuteAsync("UPDATE users SET last_login_at = @now, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
            new { now, uid = user.Id });
        await uow.CommitAsync();
        user.LastLoginAt = now;
        return (token, days);
    }

    /// <summary>Reference: _check_purpose.</summary>
    private async Task<UserModel?> CheckPurposeAsync(string phone, string purpose, bool forSeller)
    {
        var user = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE phone = @phone", new { phone });
        if (purpose == "signin")
        {
            if (user is null)
                throw new AppException("No account uses this mobile number yet. Create an account to continue.", "no_account", 404);
            if (!user.IsActive)
                throw new ForbiddenException("This account has been blocked. Contact support.");
        }
        else if (purpose == "signup")
        {
            if (user is not null)
                throw new ConflictException("This mobile number already has an account. Sign in instead.", "account_exists");
            var cfg = await authSettings.GetAsync();
            if (!(forSeller ? cfg.Bool("seller_signup") : cfg.Bool("customer_signup")))
                throw new AppException("New accounts are paused right now. Please try again later.", "signup_closed", 403);
        }
        return user;
    }

    /// <summary>Reference: request_otp.</summary>
    public async Task<JsonObject> RequestOtpAsync(string phone, string purpose, bool forSeller, string ip)
    {
        phone = NormalizeMobile(phone);
        var cfg = await authSettings.GetAsync();
        // Count the attempt before telling anyone whether a number has an account (limits number probing).
        await rateLimit.RateLimitAsync($"otp:ip:{ip}", cfg.Int("otp_max_per_ip_hour"), 3600);
        await CheckPurposeAsync(phone, purpose, forSeller);
        var now = DateTimeFunctions.UtcNow();
        var latest = await db.QueryFirstOrDefaultAsync<OtpChallengeModel>(
            "SELECT * FROM otp_challenges WHERE phone = @phone ORDER BY created_at DESC LIMIT 1", new { phone });
        var cooldown = cfg.Int("otp_resend_cooldown_seconds");
        if (latest is not null && (now - latest.CreatedAt).TotalSeconds < cooldown)
        {
            var wait = cooldown - (int)(now - latest.CreatedAt).TotalSeconds;
            throw new TooManyRequestsException($"Please wait {wait} seconds before requesting another OTP");
        }
        await rateLimit.RateLimitAsync($"otp:phone:{phone}", cfg.Int("otp_max_per_hour"), 3600);

        var code = OtpHelper.Generate(cfg.Int("otp_length"));
        await using var uow = await db.BeginAsync();
        // Only the newest challenge for a phone is valid.
        await uow.ExecuteAsync("UPDATE otp_challenges SET consumed_at = @now WHERE phone = @phone AND consumed_at IS NULL",
            new { now, phone });
        await uow.ExecuteAsync(
            "INSERT INTO otp_challenges (phone, code_hash, expires_at, created_at, ip, attempts, id) " +
            "VALUES (@phone, @hash, @exp, @now, @ip, 0, @id)",
            new { phone, hash = OtpHelper.Hash(app.JwtSecret, phone, code), exp = now.AddSeconds(cfg.Int("otp_ttl_seconds")), now, ip, id = Guid.NewGuid() });
        await uow.CommitAsync();

        var icfg = await integrations.GetAsync();
        try
        {
            await sms.SendOtpAsync(new SMSModel { Phone = phone, OtpCode = code }, new SmsConfig
            {
                Provider = icfg.SmsProvider, AuthKey = icfg.Msg91AuthKey, OtpTemplateId = icfg.Msg91OtpTemplateId,
                SenderId = icfg.Msg91SenderId, ApiBase = icfg.Msg91ApiBase,
            });
        }
        catch (AppException)
        {
            throw;
        }
        catch (Exception exc)
        {
            throw new AppException(exc.Message, "sms_failed", 503);
        }
        var result = new JsonObject
        {
            ["sent"] = true, ["expires_in"] = cfg.Int("otp_ttl_seconds"),
            ["resend_in"] = cooldown, ["length"] = cfg.Int("otp_length"),
        };
        if ((await authSettings.DevOtpStatusAsync()).Active)
            result["dev_otp"] = code; // test installs only: never in production or with real SMS
        return result;
    }

    /// <summary>Reference: auth_options.</summary>
    public async Task<JsonObject> OptionsAsync()
    {
        var cfg = await authSettings.GetAsync();
        return new JsonObject
        {
            ["customer_signup"] = cfg.Bool("customer_signup"), ["seller_signup"] = cfg.Bool("seller_signup"),
            ["signup_email"] = cfg["signup_email"]?.GetValue<string>(), ["otp_length"] = cfg.Int("otp_length"),
            ["dev_otp"] = (await authSettings.DevOtpStatusAsync()).Active,
            ["password_min_length"] = cfg.Int("password_min_length"),
            ["password_require_mixed"] = cfg.Bool("password_require_mixed"),
        };
    }

    /// <summary>Reference: verify_otp.</summary>
    public async Task<(UserModel User, string RefreshToken, int Days, bool IsNew)> VerifyOtpAsync(string phone, string code,
        string purpose, string name, string? email, bool acceptTerms, bool marketingOptIn, bool forSeller, string userAgent)
    {
        phone = NormalizeMobile(phone);
        var now = DateTimeFunctions.UtcNow();
        var signup = purpose == "signup";
        name = string.Join(' ', name.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        email = string.IsNullOrEmpty(email) ? null : email.ToLowerInvariant();
        if (signup)
        {
            var cfg = await authSettings.GetAsync();
            if (name.Length < 2)
                throw new AppException("Enter your name", "name_required", 400, new Dictionary<string, string> { ["name"] = "Required" });
            if (!acceptTerms)
                throw new AppException("Please accept the terms of use and privacy policy", "terms_required", 400,
                    new Dictionary<string, string> { ["accept_terms"] = "Required" });
            var emailMode = cfg["signup_email"]?.GetValue<string>() ?? "optional";
            if (emailMode == "required" && email is null)
                throw new AppException("Enter your email", "email_required", 400, new Dictionary<string, string> { ["email"] = "Required" });
            if (emailMode == "hidden")
                email = null;
            if (email is not null && await db.ExecuteScalarAsync<long>(
                    "SELECT COUNT(*) FROM users WHERE email = @email", new { email }) > 0)
                throw new AppException("This email is already used by another account", "email_taken", 400,
                    new Dictionary<string, string> { ["email"] = "Already in use" });
        }

        await using var uow = await db.BeginAsync();
        var challenge = await uow.QueryFirstOrDefaultAsync<OtpChallengeModel>(
            "SELECT * FROM otp_challenges WHERE phone = @phone AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
            new { phone });
        if (challenge is null || challenge.ExpiresAt < now)
            throw new AppException("This OTP has expired. Please request a new one.", "otp_expired");
        var maxAttempts = (await authSettings.GetAsync()).Int("otp_max_attempts");
        if (challenge.Attempts >= maxAttempts)
            throw new TooManyRequestsException("Too many wrong attempts. Please request a new OTP.");
        if (OtpHelper.Hash(app.JwtSecret, phone, code.Trim()) != challenge.CodeHash)
        {
            await uow.ExecuteAsync("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = @id", new { challenge.Id });
            await uow.CommitAsync();
            var left = maxAttempts - challenge.Attempts - 1;
            throw new AppException(left > 0 ? $"Incorrect OTP. {left} attempt(s) left." : "Incorrect OTP.", "otp_invalid");
        }
        await uow.ExecuteAsync("UPDATE otp_challenges SET consumed_at = @now WHERE id = @id", new { now, challenge.Id });

        var user = await uow.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE phone = @phone", new { phone });
        var isNew = user is null;
        if (user is null)
        {
            if (purpose == "signin")
            {
                await uow.CommitAsync();
                throw new AppException("No account uses this mobile number yet. Create an account to continue.", "no_account", 404);
            }
            // Creating an account records acceptance of the terms and privacy notice shown on the screen.
            user = new UserModel
            {
                Id = Guid.NewGuid(), Phone = phone, Name = name, Email = email, TermsAcceptedAt = now,
                MarketingOptIn = signup && marketingOptIn, IsActive = true, CreatedAt = now, UpdatedAt = now, UiPrefs = "{}",
            };
            await uow.ExecuteAsync(
                "INSERT INTO users (id, phone, name, email, terms_accepted_at, marketing_opt_in, is_active, ui_prefs, created_at, updated_at) " +
                "VALUES (@Id, @Phone, @Name, @Email, @TermsAcceptedAt, @MarketingOptIn, @IsActive, @UiPrefs, @CreatedAt, @UpdatedAt)", user);
        }
        else if (name.Length > 0 && user.Name.Length == 0)
        {
            await uow.ExecuteAsync("UPDATE users SET name = @name, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
                new { name, uid = user.Id });
            user.Name = name;
        }
        if (!user.IsActive)
        {
            await uow.CommitAsync();
            throw new ForbiddenException("This account has been blocked. Contact support.");
        }
        await uow.CommitAsync();
        var (token, days) = await IssueSessionAsync(user, userAgent, newSignIn: true);
        return (user, token, days, isNew);
    }

    /// <summary>Reference: password_login.</summary>
    public async Task<(UserModel User, string RefreshToken, int Days)> PasswordLoginAsync(string email, string password,
        string totp, string ip, string userAgent)
    {
        email = email.ToLowerInvariant();
        var cfg = await authSettings.GetAsync();
        var window = cfg.Int("login_lockout_minutes") * 60;
        await rateLimit.RateLimitAsync($"login:{email}", cfg.Int("login_max_attempts"), window);
        await rateLimit.RateLimitAsync($"login-ip:{ip}", Math.Max(50, cfg.Int("login_max_attempts") * 5), window);
        var user = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE email = @email", new { email });
        if (user is null || !EncryptDecrypt.VerifyPassword(password, user.PasswordHash))
            throw new UnauthorizedException("Incorrect email or password");
        if (!user.IsActive)
            throw new ForbiddenException("This account has been blocked");
        if (user.TotpEnabled)
        {
            if (totp.Length == 0)
                throw new AppException("Enter the 6-digit code from your authenticator app", "totp_required", 401);
            if (!TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), totp))
                throw new UnauthorizedException("The authenticator code is not correct");
        }
        var (token, days) = await IssueSessionAsync(user, userAgent, newSignIn: true);
        return (user, token, days);
    }

    /// <summary>Reference: change_password.</summary>
    public async Task ChangePasswordAsync(UserModel user, string currentPassword, string newPassword)
    {
        if (!EncryptDecrypt.VerifyPassword(currentPassword, user.PasswordHash))
            throw new AppException("Your current password is not correct", "wrong_password", 400,
                new Dictionary<string, string> { ["current_password"] = "Incorrect" });
        var problem = authSettings.PasswordProblem(await authSettings.GetAsync(), newPassword);
        if (problem is not null)
            throw new AppException(problem, "weak_password", 400, new Dictionary<string, string> { ["new_password"] = problem });
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync("UPDATE users SET password_hash = @hash, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
            new { hash = EncryptDecrypt.HashPassword(newPassword), uid = user.Id });
        await uow.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE user_id = @uid AND revoked_at IS NULL",
            new { uid = user.Id });
        await uow.CommitAsync();
    }

    /// <summary>Reference: totp_setup.</summary>
    public async Task<JsonObject> TotpSetupAsync(UserModel user)
    {
        if (user.TotpEnabled)
            throw new AppException("Two-step sign-in is already on", "totp_on");
        var secret = TotpHelper.NewSecret();
        await db.ExecuteAsync("UPDATE users SET totp_secret_enc = @enc, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
            new { enc = crypto.Encrypt(secret), uid = user.Id });
        var brand = (await site.GetSiteAsync())["brand_name"]?.GetValue<string>() ?? app.AppName;
        return new JsonObject
        {
            ["secret"] = secret,
            ["uri"] = TotpHelper.Uri(secret, user.Email ?? user.Phone ?? user.Id.ToString(), brand),
        };
    }

    /// <summary>Reference: _totp_attempt — 5 code attempts per 15 minutes.</summary>
    private Task TotpAttemptAsync(UserModel user) => rateLimit.RateLimitAsync($"totp:{user.Id}", 5, 900);

    /// <summary>Reference: totp_enable.</summary>
    public async Task TotpEnableAsync(UserModel user, string code)
    {
        await TotpAttemptAsync(user);
        if (user.TotpSecretEnc is null || !TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), code))
            throw new AppException("That code is not correct. Check the time on your phone and try again.", "totp_invalid");
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync("UPDATE users SET totp_enabled = 1, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid", new { uid = user.Id });
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, 'account.totp_on', 'user', @eid, '', UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, eid = user.Id.ToString(), id = Guid.NewGuid() });
        await uow.CommitAsync();
    }

    /// <summary>Reference: totp_disable.</summary>
    public async Task TotpDisableAsync(UserModel user, string code, string password)
    {
        await TotpAttemptAsync(user);
        if (user.PasswordHash is not null && !EncryptDecrypt.VerifyPassword(password, user.PasswordHash))
            throw new AppException("Enter your current password to turn off two-step sign-in", "wrong_password", 400,
                new Dictionary<string, string> { ["password"] = "Incorrect" });
        if (!user.TotpEnabled || !TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), code))
            throw new AppException("That code is not correct", "totp_invalid");
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync(
            "UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid", new { uid = user.Id });
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, 'account.totp_off', 'user', @eid, '', UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, eid = user.Id.ToString(), id = Guid.NewGuid() });
        await uow.CommitAsync();
        // Reference notifies on every channel; this build has in-app only.
        await notify.NotifyUserAsync(user.Id, "security_notice", new Dictionary<string, string>
        {
            ["what"] = "two-step sign-in turned off",
            ["message"] = "Two-step sign-in was turned off on your account. Only your password is now needed to sign in.",
        });
    }

    /// <summary>Reference: refresh (token rotation with replay detection).</summary>
    public async Task<(UserModel User, string RefreshToken, int Days)> RefreshAsync(string rawToken, string userAgent)
    {
        if (rawToken.Length == 0)
            throw new UnauthorizedException();
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        var row = await uow.QueryFirstOrDefaultAsync<RefreshSessionModel>(
            "SELECT * FROM refresh_sessions WHERE token_hash = @hash FOR UPDATE", new { hash = EncryptDecrypt.Sha256(rawToken) })
            ?? throw new UnauthorizedException();
        if (row.RevokedAt is not null)
        {
            var owner = await uow.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @uid", new { uid = row.UserId });
            if (owner?.SessionsValidAfter is not null && row.RevokedAt == owner.SessionsValidAfter)
                // this device was signed out from another one: refuse it, nothing more
                throw new UnauthorizedException("You were signed out on this device. Please sign in again.");
            // The same browser racing itself: renew quietly only when this token was rotated within the grace window.
            if (now - row.RevokedAt.Value <= ReuseGrace && (row.UserAgent ?? "") == userAgent)
            {
                var rotated = await uow.ExecuteScalarAsync<long>(
                    "SELECT COUNT(*) FROM refresh_sessions WHERE user_id = @uid AND user_agent = @agent " +
                    "AND created_at >= @revoked AND created_at <= @grace",
                    new { uid = row.UserId, agent = row.UserAgent ?? "", revoked = row.RevokedAt.Value, grace = row.RevokedAt.Value.AddSeconds(5) }) > 0;
                if (rotated && owner is not null && owner.IsActive)
                {
                    await uow.CommitAsync();
                    var (t, d) = await IssueSessionAsync(owner, userAgent, newSignIn: false);
                    return (owner, t, d);
                }
            }
            // A rotated token was replayed: assume theft and end every session of this user.
            await uow.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = @now WHERE user_id = @uid AND revoked_at IS NULL",
                new { now, uid = row.UserId });
            await uow.CommitAsync();
            throw new UnauthorizedException();
        }
        if (row.ExpiresAt < now)
            throw new UnauthorizedException();
        var user = await uow.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @uid", new { uid = row.UserId });
        if (user is null || !user.IsActive)
            throw new UnauthorizedException();
        await uow.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = @now WHERE id = @id", new { now, row.Id });
        await uow.CommitAsync();
        var (token, days) = await IssueSessionAsync(user, userAgent, newSignIn: false);
        return (user, token, days);
    }

    /// <summary>Reference: logout.</summary>
    public async Task LogoutAsync(string? rawToken)
    {
        if (string.IsNullOrEmpty(rawToken))
            return;
        await db.ExecuteAsync(
            "UPDATE refresh_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE token_hash = @hash AND revoked_at IS NULL",
            new { hash = EncryptDecrypt.Sha256(rawToken) });
    }

    /// <summary>Reference: list_sessions.</summary>
    public async Task<JsonObject> SessionsAsync(UserModel user, string? rawToken)
    {
        var current = EncryptDecrypt.Sha256(rawToken ?? "");
        var rows = await db.QueryAsync<RefreshSessionModel>(
            "SELECT * FROM refresh_sessions WHERE user_id = @uid AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(6) " +
            "ORDER BY created_at DESC LIMIT 50", new { uid = user.Id });
        return new JsonObject
        {
            ["sessions"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject
            {
                ["id"] = r.Id.ToString(), ["device"] = Device(r.UserAgent),
                ["last_active"] = r.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["expires_at"] = r.ExpiresAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["current"] = r.TokenHash == current,
            }).ToArray()),
        };
    }

    /// <summary>Reference: sign_out_others.</summary>
    public async Task<JsonObject> SignOutOthersAsync(UserModel user, string? rawToken)
    {
        var now = DateTimeFunctions.UtcNow();
        var current = EncryptDecrypt.Sha256(rawToken ?? "");
        await using var uow = await db.BeginAsync();
        var count = await uow.ExecuteAsync(
            "UPDATE refresh_sessions SET revoked_at = @now WHERE user_id = @uid AND revoked_at IS NULL AND token_hash != @current",
            new { now, uid = user.Id, current });
        await uow.ExecuteAsync("UPDATE users SET sessions_valid_after = @now, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
            new { now, uid = user.Id });
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, 'account.sign_out_others', 'user', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, eid = user.Id.ToString(), detail = $"sessions={count}", id = Guid.NewGuid() });
        await uow.CommitAsync();
        await notify.NotifyUserAsync(user.Id, "security_notice", new Dictionary<string, string>
        {
            ["what"] = "other devices signed out",
            ["message"] = "All other devices were signed out of your account. If this was not you, change your password now.",
        });
        return new JsonObject { ["signed_out"] = count };
    }

    /// <summary>Reference: update_me.</summary>
    public async Task<JsonObject> UpdateMeAsync(UserModel user, string? name, string? email)
    {
        if (name is not null)
        {
            await db.ExecuteAsync("UPDATE users SET name = @name, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
                new { name = name.Trim(), uid = user.Id });
            user.Name = name.Trim();
        }
        if (email is not null)
        {
            email = email.ToLowerInvariant();
            var taken = await db.ExecuteScalarAsync<long>(
                "SELECT COUNT(*) FROM users WHERE email = @email AND id != @uid", new { email, uid = user.Id }) > 0;
            if (taken)
                throw new AppException("This email is already used by another account", "email_taken", 400,
                    new Dictionary<string, string> { ["email"] = "Already in use" });
            await db.ExecuteAsync("UPDATE users SET email = @email, updated_at = UTC_TIMESTAMP(6) WHERE id = @uid",
                new { email, uid = user.Id });
            user.Email = email;
        }
        return await UserPayloadAsync(user);
    }
}
