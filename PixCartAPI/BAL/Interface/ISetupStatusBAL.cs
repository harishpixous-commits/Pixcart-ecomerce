using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface ISetupStatusBAL{Task<JsonObject> ReadAsync(UserModel user);}
