using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public partial interface ICmsAdminBAL
{
    Task<JsonArray> PagesAsync(UserModel user);
    Task<JsonObject> SavePageAsync(UserModel user,string original,string slug,string title,string body,string description,bool published);
    Task<JsonObject> DeletePageAsync(UserModel user,string slug);
}
