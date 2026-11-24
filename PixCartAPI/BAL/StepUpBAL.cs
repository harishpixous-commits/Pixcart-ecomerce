using BAL.Interface;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <inheritdoc cref="IStepUpBAL"/>
public class StepUpBAL(IRateLimitBAL limits, EncryptDecrypt crypto) : IStepUpBAL
{
    public async Task ConfirmIdentityAsync(UserModel user, string password, string code, string purpose)
    {
        await limits.RateLimitAsync($"{purpose}:{user.Id}", 30, 600);
        if (!EncryptDecrypt.VerifyPassword(password, user.PasswordHash))
            throw new AppException("Your password is not correct", "wrong_password", 403, new Dictionary<string, string> { ["password"] = "Incorrect" });
        if (user.TotpEnabled && !TotpHelper.Verify(crypto.Decrypt(user.TotpSecretEnc), code))
            throw new AppException("Enter the current 6-digit code from your authenticator app", "totp_required", 403,
                new Dictionary<string, string> { ["totp"] = "Required" });
    }
}
