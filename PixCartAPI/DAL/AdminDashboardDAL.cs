using Utils.Interface;
namespace DAL;
public class AdminDashboardDAL(IMySqlDapperHelper db)
{
    public Task<long> ScalarAsync(string sql,DateTime since,DateTime today)=>db.ExecuteScalarAsync<long>(sql,new{since,today});
}
