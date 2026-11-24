using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public record AdminOrderFilter(string? Status,string Q,string Like,string Digits,string? PaymentMethod,string? PaymentStatus,string? PackageStatus,Guid? Seller,Guid? Customer,DateTime? From,DateTime? Until,int Offset,int Size);
public class AdminOrdersDAL(IMySqlDapperHelper db)
{
    private const string Filter="(@Status IS NULL OR o.status=@Status) AND (@PaymentMethod IS NULL OR o.payment_method=@PaymentMethod) AND (@PaymentStatus IS NULL OR o.payment_status=@PaymentStatus) AND (@Customer IS NULL OR o.user_id=@Customer) AND (@From IS NULL OR o.created_at>=@From) AND (@Until IS NULL OR o.created_at<@Until) AND ((@PackageStatus IS NULL AND @Seller IS NULL) OR EXISTS(SELECT 1 FROM sub_orders s WHERE s.order_id=o.id AND (@PackageStatus IS NULL OR s.status=@PackageStatus) AND (@Seller IS NULL OR s.seller_id=@Seller))) AND (@Q='' OR o.number LIKE @Like OR u.phone LIKE @Like OR u.name LIKE @Like OR u.email LIKE @Like OR EXISTS(SELECT 1 FROM sub_orders s WHERE s.order_id=o.id AND (s.number LIKE @Like OR s.tracking_number LIKE @Like)) OR (@Digits<>'' AND JSON_UNQUOTE(JSON_EXTRACT(o.ship_to,'$.phone')) LIKE CONCAT('%',@Digits,'%')))";
    public class Row:OrderModel{public string Customer{get;set;}="";public string? Phone{get;set;}}
    public Task<long> CountAsync(AdminOrderFilter q)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM orders o JOIN users u ON u.id=o.user_id WHERE "+Filter,q);
    public Task<IEnumerable<Row>> ListAsync(AdminOrderFilter q)=>db.QueryAsync<Row>("SELECT o.*,COALESCE(NULLIF(u.name,''),u.phone) customer,u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE "+Filter+" ORDER BY o.created_at DESC LIMIT @Size OFFSET @Offset",q);
    public class PackageRow{public Guid OrderId{get;set;}public string Status{get;set;}="";}
    public Task<IEnumerable<PackageRow>> PackagesAsync(Guid[] ids)=>db.QueryAsync<PackageRow>("SELECT order_id,status FROM sub_orders WHERE order_id IN @ids ORDER BY number",new{ids});
    public Task<UserModel?> UserAsync(Guid id)=>db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id=@id",new{id});
}
