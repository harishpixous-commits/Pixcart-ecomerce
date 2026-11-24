using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminAnalyticsBAL{Task<JsonObject> ReadAsync(UserModel user,int days);}
