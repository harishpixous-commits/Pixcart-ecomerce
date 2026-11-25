using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
namespace BAL;
public class SetupStatusBAL(IAccessBAL access,ISiteBAL site,IIntegrationBAL integrations,CmsDAL cms):ISetupStatusBAL
{
    public async Task<JsonObject> ReadAsync(UserModel user)
    {
        await access.RequireAsync(user,"dashboard");var doc=await site.GetSiteAsync();var ic=await integrations.GetAsync();var business=doc["business"]!.AsObject();var grievance=business["grievance"]!.AsObject();var pages=(await cms.AllPagesAsync()).ToDictionary(x=>x.Slug);bool Has(JsonObject obj,string key)=>!string.IsNullOrEmpty(obj[key]?.GetValue<string>());bool Page(string slug)=>pages.TryGetValue(slug,out var page)&&page.IsPublished;var items=new JsonArray();void Add(string key,string label,bool done,string href)=>items.Add(new JsonObject{["key"]=key,["label"]=label,["done"]=done,["href"]=href});
        const string biz="/admin/storefront?tab=business",pageHref="/admin/storefront?tab=pages";
        Add("business_name","Registered business name",Has(business,"legal_name"),biz);Add("registered_address","Registered address",Has(business,"registered_address"),biz);Add("gstin","Your GSTIN as an e-commerce operator",Has(business,"gstin"),biz);Add("grievance","Grievance officer name and email",Has(grievance,"name")&&Has(grievance,"email"),biz);Add("contact","Customer care email or phone",doc["contact"]!["items"]!.AsArray().Any(i=>i!["enabled"]!.GetValue<bool>()&&i["type"]!.GetValue<string>() is "email" or "phone"),biz);Add("terms","Terms of use page",Page("terms"),pageHref);Add("privacy","Privacy notice page",Page("privacy"),pageHref);Add("returns","Returns and refunds page",Page("returns-policy"),pageHref);Add("payments","Online payments (Razorpay)",ic.OnlinePayments&&ic.RazorpayWebhookSecret.Length>0,"/admin/integrations#razorpay");Add("sms","Login OTP by SMS (MSG91)",ic.SmsProvider=="msg91"&&ic.Msg91AuthKey.Length>0,"/admin/integrations#msg91");Add("two_step","Two-step sign-in on your admin account",user.TotpEnabled,"/admin/account");return new(){["done"]=items.Count(i=>i!["done"]!.GetValue<bool>()),["total"]=items.Count,["items"]=items};
    }
}
