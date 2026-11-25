using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IShopAppAdminBAL{Task<JsonObject> UploadAsync(UserModel user,byte[] bytes,string version,CancellationToken ct);}
