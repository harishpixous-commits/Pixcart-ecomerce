using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class NotificationAdminDAL(IMySqlDapperHelper db)
{
    public Task<IEnumerable<NotificationTemplateModel>> TemplatesAsync()=>db.QueryAsync<NotificationTemplateModel>("SELECT * FROM notification_templates");
    public Task<IEnumerable<NotificationStatusRow>> StatsAsync()=>db.QueryAsync<NotificationStatusRow>("SELECT status,COUNT(*) AS N FROM notifications WHERE channel<>'inapp' GROUP BY status");
    public Task SaveAsync(string evt,string channel,string subject,string body,string provider,bool active,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO notification_templates(id,event,channel,subject,body,provider_template,is_active,created_at,updated_at)VALUES(@id,@evt,@channel,@subject,@body,@provider,@active,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE subject=VALUES(subject),body=VALUES(body),provider_template=VALUES(provider_template),is_active=VALUES(is_active),updated_at=VALUES(updated_at)",new{id=Guid.NewGuid(),evt,channel,subject,body,provider,active});
    public Task<IEnumerable<CouponModel>> CouponsAsync()=>db.QueryAsync<CouponModel>("SELECT * FROM coupons ORDER BY created_at DESC");
}
public class NotificationStatusRow{public string Status{get;set;}="";public long N{get;set;}}
