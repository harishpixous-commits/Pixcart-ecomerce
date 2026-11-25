using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminCategoriesBAL
{
    Task<JsonObject> RequirementsAsync(UserModel user);
    Task<JsonArray> ListAsync(UserModel user);
    Task<JsonObject> SaveAsync(UserModel user,Guid? id,CategoryModel body);
}
