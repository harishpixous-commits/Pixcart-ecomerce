using System.Text.Json.Nodes;
using Model.DomainModel.Integrations;
namespace BAL.Interface;
public interface IPayoutGatewayBAL{Task<JsonObject> PostAsync(IntegrationSettings config,string path,JsonObject body,string? idempotency=null);}
