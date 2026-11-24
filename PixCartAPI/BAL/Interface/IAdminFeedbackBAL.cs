using System.Text.Json.Nodes;
using DAL;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminFeedbackBAL
{
    Task<JsonObject> ReviewsAsync(UserModel user,AdminReviewQuery q,int page);
    Task<JsonObject> ReportsAsync(UserModel user,AdminReportQuery q,int page);
    Task<JsonObject> SettingsAsync(UserModel user);
    Task<JsonObject> SettingsAsync(UserModel user,JsonObject body);
    Task<JsonObject> ResolveAsync(UserModel user,Guid id,string status,string note,bool takeDown,bool notify);
}
