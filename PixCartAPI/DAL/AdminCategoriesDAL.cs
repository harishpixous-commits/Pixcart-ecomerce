using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminCategoriesDAL(IMySqlDapperHelper db)
{
    public Task<IEnumerable<CategoryModel>> AllAsync()=>db.QueryAsync<CategoryModel>("SELECT * FROM categories ORDER BY position,name");
    public Task<IEnumerable<CategoryModel>> AllAsync(IUnitOfWork tx)=>tx.QueryAsync<CategoryModel>("SELECT * FROM categories ORDER BY position,name");
    public Task<bool> HasProductsAsync(Guid id,IUnitOfWork tx)=>tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM products WHERE category_id=@id)",new{id});
    public Task SaveAsync(CategoryModel c,bool exists,IUnitOfWork tx)=>exists?tx.ExecuteAsync("UPDATE categories SET name=@Name,parent_id=@ParentId,image_url=@ImageUrl,commission_bps=@CommissionBps,default_gst_bps=@DefaultGstBps,position=@Position,is_active=@IsActive,required_details=CAST(@RequiredDetails AS JSON),return_window_days=@ReturnWindowDays,min_return_window_days=@MinReturnWindowDays,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",c):tx.ExecuteAsync("INSERT INTO categories(id,name,slug,parent_id,image_url,commission_bps,default_gst_bps,position,is_active,required_details,return_window_days,min_return_window_days,created_at,updated_at)VALUES(@Id,@Name,@Slug,@ParentId,@ImageUrl,@CommissionBps,@DefaultGstBps,@Position,@IsActive,CAST(@RequiredDetails AS JSON),@ReturnWindowDays,@MinReturnWindowDays,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",c);
    public Task<int> RaiseMinimumAsync(Guid id,int min,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE products SET return_window_days=@min WHERE category_id=@id AND return_window_days<@min",new{id,min});
}
