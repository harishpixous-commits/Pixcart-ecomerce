using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminSellerListDAL(IMySqlDapperHelper db)
{
    private const string Filter="(@status IS NULL OR status=@status) AND (@q='' OR display_name LIKE @like OR legal_name LIKE @like OR gstin LIKE @like OR contact_phone LIKE @like)";
    public Task<long> CountAsync(string? status,string q)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sellers WHERE "+Filter,new{status,q,like="%"+q+"%"});
    public Task<IEnumerable<SellerModel>> ListAsync(string? status,string q,int offset,int size)=>db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE "+Filter+" ORDER BY CASE WHEN @status='submitted' THEN submitted_at IS NULL END,CASE WHEN @status='submitted' THEN submitted_at END ASC,CASE WHEN @status IS NULL OR @status<>'submitted' THEN created_at END DESC LIMIT @size OFFSET @offset",new{status,q,like="%"+q+"%",offset,size});
    public class CountRow{public string Status{get;set;}="";public int N{get;set;}}
    public Task<IEnumerable<CountRow>> CountsAsync()=>db.QueryAsync<CountRow>("SELECT status,COUNT(*) n FROM sellers GROUP BY status");
}
