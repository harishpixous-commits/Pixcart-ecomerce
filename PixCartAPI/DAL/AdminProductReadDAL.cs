using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminProductReadDAL(IMySqlDapperHelper db)
{
    private const string Filter="(@status IS NULL OR p.status=@status) AND (@seller IS NULL OR p.seller_id=@seller) AND (@q='' OR p.title LIKE @like)";
    public class Row:ProductModel{public string SellerName{get;set;}="";}
    public Task<long> CountAsync(string? status,string q,Guid? seller)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM products p JOIN sellers s ON s.id=p.seller_id WHERE "+Filter,new{status,q,like="%"+q+"%",seller});
    public Task<IEnumerable<Row>> ListAsync(string? status,string q,Guid? seller,int offset,int size)=>db.QueryAsync<Row>("SELECT p.*,s.display_name seller_name FROM products p JOIN sellers s ON s.id=p.seller_id WHERE "+Filter+" ORDER BY CASE WHEN @status='pending' THEN p.submitted_at IS NULL END,CASE WHEN @status='pending' THEN p.submitted_at END ASC,CASE WHEN @status IS NULL OR @status<>'pending' THEN p.updated_at END DESC LIMIT @size OFFSET @offset",new{status,q,like="%"+q+"%",seller,offset,size});
    public class CountRow{public string Status{get;set;}="";public int N{get;set;}}
    public Task<IEnumerable<CountRow>> CountsAsync()=>db.QueryAsync<CountRow>("SELECT status,COUNT(*) n FROM products GROUP BY status");
    public Task<ProductModel?> ProductAsync(Guid id)=>db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id=@id",new{id});
    public Task<SellerModel?> SellerAsync(Guid id)=>db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id=@id",new{id});
}
