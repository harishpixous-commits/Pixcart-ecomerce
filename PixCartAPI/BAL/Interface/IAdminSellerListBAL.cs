using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminSellerListBAL{Task<JsonObject> ListAsync(UserModel user,string? status,string q,int page,int size);}
