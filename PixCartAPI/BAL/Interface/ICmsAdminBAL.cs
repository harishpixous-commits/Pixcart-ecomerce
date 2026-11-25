using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public partial interface ICmsAdminBAL
{
    Task<JsonObject> SiteAsync(UserModel user);
    Task<JsonObject> SaveSiteAsync(UserModel user,JsonObject body);
    Task<JsonObject> SaveThemeAsync(UserModel user,string theme,JsonObject settings);
    Task<JsonArray> PagesAsync(UserModel user);
    Task<JsonObject> SavePageAsync(UserModel user,string original,string slug,string title,string body,string description,bool published);
    Task<JsonObject> DeletePageAsync(UserModel user,string slug);
}
