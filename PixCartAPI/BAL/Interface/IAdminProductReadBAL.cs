using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminProductReadBAL
{
    Task<JsonObject> ListAsync(UserModel user,string? status,string q,Guid? seller,int page,int size);
    Task<JsonObject> AiCheckAsync(UserModel user,Guid id);
    Task<JsonObject> DetailAsync(UserModel user,Guid id);
}
