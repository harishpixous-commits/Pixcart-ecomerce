using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminProductMediaBAL
{
    Task<JsonObject> SaveAsync(UserModel user,Guid id,string[]? images,ProductVideoModel[]? videos);
}
