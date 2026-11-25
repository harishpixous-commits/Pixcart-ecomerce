using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminDashboardBAL{Task<JsonObject> ReadAsync(UserModel user);}
