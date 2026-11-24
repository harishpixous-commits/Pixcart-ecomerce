using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminProductReadBAL
{
    Task<JsonObject> ListAsync(UserModel user,string? status,string q,Guid? seller,int page,int size);
    Task<JsonObject> DetailAsync(UserModel user,Guid id);
}
