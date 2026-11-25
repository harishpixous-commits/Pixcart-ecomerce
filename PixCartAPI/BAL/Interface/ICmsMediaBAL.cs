using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface ICmsMediaBAL
{
    Task<JsonArray> ListAsync(UserModel user,string? kind);
    Task<JsonObject> UploadAsync(UserModel user,byte[] bytes,string label,CancellationToken ct);
}
