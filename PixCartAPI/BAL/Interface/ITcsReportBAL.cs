using System.Text.Json.Nodes;
using Model.DomainModel;
namespace BAL.Interface;
public interface ITcsReportBAL{Task<JsonObject> ReadAsync(UserModel user,string month);}
