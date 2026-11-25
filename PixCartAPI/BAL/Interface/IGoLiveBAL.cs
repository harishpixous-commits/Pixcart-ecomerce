using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface IGoLiveBAL{Task<JsonObject> ReadAsync(UserModel user);}
