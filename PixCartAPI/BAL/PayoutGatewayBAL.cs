using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel.Integrations;
using Utils;
namespace BAL;
public class PayoutGatewayBAL(IHttpClientFactory factory):IPayoutGatewayBAL
{
    public const string HttpClientName="payout-razorpayx";
    public async Task<JsonObject> PostAsync(IntegrationSettings config,string path,JsonObject body,string? idempotency=null)
    {
        var client=factory.CreateClient(HttpClientName);client.Timeout=TimeSpan.FromSeconds(20);using var req=new HttpRequestMessage(HttpMethod.Post,config.RazorpayApiBase.TrimEnd('/')+path);req.Headers.Authorization=new AuthenticationHeaderValue("Basic",Convert.ToBase64String(Encoding.UTF8.GetBytes(config.RazorpayKeyId+":"+config.RazorpayKeySecret)));if(idempotency is not null)req.Headers.Add("X-Payout-Idempotency",idempotency);req.Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json");using var response=await client.SendAsync(req);var text=await response.Content.ReadAsStringAsync();if((int)response.StatusCode>=400){var desc=JsonNode.Parse(text)?["error"]?["description"]?.GetValue<string>()??text[..Math.Min(200,text.Length)];throw new AppException("RazorpayX: "+desc,"payout_gateway",502);}return JsonNode.Parse(text)!.AsObject();
    }
}
