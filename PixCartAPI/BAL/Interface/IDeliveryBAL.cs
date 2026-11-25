using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Delivery partner registration and profile (reference: routers/delivery.py).</summary>
public interface IDeliveryBAL
{
    Task<JsonObject> OptionsAsync();
    Task<DeliveryBoyModel> RequirePartnerAsync(UserModel user);
    Task<DeliveryBoyModel> RequireApprovedAsync(UserModel user);
    Task<JsonObject> MeAsync(UserModel user);
    Task<JsonObject> RegisterAsync(UserModel user, DeliveryProfile profile);
    Task<JsonObject> UpdateMeAsync(UserModel user, DeliveryProfile profile);
    Task<JsonObject> SetBankAsync(UserModel user, string holder, string accountNumber, string confirmAccountNumber, string ifsc, string upi);
    Task<JsonObject> SubmitAsync(UserModel user);
    Task<JsonObject> SetOnlineAsync(UserModel user, bool online);
    Task<JsonObject> UploadDocAsync(UserModel user, string kind, byte[] data);
    Task<(byte[] Data, string Media, string FileName)> ReadDocAsync(UserModel user, string kind);
    JsonObject PartnerOut(DeliveryBoyModel b, DeliveryZoneModel? zone, JsonObject cfg);
    Task ApplyProfileAsync(DeliveryBoyModel b, DeliveryProfile p);
}

/// <summary>The registration/profile form; null leaves a field unchanged (reference: ProfileIn).</summary>
public sealed record DeliveryProfile(
    string? Name = null, string? City = null, string? Address = null, Guid? ZoneId = null,
    string? VehicleType = null, string? VehicleNo = null, string? LicenseNo = null,
    string? IdProofType = null, string? IdProofNo = null);
