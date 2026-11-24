using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Privacy rights (reference: routers/customer.py consent, export_data, delete_account — DPDP Act 2023).</summary>
public interface IPrivacyBAL
{
    /// <summary>Reference: consent — records the marketing choice and audits it.</summary>
    Task<JsonObject> ConsentAsync(UserModel user, bool marketingOptIn);

    /// <summary>Reference: export_data — right to access: the personal data held.</summary>
    Task<JsonObject> ExportAsync(UserModel user);

    /// <summary>Reference: delete_account — right to erasure: anonymises the account while tax records stay.</summary>
    Task<JsonObject> DeleteAccountAsync(UserModel user);
}
