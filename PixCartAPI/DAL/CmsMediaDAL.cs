using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class CmsMediaDAL(IMySqlDapperHelper db)
{
    public Task<IEnumerable<MediaAssetModel>> ListAsync(string? kind)=>db.QueryAsync<MediaAssetModel>("SELECT * FROM media_assets WHERE @kind IS NULL OR (@kind='video' AND REGEXP_LIKE(url,'[.](mp4|webm)([?#].*)?$','i')) OR (@kind='image' AND NOT REGEXP_LIKE(url,'[.](mp4|webm)([?#].*)?$','i')) ORDER BY created_at DESC LIMIT 200",new{kind});
    public Task InsertAsync(MediaAssetModel m,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO media_assets(id,url,label,created_at)VALUES(@Id,@Url,@Label,@CreatedAt)",m);
}
