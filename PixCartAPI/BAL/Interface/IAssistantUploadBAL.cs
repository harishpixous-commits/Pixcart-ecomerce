using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IAssistantUploadBAL{Task<JsonObject> StoreAsync(UserModel user,string filename,string contentType,byte[] bytes);Task<JsonObject> DeleteAsync(UserModel user,Guid id);}
