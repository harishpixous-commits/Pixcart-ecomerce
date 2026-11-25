using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;
public class AdminSearchBAL(AdminSearchDAL data,IAccessBAL access):IAdminSearchBAL
{
    private static readonly (string Permission,string Kind)[] Sources=[("orders","order"),("customers","customer"),("sellers","seller"),("catalog","product"),("delivery","partner"),("support","ticket"),("payouts","payout")];
    private static string Dot(params string[] values)=>string.Join(" · ",values.Where(x=>!string.IsNullOrEmpty(x)));
    private static string Phone(string phone){var p=Regex.Replace(phone,@"\D","");return p.Length>=4?"•••• "+p[^4..]:"";}
    private static string Email(string email){var i=email.IndexOf('@');return i<0?"":email[..Math.Min(1,i)]+"•••"+email[i..];}
    private static string Inr(long amount){var rupees=Math.DivRem(amount,100,out var p);return "₹"+rupees.ToString("N0",CultureInfo.InvariantCulture)+(p!=0?"."+p.ToString("D2"):"");}
    public async Task<JsonObject> SearchAsync(UserModel user,string q)
    {
        if(!user.IsAdmin)throw new ForbiddenException("Admin access required");q=Regex.Replace(q.Trim(),@"\s+"," ");var results=new JsonArray();if(q.Length<2)return new(){["q"]=q,["results"]=results};var allowed=await access.PermissionsForAsync(user);var byId=Guid.TryParse(q,out var parsed);Guid? id=byId?parsed:null;var words=q.Split(' ').Take(6).ToArray();
        foreach(var(permission,kind)in Sources)if(allowed.Contains(permission))foreach(var r in await data.FindAsync(kind,words,id))
        {
            var title=kind=="customer"&&r.Title.Length==0?"Customer without a name":r.Title;
            var sub=byId?kind switch{"customer" or "partner"=>Phone(r.Phone),"ticket"=>r.Name,_=>r.Status}:kind switch
            {"order"=>Dot(r.Name,r.Status.Replace('_',' '),Inr(r.Amount)),"customer"=>Dot(Phone(r.Phone),Email(r.Email),r.IsActive?"":"blocked"),"seller"=>Dot(r.Name,r.City,r.Status),"product"=>Dot(r.Brand,r.Name,r.Status),"partner"=>Dot(Phone(r.Phone),"KYC "+r.Status),"ticket"=>Dot(r.Name,r.Status.Replace('_',' ')),"payout"=>Dot(r.Name,Inr(r.Amount),r.Status),_=>""};
            var href=kind switch{"order"=>"/admin/orders/"+r.Id,"customer"=>"/admin/customers/"+r.Id,"seller"=>"/admin/sellers/"+r.Id,"product"=>"/admin/products/"+r.Id,"partner"=>"/admin/delivery/partners/"+r.Id,"ticket"=>"/admin/support/"+r.Id,_=>"/admin/payouts?seller_id="+r.SellerId};
            results.Add(new JsonObject{["kind"]=kind,["id"]=r.Id.ToString(),["title"]=title,["sub"]=sub,["href"]=href});
        }
        return new(){["q"]=q,["results"]=results};
    }
}
