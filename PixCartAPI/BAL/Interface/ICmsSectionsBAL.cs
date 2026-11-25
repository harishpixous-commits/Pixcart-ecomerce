using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public partial interface ICmsAdminBAL
{
    Task<JsonObject> SectionsAsync(UserModel user);
    Task<JsonObject> SaveSectionAsync(UserModel user,Guid? id,HomeSectionModel body);
    Task<JsonObject> DeleteSectionAsync(UserModel user,Guid id);
    Task<JsonObject> ReorderAsync(UserModel user,Guid[] ids);
}
