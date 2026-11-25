using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Model.Constants;
namespace BAL;
public class AdminSellerListBAL(AdminSellerListDAL data,IAccessBAL access):IAdminSellerListBAL
{
    public async Task<JsonObject> ListAsync(UserModel user,string? status,string q,int page,int size)
    {await access.RequireAsync(user,"sellers");q=q.Trim();var total=await data.CountAsync(status,q);return new(){["items"]=new JsonArray((await data.ListAsync(status,q,(page-1)*size,size)).Select(s=>(JsonNode)new JsonObject{["id"]=s.Id.ToString(),["display_name"]=s.DisplayName,["legal_name"]=s.LegalName,["gstin"]=s.Gstin,["status"]=s.Status,["city"]=s.PickupCity,["state"]=IndianStates.Name(s.PickupStateCode),["submitted_at"]=s.SubmittedAt?.ToString("o"),["created_at"]=s.CreatedAt.ToString("o")}).ToArray()),["total"]=total,["page"]=page,["page_size"]=size,["status_counts"]=new JsonObject((await data.CountsAsync()).Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Status,JsonValue.Create(x.N))))};}
}
