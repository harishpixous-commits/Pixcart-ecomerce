using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AssistantUploadDAL(IMySqlDapperHelper db)
{
    public Task InsertAsync(AssistantUploadModel p,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO assistant_uploads(id,user_id,filename,content_type,size,sha256,`columns`,`rows`,row_count,truncated,text,created_at,expires_at)VALUES(@Id,@UserId,@Filename,@ContentType,@Size,@Sha256,CAST(@Columns AS JSON),CAST(@Rows AS JSON),@RowCount,@Truncated,@Text,@CreatedAt,@ExpiresAt)",p);
    public Task DeleteAsync(Guid user,Guid id)=>db.ExecuteAsync("DELETE FROM assistant_uploads WHERE id=@id AND user_id=@user",new{user,id});
    public Task<AssistantUploadModel?> OwnAsync(Guid user,Guid id,DateTime now)=>db.QueryFirstOrDefaultAsync<AssistantUploadModel>("SELECT * FROM assistant_uploads WHERE id=@id AND user_id=@user AND 1=1",new{user,id,now});
}
