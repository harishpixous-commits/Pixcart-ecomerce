using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface INotificationAdminBAL
{
    Task<JsonObject> TemplatesAsync(UserModel u);
    Task<JsonObject> SaveAsync(UserModel u,string evt,string channel,string subject,string body,string provider,bool active);
    Task<JsonArray> CouponsAsync(UserModel u);
}
