using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
namespace BAL;
public class AdminListsBAL(AdminListsDAL data,IAccessBAL access):IAdminListsBAL
{
    public async Task<JsonObject> CustomersAsync(UserModel user,string q,int page,int size,string kind,string tag="")
    {await access.RequireAsync(user,"customers");q=q.Trim();var total=await data.CustomerCountAsync(q,kind,tag.Trim());var items=new JsonArray();foreach(var u in await data.CustomersAsync(q,kind,(page-1)*size,size,tag.Trim()))items.Add(new JsonObject{["id"]=u.Id.ToString(),["name"]=u.Name,["phone"]=u.Phone,["email"]=u.Email,["is_admin"]=u.IsAdmin,["is_active"]=u.IsActive,["staff_tags"]=System.Text.Json.Nodes.JsonNode.Parse(string.IsNullOrEmpty(u.StaffTags)?"[]":u.StaffTags),["orders"]=u.Orders,["seller"]=u.SellerId is {} sid?new JsonObject{["id"]=sid.ToString(),["status"]=u.SellerStatus}:null,["last_login_at"]=u.LastLoginAt?.ToString("o"),["created_at"]=u.CreatedAt.ToString("o")});return new(){["items"]=items,["total"]=total,["page"]=page,["page_size"]=size};}
    public async Task<JsonObject> AuditAsync(UserModel user,string? entity,int page)
    {await access.RequireAsync(user,"audit");return new(){["items"]=new JsonArray((await data.AuditAsync(entity,(page-1)*50)).Select(a=>(JsonNode)new JsonObject{["action"]=a.Action,["entity_type"]=a.EntityType,["entity_id"]=a.EntityId,["detail"]=a.Detail,["actor"]=a.Actor,["at"]=a.CreatedAt.ToString("o")}).ToArray())};}
    public async Task<JsonObject> TicketsAsync(UserModel user,string? status,bool overdue,bool grievance,int page,string q)
    {await access.RequireAsync(user,"support");q=q.Trim();var total=await data.TicketCountAsync(status,overdue,grievance,q);var items=new JsonArray();foreach(var t in await data.TicketsAsync(status,overdue,grievance,q,(page-1)*30)){var item=SupportDeskBAL.TicketOut(t,null);item["customer"]=t.Customer;items.Add(item);}return new(){["items"]=items,["total"]=total,["status_counts"]=new JsonObject((await data.CountsAsync()).Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Status,JsonValue.Create(x.N)))),["page"]=page,["page_size"]=30};}
}
