using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminProductMediaDAL
{
    public Task DeleteImagesAsync(Guid id,IUnitOfWork tx)=>tx.ExecuteAsync("DELETE FROM product_images WHERE product_id=@id",new{id});
    public Task DeleteVideosAsync(Guid id,IUnitOfWork tx)=>tx.ExecuteAsync("DELETE FROM product_videos WHERE product_id=@id",new{id});
    public Task ImageAsync(Guid id,string url,int position,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO product_images(id,product_id,url,position)VALUES(@iid,@id,@url,@position)",new{iid=Guid.NewGuid(),id,url,position});
    public Task VideoAsync(Guid id,ProductVideoModel v,int position,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO product_videos(id,product_id,url,poster_url,title,duration_s,position)VALUES(@vid,@id,@Url,@PosterUrl,@Title,@DurationS,@position)",new{vid=Guid.NewGuid(),id,v.Url,v.PosterUrl,v.Title,v.DurationS,position});
}
