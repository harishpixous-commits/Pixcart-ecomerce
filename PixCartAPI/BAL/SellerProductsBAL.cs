using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
/// <summary>Seller catalogue read, lifecycle and variant price/stock paths from seller_products.py.</summary>
public class SellerProductsBAL(SellerProductsDAL dal,ProductModerationBAL detail,CatalogDAL catalog,DealsDAL deals,
    IPlatformSettingsBAL platform,IInventoryBAL inventory,IAuditBAL audit,IMySqlDapperHelper db) : ISellerProductsBAL
{
    public async Task<JsonObject> DetailAsync(SellerModel s,Guid id) => await detail.DetailAsync(await dal.OwnedAsync(s.Id,id) ?? throw new NotFoundException("Product"));
    public async Task<JsonObject> RequirementsAsync(SellerModel s,Guid categoryId)
    {
        var chain=await catalog.CategoryChainAsync(categoryId);
        var required=ProductInfo.EffectiveRequired(chain.Select(c=>(JsonHelper.Node(c.RequiredDetails) as JsonArray ?? []).Select(CatalogText.Str)));
        return new JsonObject { ["required"]=new JsonArray(required.Select(x=>(JsonNode)JsonValue.Create(x)).ToArray()),
            ["labels"]=new JsonObject(ProductInfo.Requirable.Select(kv=>new KeyValuePair<string,JsonNode?>(kv.Key,JsonValue.Create(kv.Value)))) };
    }
    public async Task<object> CategoriesAsync(SellerModel s)
    {
        var cats=(await catalog.ActiveCategoriesAsync()).ToList(); var parents=cats.Where(c=>c.ParentId!=null).Select(c=>c.ParentId!.Value).ToHashSet(); var byId=cats.ToDictionary(c=>c.Id);
        return cats.Where(c=>!parents.Contains(c.Id)).Select(c=>
        {
            var path=new List<string> { c.Name }; var cur=c; var seen=new HashSet<Guid> { c.Id };
            while(cur.ParentId is {} parent && byId.TryGetValue(parent,out var next) && seen.Add(parent)) { path.Insert(0,next.Name); cur=next; }
            return new { id=c.Id.ToString(),name=c.Name,path=string.Join(" › ",path),commission_bps=s.CommissionBpsOverride??c.CommissionBps,
                default_gst_bps=c.DefaultGstBps,return_window_days=c.ReturnWindowDays,min_return_window_days=c.MinReturnWindowDays };
        }).OrderBy(c=>c.path,StringComparer.Ordinal).ToList();
    }
    public async Task<JsonObject> FeesAsync()
    { var cfg=await platform.GetAsync(); return new JsonObject { ["commission_gst_bps"]=cfg["commission_gst_bps"]!.DeepClone(),["tcs_bps"]=cfg["tcs_bps"]!.DeepClone(),["tds_bps"]=cfg["tds_bps"]!.DeepClone() }; }
    public async Task<JsonObject> ListAsync(SellerModel s,string? status,string q,bool lowStock,int page,int pageSize)
    {
        var threshold=(await platform.GetAsync()).Int("low_stock_threshold");
        var (selected,total,counts)=await dal.PageAsync(s.Id,status,q,lowStock,threshold,page,pageSize);
        var ids=selected.Select(p=>p.Id).ToList(); var variants=(await dal.VariantsForProductsAsync(ids)).ToList();
        var imgs=await catalog.ImagesForAsync(ids);
        var items=new JsonArray();
        foreach(var p in selected) items.Add(new JsonObject { ["id"]=p.Id.ToString(),["title"]=p.Title,["slug"]=p.Slug,["status"]=p.Status,["rejection_reason"]=p.RejectionReason,
            ["image"]=imgs.GetValueOrDefault(p.Id)?.FirstOrDefault()??"",["price_from"]=p.PriceFrom,["mrp_from"]=p.MrpFrom,
            ["total_stock"]=variants.Where(v=>v.ProductId==p.Id&&v.IsActive).Sum(v=>v.Stock),["updated_at"]=DateTimeFunctions.Iso(p.UpdatedAt) });
        return new JsonObject { ["items"]=items,["total"]=total,["page"]=page,["page_size"]=pageSize,
            ["status_counts"]=new JsonObject(counts.Select(g=>new KeyValuePair<string,JsonNode?>(g.Status,JsonValue.Create(g.Count)))),["low_stock_threshold"]=threshold };
    }
    public async Task<JsonObject> LifecycleAsync(UserModel user,SellerModel s,Guid id,string action)
    {
        await using(var tx=await db.BeginAsync())
        {
            var p=await dal.OwnedAsync(s.Id,id,tx)??throw new NotFoundException("Product");
            if(action=="submit")
            {
                if(p.Status is not ("draft" or "rejected")) throw new ConflictException($"A {p.Status} product cannot be submitted","invalid_status");
                var d=await detail.DetailAsync(p); var problems=new List<string>();
                if(d["images"]!.AsArray().Count==0) problems.Add("add at least one image");
                if(!d["variants"]!.AsArray().OfType<JsonObject>().Any(v=>v["is_active"]!.GetValue<bool>())) problems.Add("add at least one active variant");
                if(p.Description.Trim().Length<30) problems.Add("write a description of at least 30 characters");
                var missing=d["missing_details"]!.AsArray().Select(x=>x!.GetValue<string>().ToLowerInvariant()).ToList();
                if(missing.Count>0) problems.Add("fill in "+string.Join(", ",missing));
                if(problems.Count>0) throw new AppException("Before submitting, "+string.Join(", ",problems),"listing_incomplete");
                p.Status="pending"; p.SubmittedAt=DateTimeFunctions.UtcNow(); p.RejectionReason="";
            }
            else if(action=="archive") p.Status="archived";
            else { if(p.Status!="archived") throw new ConflictException("Only archived products can be restored","invalid_status"); p.Status="draft"; }
            await dal.SetStatusAsync(p,tx); await audit.AuditAsync(user,"product."+action,"product",p.Id,uow:tx); await tx.CommitAsync();
        }
        return await DetailAsync(s,id);
    }
    public async Task<JsonObject> PatchAsync(SellerModel s,Guid id,long? price,long? mrp,int? stock,bool? active)
    {
        VariantModel v;
        await using(var tx=await db.BeginAsync())
        {
            v=await dal.VariantAsync(s.Id,id,tx)??throw new NotFoundException("Variant"); var nextPrice=price??v.PricePaise; var nextMrp=mrp??v.MrpPaise;
            if(nextPrice!=v.PricePaise&&(await deals.ActiveVariantIdsAsync([v.Id])).Contains(v.Id)) throw new ConflictException("This version is in a running deal; change its price after the deal ends (or cancel the deal)","deal_running");
            if(nextPrice>nextMrp) throw new AppException("Selling price cannot be more than MRP","price_above_mrp");
            v.PricePaise=nextPrice; v.MrpPaise=nextMrp;
            if(stock is {} total && total!=v.Stock)
            {
                var wh=await inventory.DefaultWarehouseAsync(s,uow:tx);
                if(wh is null) { await inventory.SetVariantStockAsync(v.Id,total,tx); v.Stock=total; }
                else await inventory.SetQuantityAsync(v,wh.Id,Math.Max(0,total-await dal.OtherStockAsync(v.Id,wh.Id,tx)),null,"Edited in product form",tx);
            }
            if(active is {} a) v.IsActive=a;
            await dal.SaveVariantAsync(v,tx); await catalog.RefreshAggregatesAsync(v.ProductId,tx); await tx.CommitAsync();
        }
        return ProductModerationBAL.VariantOut(v);
    }
}
