using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminListsDAL(IMySqlDapperHelper db)
{
    public class CustomerRow:UserModel{public int Orders{get;set;}public Guid? SellerId{get;set;}public string? SellerStatus{get;set;}}
    private const string CustomerFilter="u.deleted_at IS NULL AND (@kind='all' OR (@kind='customers' AND NOT u.is_admin AND NOT EXISTS(SELECT 1 FROM sellers s WHERE s.user_id=u.id)) OR (@kind='sellers' AND EXISTS(SELECT 1 FROM sellers s WHERE s.user_id=u.id)) OR (@kind='staff' AND u.is_admin) OR (@kind='blocked' AND NOT u.is_active)) AND (@q='' OR u.name LIKE @like OR u.phone LIKE @like OR u.email LIKE @like OR CAST(u.staff_tags AS CHAR) LIKE @like) AND (@tag='' OR JSON_CONTAINS(CAST(LOWER(CAST(u.staff_tags AS CHAR)) AS JSON), JSON_QUOTE(LOWER(@tag))))";
    public Task<long> CustomerCountAsync(string q,string kind,string tag="")=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM users u WHERE "+CustomerFilter,new{q,like="%"+q+"%",kind,tag});
    public Task<IEnumerable<CustomerRow>> CustomersAsync(string q,string kind,int offset,int size,string tag="")=>db.QueryAsync<CustomerRow>("SELECT u.*,(SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.status='placed') orders,s.id seller_id,s.status seller_status FROM users u LEFT JOIN sellers s ON s.user_id=u.id WHERE "+CustomerFilter+" ORDER BY u.created_at DESC LIMIT @size OFFSET @offset",new{q,like="%"+q+"%",kind,offset,size,tag});
    public class AuditRow:AuditLogModel{public string? Actor{get;set;}}
    public Task<IEnumerable<AuditRow>> AuditAsync(string? entity,int offset)=>db.QueryAsync<AuditRow>("SELECT a.*,COALESCE(NULLIF(u.name,''),NULLIF(u.phone,''),'system') actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE @entity IS NULL OR @entity='' OR a.entity_id=@entity ORDER BY a.created_at DESC LIMIT 50 OFFSET @offset",new{entity,offset});
    public class TicketRow:SupportTicketModel{public string Customer{get;set;}="";}
    private const string TicketFilter="(@status IS NULL OR @status='' OR t.status=@status) AND (NOT @overdue OR (t.acknowledged_at IS NULL AND t.ack_due_at<NOW())) AND (NOT @grievance OR t.is_grievance) AND (@q='' OR t.number LIKE @like OR t.subject LIKE @like OR u.phone LIKE @like OR u.name LIKE @like)";
    public Task<long> TicketCountAsync(string? status,bool overdue,bool grievance,string q)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE "+TicketFilter,new{status,overdue,grievance,q,like="%"+q+"%"});
    public Task<IEnumerable<TicketRow>> TicketsAsync(string? status,bool overdue,bool grievance,string q,int offset)=>db.QueryAsync<TicketRow>("SELECT t.*,COALESCE(NULLIF(u.name,''),u.phone) customer FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE "+TicketFilter+" ORDER BY t.ack_due_at LIMIT 30 OFFSET @offset",new{status,overdue,grievance,q,like="%"+q+"%",offset});
    public class CountRow{public string Status{get;set;}="";public int N{get;set;}}
    public Task<IEnumerable<CountRow>> CountsAsync()=>db.QueryAsync<CountRow>("SELECT status,COUNT(*) n FROM support_tickets GROUP BY status");
}
