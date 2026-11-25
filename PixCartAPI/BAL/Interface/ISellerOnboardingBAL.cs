using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.Auth;
namespace BAL.Interface;
/// <summary>Seller registration and KYC, with masked owner responses and private documents.</summary>
public interface ISellerOnboardingBAL
{
    Task<SellerModel> OwnAsync(UserModel user);
    Task<JsonObject> MeAsync(UserModel user);
    Task<JsonObject> RegisterAsync(UserModel user,string name);
    Task<JsonObject> ProfileAsync(UserModel user,SellerProfileIn body);
    Task<JsonObject> StoreAsync(UserModel user,string name,string description,string email,string phone);
    Task<JsonObject> PickupAsync(UserModel user,SellerPickupIn body);
    Task<JsonObject> BankAsync(UserModel user,SellerBankIn body);
    Task<JsonObject> GrievanceAsync(UserModel user,SellerGrievanceIn body);
    Task<JsonObject> UploadAsync(UserModel user,string kind,byte[] bytes,string filename,CancellationToken ct);
    Task<(byte[] Bytes,string Type,string Name)> DownloadAsync(UserModel user,string kind,CancellationToken ct);
    Task<(byte[] Bytes,string Type,string Name)> AdminDocumentAsync(UserModel user,Guid sellerId,string kind,CancellationToken ct);
    Task<JsonObject> SubmitAsync(UserModel user);
}
