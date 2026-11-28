using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
namespace BAL;

public partial class SellerProductsBAL
{
    /// <summary>A new draft copy of one of the seller's listings ("Copy of ..."): same content, images and videos; every version gets a fresh SKU and starts with no stock.</summary>
    public async Task<JsonObject> DuplicateAsync(UserModel user,SellerModel seller,Guid id)
    {
        var src=await DetailAsync(seller,id);
        var body=new JsonObject();
        foreach(var k in new[]{"category_id","title","brand","description","highlights","specs","hsn_code","gst_bps","country_of_origin","return_window_days","size_guide","images","videos","details"})
            if(src[k] is {} v) body[k]=v.DeepClone();
        var title="Copy of "+(src["title"]?.GetValue<string>()??"");
        body["title"]=title.Length>200?title[..200]:title;
        var used=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var variants=new JsonArray();
        foreach(var v in src["variants"]!.AsArray())
        {
            var baseSku=v!["sku"]!.GetValue<string>();string sku;var n=0;
            while(true)
            {
                var suffix="-COPY"+(n>0?(n+1).ToString():"");
                sku=(baseSku.Length>60-suffix.Length?baseSku[..(60-suffix.Length)]:baseSku)+suffix;
                if(!used.Contains(sku)&&!await db.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM variants WHERE seller_id=@sid AND LOWER(sku)=LOWER(@sku))",new{sid=seller.Id,sku}))break;
                n++;
            }
            used.Add(sku);
            var o=new JsonObject{["sku"]=sku,["options"]=v["options"]?.DeepClone()??new JsonObject(),["mrp_paise"]=v["mrp_paise"]!.DeepClone(),["price_paise"]=v["price_paise"]!.DeepClone(),["stock"]=0};
            foreach(var k in new[]{"weight_grams","net_qty","is_active"}) if(v[k] is {} x) o[k]=x.DeepClone();
            variants.Add(o);
        }
        body["variants"]=variants;
        return await SaveAsync(user,seller,null,body);
    }
}
