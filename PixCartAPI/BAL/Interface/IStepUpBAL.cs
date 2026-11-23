using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Asking a signed-in person to prove it is them again before a sensitive change (keys, where money goes).</summary>
public interface IStepUpBAL
{
    /// <summary>
    /// Passes only with the account password and, when two-step sign-in is on, the current authenticator code; else 403
    /// "wrong_password" or "totp_required". Attempts are rate-limited per person and <paramref name="purpose"/> (30 in 10
    /// minutes) and kept even when the check fails. Call it before changing anything. The reference <c>core.step_up.confirm_identity</c>.
    /// </summary>
    Task ConfirmIdentityAsync(UserModel user, string password, string code, string purpose);
}
