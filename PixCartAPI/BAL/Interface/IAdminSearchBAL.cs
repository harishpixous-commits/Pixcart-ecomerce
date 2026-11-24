using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAdminSearchBAL{Task<JsonObject> SearchAsync(UserModel user,string q);}
