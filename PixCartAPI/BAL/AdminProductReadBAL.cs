using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;
public class AdminProductReadBAL(AdminProductReadDAL data,CatalogDAL catalog,IAccessBAL access,IProductModerationBAL products,IAiBAL ai):IAdminProductReadBAL
{
    public async Task<JsonObject> ListAsync(UserModel user,string? status,string q,Guid? seller,int page,int size)
    {await access.RequireAsync(user,"catalog");q=q.Trim();var total=await data.CountAsync(status,q,seller);var rows=(await data.ListAsync(status,q,seller,(page-1)*size,size)).ToList();var images=await catalog.ImagesForAsync(rows.Select(x=>x.Id).ToList());return new(){["items"]=new JsonArray(rows.Select(p=>(JsonNode)new JsonObject{["id"]=p.Id.ToString(),["title"]=p.Title,["slug"]=p.Slug,["status"]=p.Status,["seller_name"]=p.SellerName,["image"]=(images.GetValueOrDefault(p.Id)??[]).FirstOrDefault()??"",["price_from"]=p.PriceFrom,["mrp_from"]=p.MrpFrom,["submitted_at"]=p.SubmittedAt?.ToString("o")}).ToArray()),["total"]=total,["page"]=page,["page_size"]=size,["status_counts"]=new JsonObject((await data.CountsAsync()).Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Status,JsonValue.Create(x.N))))};}
    public async Task<JsonObject> DetailAsync(UserModel user,Guid id){await access.RequireAsync(user,"catalog");var p=await data.ProductAsync(id)??throw new NotFoundException("Product");var output=await products.DetailAsync(p);var seller=await data.SellerAsync(p.SellerId)??throw new NotFoundException("Seller");output["seller"]=new JsonObject{["id"]=seller.Id.ToString(),["name"]=seller.DisplayName,["status"]=seller.Status};return output;}
    public async Task<JsonObject> AiCheckAsync(UserModel user,Guid id){await access.RequireAsync(user,"catalog");var(run,output)=await ai.RunAsync("listing_check",user,new JsonObject(),id.ToString());output["run_id"]=run.Id.ToString();output["mode"]=run.Mode;return output;}
}
