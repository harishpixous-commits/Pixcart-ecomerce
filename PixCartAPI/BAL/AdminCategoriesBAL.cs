using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class AdminCategoriesBAL(AdminCategoriesDAL data,IAccessBAL access,IAuditBAL audit,IMySqlDapperHelper db):IAdminCategoriesBAL
{
    private static JsonObject Out(CategoryModel c)=>new(){["id"]=c.Id.ToString(),["name"]=c.Name,["slug"]=c.Slug,["parent_id"]=c.ParentId?.ToString(),["image_url"]=c.ImageUrl,["commission_bps"]=c.CommissionBps,["default_gst_bps"]=c.DefaultGstBps,["position"]=c.Position,["is_active"]=c.IsActive,["required_details"]=JsonNode.Parse(c.RequiredDetails),["return_window_days"]=c.ReturnWindowDays,["min_return_window_days"]=c.MinReturnWindowDays,["size_guide"]=c.SizeGuide??""};
    public async Task<JsonObject> RequirementsAsync(UserModel user){await access.RequireAsync(user,"catalog");return new(){["options"]=new JsonObject(ProductInfo.Requirable.Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Key,JsonValue.Create(x.Value))))};}
    public async Task<JsonArray> ListAsync(UserModel user){await access.RequireAsync(user,"catalog");return new((await data.AllAsync()).Select(x=>(JsonNode)Out(x)).ToArray());}
    public async Task<JsonObject> SaveAsync(UserModel user,Guid? id,CategoryModel body)
    {
        await access.RequireAsync(user,"catalog");await using var tx=await db.BeginAsync();var rows=(await data.AllAsync(tx)).ToDictionary(c=>c.Id);var old=id is null?null:rows.GetValueOrDefault(id.Value)??throw new NotFoundException("Category");
        if(!new[]{0,25,300,500,1200,1800,2800,4000}.Contains(body.DefaultGstBps))throw new AppException("Choose a valid GST rate","invalid_gst",fields:new Dictionary<string,string>{{"default_gst_bps","Invalid"}});
        if(body.MinReturnWindowDays>body.ReturnWindowDays)throw new AppException("Make the default return window at least as long as the shortest window sellers may set","invalid_return_window",fields:new Dictionary<string,string>{{"return_window_days",$"At least {body.MinReturnWindowDays} days"}});
        var required=JsonNode.Parse(body.RequiredDetails)!.AsArray().Select(x=>x!.GetValue<string>()).ToList();if(required.Any(x=>!ProductInfo.Requirable.Any(k=>k.Key==x)))throw new AppException("Unknown product information: "+required.First(x=>!ProductInfo.Requirable.Any(k=>k.Key==x)),"validation",422);body.RequiredDetails=new JsonArray(ProductInfo.Requirable.Where(x=>required.Contains(x.Key)).Select(x=>(JsonNode)JsonValue.Create(x.Key)).ToArray()).ToJsonString();
        if(body.ParentId is {} parent){if(!rows.TryGetValue(parent,out var cur))throw new AppException("Parent category not found","invalid_parent");while(cur is not null){if(old is not null&&cur.Id==old.Id)throw new AppException("A category cannot be placed inside itself","category_cycle");cur=cur.ParentId is {} p?rows.GetValueOrDefault(p):null;}if(await data.HasProductsAsync(parent,tx))throw new AppException("The parent category already has products; choose a category without products","parent_has_products");}
        body.SizeGuide=Utils.SizeGuide.Clean(body.SizeGuide);
        body.Id=id??Guid.NewGuid();body.Slug=old?.Slug??Model.CustomeAttributes.IndianFormats.Slugify(body.Name,80);if(old is null){body.Slug=body.Slug[..Math.Min(body.Slug.Length,80)];if(rows.Values.Any(x=>x.Slug==body.Slug))body.Slug+="-"+Guid.NewGuid().ToString("N")[..4];}
        await data.SaveAsync(body,old is not null,tx);var raised=old is null?0:await data.RaiseMinimumAsync(body.Id,body.MinReturnWindowDays,tx);await audit.AuditAsync(user,old is null?"category.create":"category.update","category",body.Id,old is null?body.Name:raised>0?$"Listings raised to the {body.MinReturnWindowDays}-day minimum return window: {raised}":"",tx);await tx.CommitAsync();return Out(body);
    }
}
