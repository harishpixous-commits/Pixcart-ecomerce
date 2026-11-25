using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class AdminProductMediaBAL(AdminProductMediaDAL data,ProductModerationDAL products,IAccessBAL access,IPlatformSettingsBAL settings,IAuditBAL audit,IMySqlDapperHelper db,IAdminProductReadBAL read,AppSettings app):IAdminProductMediaBAL
{
    private void Check(string url,string folder){if(!url.StartsWith(app.MediaBaseUrl.TrimEnd('/')+"/"+folder+"/",StringComparison.Ordinal)||url.Contains("..")||url.Length>400)throw new AppException("Upload "+(folder=="products"?"images":"videos")+" here; external "+(folder=="products"?"image":"video")+" links are not allowed","validation",422);}
    public async Task<JsonObject> SaveAsync(UserModel user,Guid id,string[]? images,ProductVideoModel[]? videos)
    {
        await access.RequireAsync(user,"catalog");if(images is not null){if(images.Length is <1 or >8||images.Distinct().Count()!=images.Length)throw new AppException("Include 1 to 8 distinct images","validation",422);foreach(var url in images)Check(url,"products");}
        if(videos is not null)foreach(var v in videos){Check(v.Url,"videos");if(v.PosterUrl.Length>0)Check(v.PosterUrl,"products");}
        await using var tx=await db.BeginAsync();_ = await products.ProductForUpdateAsync(id,tx)??throw new NotFoundException("Product");
        if(videos is {Length:>0}){var cfg=await settings.GetAsync();if(!cfg.Bool("feature_product_videos"))throw new AppException("Product videos are switched off on this marketplace","videos_off");if(videos.Length>cfg.Int("max_videos_per_listing"))throw new AppException($"At most {cfg.Int("max_videos_per_listing")} videos per listing","too_many_videos");}
        if(images is not null){await data.DeleteImagesAsync(id,tx);for(var i=0;i<images.Length;i++)await data.ImageAsync(id,images[i],i,tx);await audit.AuditAsync(user,"product.images","product",id,$"{images.Length} photos",tx);}else{await data.DeleteVideosAsync(id,tx);for(var i=0;i<videos!.Length;i++)await data.VideoAsync(id,videos[i],i,tx);await audit.AuditAsync(user,"product.videos","product",id,$"{videos.Length} videos",tx);}await tx.CommitAsync();return await read.DetailAsync(user,id);
    }
}
