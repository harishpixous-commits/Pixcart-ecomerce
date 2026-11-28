using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Model.CustomeAttributes;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public partial class SellerProductsBAL
{
    private sealed record VariantInput(Guid? Id,string Sku,JsonObject Options,long Mrp,long Price,int Stock,int Weight,decimal? Net,bool Active);
    private static AppException Invalid(string text)=>new(text,"validation",422);
    private static string Text(JsonObject o,string key,int min,int max,string? fallback=null)
    {
        var n=o[key]; if(n is null) {if(fallback is not null)return fallback;throw Invalid(key+" is required");}
        if(n is not JsonValue j||!j.TryGetValue<string>(out var value)||value.Length<min||value.Length>max) throw Invalid($"Invalid {key}");return value;
    }
    private static long Number(JsonObject o,string key,long min,long max,long? fallback=null)
    {
        if(o[key] is null) return fallback??throw Invalid(key+" is required");
        if(o[key] is not JsonValue j)throw Invalid($"Invalid {key}");
        long v;if(j.TryGetValue<long>(out var value))v=value;else if(j.TryGetValue<int>(out var integer))v=integer;else throw Invalid($"Invalid {key}");
        if(v<min||v>max)throw Invalid($"Invalid {key}");return v;
    }
    private string Media(string value,string folder)
    {
        if(!value.StartsWith(env.MediaBaseUrl.TrimEnd('/')+"/"+folder+"/",StringComparison.Ordinal)||value.Contains("..")||value.Length>400) throw Invalid("Upload "+folder+" here; external links are not allowed");return value;
    }
    private static List<VariantInput> ReadVariants(JsonObject b)
    {
        if(b["variants"] is not JsonArray arr||arr.Count<1||arr.Count>50) throw Invalid("Include 1 to 50 variants");
        var result=new List<VariantInput>();
        foreach(var item in arr)
        {
            var o=item as JsonObject??throw Invalid("Invalid variant");var sku=Text(o,"sku",1,60);
            if(!Regex.IsMatch(sku,@"^[A-Za-z0-9._\-/]+$"))throw Invalid("Invalid SKU");
            var opts=o["options"] is null?new JsonObject():o["options"] as JsonObject??throw Invalid("Invalid options");
            if(opts.Count>3)throw Invalid("At most 3 option types (e.g. Size, Colour)");var clean=new JsonObject();
            foreach(var kv in opts) {var k=kv.Key.Trim();k=k[..Math.Min(30,k.Length)];var value=kv.Value?.GetValue<string>()?.Trim()??"";value=value[..Math.Min(40,value.Length)];if(k.Length==0||value.Length==0)throw Invalid("Option names and values cannot be empty");clean[k]=value;}
            var mrp=Number(o,"mrp_paise",1,100000000);var price=Number(o,"price_paise",1,100000000);if(price>mrp)throw Invalid("Selling price cannot be more than MRP");
            Guid? id=null;if(o["id"] is not null) {if(!Guid.TryParse(o["id"]!.GetValue<string>(),out var x))throw Invalid("Invalid variant id");id=x;}
            decimal? net=null;if(o["net_qty"] is not null) {if(o["net_qty"] is not JsonValue j||!j.TryGetValue<decimal>(out var d)||d<=0||d>1000000)throw Invalid("Invalid net_qty");net=d;}
            var active=o["is_active"] is null||o["is_active"]!.GetValue<bool>();
            result.Add(new(id,sku,clean,mrp,price,(int)Number(o,"stock",0,1000000),(int)Number(o,"weight_grams",1,100000,500),net,active));
        }
        if(result.Select(v=>v.Sku.ToLowerInvariant()).Distinct().Count()!=result.Count)throw Invalid("Each variant needs a different SKU");
        if(result.Count>1)
        {
            var keys=result.Select(v=>string.Join("|",v.Options.Select(kv=>kv.Key).Order())).Distinct().ToList();
            if(keys.Count!=1||keys[0].Length==0)throw Invalid("All variants must use the same option types (e.g. Size and Colour)");
            if(result.Select(v=>new JsonObject(v.Options.OrderBy(kv=>kv.Key).Select(kv=>new KeyValuePair<string,JsonNode?>(kv.Key,kv.Value?.DeepClone()))).ToJsonString()).Distinct().Count()!=result.Count)throw Invalid("Two variants have the same options");
        }
        return result;
    }
    public async Task<JsonObject> SaveAsync(UserModel user,SellerModel seller,Guid? id,JsonObject b)
    {
        try
        {
            Guid saved;
            await using(var tx=await db.BeginAsync()) { saved=await SaveCoreAsync(user,seller,id,b,tx);await tx.CommitAsync(); }
            return await DetailAsync(seller,saved);
        }
        catch(Exception e) when(e is InvalidOperationException or FormatException or System.Text.Json.JsonException)
        { throw Invalid("Invalid listing field type"); }
    }
    private async Task<Guid> SaveCoreAsync(UserModel user,SellerModel seller,Guid? id,JsonObject b,IUnitOfWork tx,bool validateOnly=false,bool writeAudit=true)
    {
        if(id is null&&seller.Status=="suspended")throw new ConflictException("Your seller account is suspended","seller_suspended");
        if(!Guid.TryParse(Text(b,"category_id",1,40),out var categoryId))throw Invalid("Invalid category_id");
        var title=Text(b,"title",10,200);var brand=Text(b,"brand",0,80,"");var description=Text(b,"description",0,10000,"");
        var hsn=Text(b,"hsn_code",4,8);if(!Regex.IsMatch(hsn,@"^\d{4}(\d{2}){0,2}$"))throw Invalid("Invalid HSN code");
        var gst=(int)Number(b,"gst_bps",0,4000);if(!new[]{0,25,300,500,1200,1800,2800,4000}.Contains(gst))throw Invalid("Choose a valid GST rate");
        var country=Text(b,"country_of_origin",2,60,"India");int? days=b["return_window_days"] is null?null:(int)Number(b,"return_window_days",0,30);
        var highlights=b["highlights"] is null?new JsonArray():b["highlights"] as JsonArray??throw Invalid("Invalid highlights");if(highlights.Count>10)throw Invalid("At most 10 highlights");
        var cleanHighlights=new JsonArray(highlights.Select(x=>x!.GetValue<string>().Trim()).Where(x=>x.Length>0).Select(x=>(JsonNode)JsonValue.Create(x[..Math.Min(200,x.Length)])).ToArray());
        var specs=b["specs"] is null?new JsonObject():b["specs"] as JsonObject??throw Invalid("Invalid specs");if(specs.Count>40)throw Invalid("At most 40 specifications");var cleanSpecs=new JsonObject();
        foreach(var kv in specs){var k=kv.Key.Trim();var value=kv.Value!.GetValue<string>().Trim();if(k.Length>0&&value.Length>0)cleanSpecs[k[..Math.Min(60,k.Length)]]=value[..Math.Min(300,value.Length)];}
        var images=b["images"] is null?new JsonArray():b["images"] as JsonArray??throw Invalid("Invalid images");if(images.Count>8)throw Invalid("At most 8 images");var urls=images.Select(x=>Media(x!.GetValue<string>(),"products")).ToList();
        var videos=b["videos"] is null?new JsonArray():b["videos"] as JsonArray??throw Invalid("Invalid videos");if(videos.Count>10)throw Invalid("At most 10 videos");var vids=new List<ProductVideoModel>();
        foreach(var x in videos){var v=x as JsonObject??throw Invalid("Invalid video");var poster=Text(v,"poster_url",0,400,"");vids.Add(new(){Url=Media(Text(v,"url",1,400),"videos"),PosterUrl=poster.Length>0?Media(poster,"products"):"",Title=Text(v,"title",0,120,""),DurationS=(int)Number(v,"duration_s",0,3600,0)});}
        var sizeGuide=Utils.SizeGuide.Clean(Text(b,"size_guide",0,2000,""));
        var details=ProductModerationBAL.DetailsDump(ProductInfo.DetailsOf((b["details"]??new JsonObject()).ToJsonString(),strict:true));
        var inputs=ReadVariants(b);
        {
            var p=id is {} pid?await dal.OwnedAsync(seller.Id,pid,tx)??throw new NotFoundException("Product"):new ProductModel {Id=Guid.NewGuid(),SellerId=seller.Id,Status="draft",CreatedAt=DateTimeFunctions.UtcNow()};
            if(p.Status=="archived")throw new ConflictException("Restore this product before editing it","archived");
            var cat=await catalog.GetCategoryAsync(categoryId);if(cat is null||!cat.IsActive)throw new AppException("Choose a valid category","invalid_category",fields:new Dictionary<string,string>{{"category_id","Invalid"}});
            if(await dal.HasChildrenAsync(categoryId,tx))throw new AppException("Choose the most specific sub-category","category_not_leaf",fields:new Dictionary<string,string>{{"category_id","Pick a sub-category"}});
            days??=id is null?cat.ReturnWindowDays:p.ReturnWindowDays;if(days<cat.MinReturnWindowDays)throw new AppException($"Listings in {cat.Name} need a return window of at least {cat.MinReturnWindowDays} days","return_window_too_short");
            if(validateOnly)return Guid.Empty;
            var before=id is null?null:await detail.DetailAsync(p);var oldVideos=before?["videos"]?.AsArray().Select(v=>v!["url"]!.GetValue<string>()).ToList()??[];
            if(vids.Count>0&&!oldVideos.SequenceEqual(vids.Select(v=>v.Url))) {var cfg=await platform.GetAsync();if(!cfg.Bool("feature_product_videos"))throw new AppException("Product videos are switched off on this marketplace","videos_off");if(vids.Count>cfg.Int("max_videos_per_listing"))throw new AppException($"At most {cfg.Int("max_videos_per_listing")} videos per listing","too_many_videos");}
            p.CategoryId=categoryId;p.Title=title.Trim();p.Brand=brand.Trim();p.Description=description;p.Highlights=cleanHighlights.ToJsonString();p.Specs=cleanSpecs.ToJsonString();p.HsnCode=hsn;p.GstBps=gst;p.CountryOfOrigin=country;p.SizeGuide=sizeGuide;p.ReturnWindowDays=days.Value;p.Details=details.ToJsonString();p.UpdatedAt=DateTimeFunctions.UtcNow();
            if(id is null){var root=IndianFormats.Slugify(title,200);p.Slug=root;while(await dal.SlugTakenAsync(p.Slug,tx))p.Slug=root+"-"+Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(3));await dal.InsertProductAsync(p,tx);}
            var existing=(await dal.ProductVariantsAsync(p.Id,tx)).ToDictionary(v=>v.Id);var busy=await deals.ActiveVariantIdsAsync(existing.Keys.ToList());var seen=new HashSet<Guid>();
            foreach(var item in inputs)
            {
                if(await dal.SkuTakenAsync(seller.Id,item.Sku,item.Id,tx))throw new ConflictException($"SKU '{item.Sku}' is already used in another of your listings","sku_taken");
                VariantModel v;
                if(item.Id is {} vid){if(!existing.TryGetValue(vid,out v!))throw new AppException("A variant in this request does not belong to this product","variant_mismatch");seen.Add(vid);if(busy.Contains(vid)&&item.Price!=v.PricePaise)throw new ConflictException($"'{item.Sku}' is in a running deal; change its price after the deal ends (or cancel the deal)","deal_running");}
                else v=new VariantModel {Id=Guid.NewGuid(),ProductId=p.Id,SellerId=seller.Id,CreatedAt=DateTimeFunctions.UtcNow()};
                v.Sku=item.Sku;v.Options=item.Options.ToJsonString();v.MrpPaise=item.Mrp;v.PricePaise=item.Price;v.WeightGrams=item.Weight;v.NetQty=item.Net;v.IsActive=item.Active;v.UpdatedAt=DateTimeFunctions.UtcNow();
                if(item.Id is null)await dal.InsertVariantAsync(v,tx);else await dal.UpdateVariantAsync(v,tx);
                if(item.Stock!=v.Stock){var wh=await inventory.DefaultWarehouseAsync(seller,uow:tx);if(wh is null){await inventory.SetVariantStockAsync(v.Id,item.Stock,tx);v.Stock=item.Stock;}else await inventory.SetQuantityAsync(v,wh.Id,Math.Max(0,item.Stock-await dal.OtherStockAsync(v.Id,wh.Id,tx)),user.Id,"Edited in product form",tx);}
            }
            foreach(var vid in existing.Keys.Where(k=>!seen.Contains(k)))await dal.RemoveUnusedVariantAsync(vid,tx);
            await dal.ReplaceMediaAsync(p.Id,urls,vids,tx);
            var contentChanged=false;
            if(before is not null)
            {
                var after=new JsonObject { ["category_id"]=p.CategoryId.ToString(),["title"]=p.Title,["brand"]=p.Brand,["description"]=p.Description,["highlights"]=cleanHighlights.DeepClone(),["specs"]=cleanSpecs.DeepClone(),["hsn_code"]=p.HsnCode,["gst_bps"]=p.GstBps,["country_of_origin"]=p.CountryOfOrigin,["return_window_days"]=p.ReturnWindowDays,["size_guide"]=p.SizeGuide,["details"]=details.DeepClone() };
                contentChanged=after.Any(kv=>!JsonNode.DeepEquals(kv.Value,before[kv.Key]))||!before["images"]!.AsArray().Select(x=>x!.GetValue<string>()).SequenceEqual(urls)||!oldVideos.SequenceEqual(vids.Select(v=>v.Url));
                if(contentChanged&&p.Status=="approved"){p.Status="pending";p.SubmittedAt=DateTimeFunctions.UtcNow();}
            }
            await dal.UpdateProductAsync(p,tx);await catalog.RefreshAggregatesAsync(p.Id,tx);if(writeAudit)await audit.AuditAsync(user,id is null?"product.create":"product.update","product",p.Id,id is null?"":contentChanged?"content changed":"price/stock",tx);id=p.Id;
        }
        return id!.Value;
    }
}
