using Dapper;
using Utils.Interface;
namespace DAL;
public class AdminSearchDAL(IMySqlDapperHelper db)
{
    public Task<IEnumerable<AdminFoundRow>> FindAsync(string kind,string[] words,Guid? id)
    {
        var (select,from,key,fields,guard)=kind switch
        {
            "order"=>("o.id,o.number AS Title,o.status AS Status,o.grand_total AS Amount,u.name AS Name","orders o JOIN users u ON u.id=o.user_id","o.id",new[]{"o.number","u.name","u.phone"},"1=1"),
            "customer"=>("u.id,u.name AS Title,u.phone AS Phone,u.email AS Email,u.is_active AS IsActive","users u","u.id",new[]{"u.name","u.phone","u.email"},"u.deleted_at IS NULL AND u.is_admin=0"+(id is null?" AND NOT EXISTS(SELECT 1 FROM sellers s WHERE s.user_id=u.id)":"")),
            "seller"=>("s.id,s.display_name AS Title,s.legal_name AS Name,s.pickup_city AS City,s.status AS Status","sellers s","s.id",new[]{"s.display_name","s.legal_name","s.gstin","s.contact_phone","s.contact_email"},"1=1"),
            "product"=>("p.id,p.title AS Title,p.brand AS Brand,p.status AS Status,s.display_name AS Name","products p JOIN sellers s ON s.id=p.seller_id","p.id",new[]{"p.title","p.brand","SKU"},"1=1"),
            "partner"=>("b.id,b.name AS Title,b.phone AS Phone,b.kyc_status AS Status","delivery_boys b","b.id",new[]{"b.name","b.phone"},"1=1"),
            "ticket"=>("t.id,t.number AS Title,t.subject AS Name,t.status AS Status","support_tickets t","t.id",new[]{"t.number","t.subject"},"1=1"),
            "payout"=>("p.id,p.number AS Title,p.status AS Status,p.amount AS Amount,p.seller_id AS SellerId,s.display_name AS Name","payouts p JOIN sellers s ON s.id=p.seller_id","p.id",new[]{"p.number","p.utr","s.display_name"},"1=1"),
            _=>throw new ArgumentException("Unknown search kind")
        };
        var p=new DynamicParameters();var where=guard;if(id is not null){where+=" AND "+key+"=@id";p.Add("id",id);}
        else for(var i=0;i<words.Length;i++){var w=words[i];p.Add("w"+i,"%"+w.Replace("\\","\\\\").Replace("%","\\%").Replace("_","\\_")+"%");where+=" AND ("+string.Join(" OR ",fields.Select(f=>f=="SKU"?$"EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.sku LIKE @w{i})":$"{f} LIKE @w{i}"))+")";}
        return db.QueryAsync<AdminFoundRow>("SELECT "+select+" FROM "+from+" WHERE "+where+" ORDER BY "+key.Split('.')[0]+".created_at DESC LIMIT 5",p);
    }
}
public class AdminFoundRow{public Guid Id{get;set;}public string Title{get;set;}="";public string Status{get;set;}="";public string Name{get;set;}="";public string City{get;set;}="";public string Brand{get;set;}="";public string Phone{get;set;}="";public string Email{get;set;}="";public bool IsActive{get;set;}public long Amount{get;set;}public Guid SellerId{get;set;}}
