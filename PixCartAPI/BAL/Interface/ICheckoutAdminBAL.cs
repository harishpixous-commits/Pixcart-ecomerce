using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface ICheckoutAdminBAL{Task<JsonObject> ReadAsync(UserModel user);Task<JsonObject> SaveAsync(UserModel user,JsonObject body);Task<JsonObject> PreviewAsync(UserModel user,JsonObject body);}
