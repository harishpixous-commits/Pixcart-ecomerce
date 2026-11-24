using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminPayoutBAL{Task<JsonObject> ListAsync(UserModel user,string? status,Guid? seller,int page);Task<JsonObject> ChangeAsync(UserModel user,Guid id,string action,string utr="");}
