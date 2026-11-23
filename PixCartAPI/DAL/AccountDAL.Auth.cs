using System.Data;
using Model.DomainModel;

namespace DAL;

/// <summary>Sign-in: users, one-time codes, refresh sessions (the auth module's part of AccountDAL).</summary>
public partial class AccountDAL
{
    private const string UserColumns =
        "phone, email, name, password_hash, is_admin, is_active, last_login_at, admin_role, totp_secret_enc, totp_enabled, marketing_opt_in, " +
        "terms_accepted_at, deleted_at, ui_prefs, sessions_valid_after, razorpay_customer_id, id, created_at, updated_at";

    // ---------------------------------------------------------------- users

    public Task<UserModel?> GetUserAsync(Guid id, IDbTransaction? tx) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id }, tx);

    public Task<UserModel?> GetUserByPhoneAsync(string phone, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE phone = @phone", new { phone }, tx);

    public Task<UserModel?> GetUserByEmailAsync(string email, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE email = @email", new { email }, tx);

    /// <summary>True when another account (not <paramref name="except"/>) uses the email.</summary>
    public async Task<bool> EmailTakenAsync(string email, Guid? except = null, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM users WHERE email = @email AND (@except IS NULL OR id <> @except)", new { email, except }, tx) > 0;

    public async Task<bool> PhoneTakenAsync(string phone, Guid? except = null, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM users WHERE phone = @phone AND (@except IS NULL OR id <> @except)", new { phone, except }, tx) > 0;

    public Task InsertUserAsync(UserModel u, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            $"INSERT INTO users ({UserColumns}) VALUES (@Phone, @Email, @Name, @PasswordHash, @IsAdmin, @IsActive, @LastLoginAt, @AdminRole, @TotpSecretEnc, " +
            "@TotpEnabled, @MarketingOptIn, @TermsAcceptedAt, @DeletedAt, CAST(@UiPrefs AS JSON), @SessionsValidAfter, @RazorpayCustomerId, @Id, @CreatedAt, @UpdatedAt)",
            u, tx);

    /// <summary>Writes every field of the account this module changes (not the payment module's razorpay_customer_id).</summary>
    public Task SaveUserAsync(UserModel u, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE users SET phone = @Phone, email = @Email, name = @Name, password_hash = @PasswordHash, is_admin = @IsAdmin, is_active = @IsActive, " +
            "last_login_at = @LastLoginAt, admin_role = @AdminRole, totp_secret_enc = @TotpSecretEnc, totp_enabled = @TotpEnabled, " +
            "marketing_opt_in = @MarketingOptIn, terms_accepted_at = @TermsAcceptedAt, deleted_at = @DeletedAt, ui_prefs = CAST(@UiPrefs AS JSON), " +
            "sessions_valid_after = @SessionsValidAfter, updated_at = @UpdatedAt WHERE id = @Id",
            u, tx);

    public Task<DeliveryBoyModel?> GetDeliveryPartnerByUserAsync(Guid userId, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<DeliveryBoyModel>("SELECT * FROM delivery_boys WHERE user_id = @userId", new { userId }, tx);

    public Task<SellerModel?> GetSellerByUserAsync(Guid userId, IDbTransaction? tx) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE user_id = @userId", new { userId }, tx);

    // ---------------------------------------------------------------- one-time codes

    public Task<OtpChallengeModel?> LatestChallengeAsync(string phone) =>
        db.QueryFirstOrDefaultAsync<OtpChallengeModel>("SELECT * FROM otp_challenges WHERE phone = @phone ORDER BY created_at DESC LIMIT 1", new { phone });

    /// <summary>The newest unused code for the number, locked until the transaction ends.</summary>
    public Task<OtpChallengeModel?> LatestOpenChallengeForUpdateAsync(string phone, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<OtpChallengeModel>(
            "SELECT * FROM otp_challenges WHERE phone = @phone AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE", new { phone }, tx);

    /// <summary>Only the newest challenge for a phone is valid: every open one is marked used.</summary>
    public Task ConsumeOpenChallengesAsync(string phone, DateTime at, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE otp_challenges SET consumed_at = @at WHERE phone = @phone AND consumed_at IS NULL", new { phone, at }, tx);

    public Task InsertChallengeAsync(OtpChallengeModel c, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO otp_challenges (phone, code_hash, attempts, expires_at, consumed_at, created_at, ip, id) " +
            "VALUES (@Phone, @CodeHash, @Attempts, @ExpiresAt, @ConsumedAt, @CreatedAt, @Ip, @Id)", c, tx);

    public Task UpdateChallengeAsync(OtpChallengeModel c, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE otp_challenges SET attempts = @Attempts, consumed_at = @ConsumedAt WHERE id = @Id", c, tx);

    /// <summary>Codes older than the cut-off (cleanup job).</summary>
    public Task<int> DeleteChallengesBeforeAsync(DateTime before) =>
        db.ExecuteAsync("DELETE FROM otp_challenges WHERE created_at < @before", new { before });

    // ---------------------------------------------------------------- refresh sessions (one per signed-in device)

    public Task InsertSessionAsync(RefreshSessionModel s, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO refresh_sessions (user_id, token_hash, created_at, expires_at, revoked_at, user_agent, id) " +
            "VALUES (@UserId, @TokenHash, @CreatedAt, @ExpiresAt, @RevokedAt, @UserAgent, @Id)", s, tx);

    public Task<RefreshSessionModel?> GetSessionByHashForUpdateAsync(string tokenHash, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<RefreshSessionModel>("SELECT * FROM refresh_sessions WHERE token_hash = @tokenHash FOR UPDATE", new { tokenHash }, tx);

    public Task RevokeSessionAsync(Guid id, DateTime at, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = @at WHERE id = @id", new { id, at }, tx);

    /// <summary>Ends every open session of the user; returns how many.</summary>
    public Task<int> RevokeAllSessionsAsync(Guid userId, DateTime at, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = @at WHERE user_id = @userId AND revoked_at IS NULL", new { userId, at }, tx);

    public Task<int> RevokeOtherSessionsAsync(Guid userId, string keepHash, DateTime at, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = @at WHERE user_id = @userId AND revoked_at IS NULL AND token_hash <> @keepHash",
            new { userId, keepHash, at }, tx);

    public Task<int> RevokeSessionByHashAsync(string tokenHash, DateTime at) =>
        db.ExecuteAsync("UPDATE refresh_sessions SET revoked_at = @at WHERE token_hash = @tokenHash AND revoked_at IS NULL", new { tokenHash, at });

    public Task<IEnumerable<RefreshSessionModel>> ActiveSessionsAsync(Guid userId, DateTime now, int limit, IDbTransaction? tx = null) =>
        db.QueryAsync<RefreshSessionModel>(
            "SELECT * FROM refresh_sessions WHERE user_id = @userId AND revoked_at IS NULL AND expires_at > @now ORDER BY created_at DESC LIMIT @limit",
            new { userId, now, limit }, tx);

    /// <summary>A session from the same browser that began right after the given one was rotated (the reload race).</summary>
    public async Task<bool> RotatedSessionExistsAsync(Guid userId, string? userAgent, DateTime from, DateTime to, IDbTransaction tx) =>
        await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM refresh_sessions WHERE user_id = @userId AND user_agent <=> @userAgent AND created_at >= @from AND created_at <= @to",
            new { userId, userAgent, from, to }, tx) > 0;
}
