using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;
public class AdminPayoutBAL(AdminPayoutDAL data,IAccessBAL access,IIntegrationBAL integrations,EncryptDecrypt crypto):IAdminPayoutBAL
{
    internal bool BankChanged(PayoutModel p,SellerModel seller)
    {
        var snap=JsonNode.Parse(p.BankSnapshot) as JsonObject??[];var enc=snap["account_enc"]?.GetValue<string>();return !string.IsNullOrEmpty(enc)&&(crypto.Decrypt(enc)!=crypto.Decrypt(seller.BankAccountEnc)||snap["ifsc"]?.GetValue<string>()!=seller.BankIfsc||snap["holder"]?.GetValue<string>()!=seller.BankHolderName);
    }
    internal JsonObject Out(PayoutModel p,SellerModel seller)
    {var o=SellerHubBAL.PayoutOut(p);o["seller_name"]=seller.DisplayName;o["bank_changed"]=p.Status=="pending"&&BankChanged(p,seller);return o;}
    public async Task<JsonObject> ListAsync(UserModel user,string? status,Guid? seller,int page)
    {
        await access.RequireAsync(user,"payouts");var count=await data.CountAsync(status,seller);var rows=await data.ListAsync(status,seller,page);var due=await data.DueAsync(DateTime.UtcNow);var cfg=await integrations.GetAsync();var items=new JsonArray();foreach(var p in rows)items.Add(Out(p,(await data.SellerAsync(p.SellerId))!));return new(){["total"]=count,["page"]=page,["page_size"]=50,["mode"]=cfg.PayoutMode,["razorpayx_ready"]=cfg.RazorpayEnabled&&cfg.RazorpayxAccountNumber.Length>0,["due"]=new JsonArray(due.Select(d=>(JsonNode)new JsonObject{["seller"]=d.Seller,["amount"]=d.Amount}).ToArray()),["items"]=items};
    }
}
