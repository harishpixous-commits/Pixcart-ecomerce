using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class AdminPayoutBAL(AdminPayoutDAL data,IAccessBAL access,IIntegrationBAL integrations,EncryptDecrypt crypto,IMySqlDapperHelper db,AuditDAL audit,INotifyBAL notify):IAdminPayoutBAL
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

    public async Task<JsonObject> ChangeAsync(UserModel user,Guid id,string action,string utr="")
    {
        await access.RequireAsync(user,"payouts");await using var tx=await db.BeginAsync();var p=await data.LockAsync(id,tx);var detail="";var now=DateTime.UtcNow;SellerModel? seller=null;
        if(action=="use-current-bank")
        {
            if(p is null||p.Status!="pending")throw new AppException("Only pending payouts can be changed","invalid_status",409);seller=(await data.SellerAsync(p.SellerId))!;var before=(JsonNode.Parse(p.BankSnapshot) as JsonObject)?["account_last4"]?.GetValue<string>()??"";var acct=crypto.Decrypt(seller.BankAccountEnc);var last=acct.Length>4?acct[^4..]:acct;p.BankSnapshot=new JsonObject{["holder"]=seller.BankHolderName,["account_last4"]=last,["ifsc"]=seller.BankIfsc,["account_enc"]=seller.BankAccountEnc}.ToJsonString();detail=$"account …{before} → …{last}";
        }
        else if(action=="cancel")
        {
            if(p is null||p.Status!="pending")throw new AppException("Only pending payouts can be cancelled","invalid_status",409);await data.ReleaseAsync(p.Id,tx);p.Status="cancelled";p.FailureReason="Cancelled by admin";
        }
        else
        {
            if(p is null)throw new NotFoundException("Payout");if(p.Status is "paid" or "cancelled")throw new AppException($"Payout is already {p.Status}","invalid_status",409);p.Status="paid";p.Utr=utr;p.PaidAt=now;detail=utr;var last=(JsonNode.Parse(p.BankSnapshot) as JsonObject)?["account_last4"]?.GetValue<string>()??"";await notify.NotifySellerAsync(p.SellerId,"payout_sent",new Dictionary<string,object?>{["payout_number"]=p.Number,["amount"]="₹"+(p.Amount/100.0).ToString("N2",System.Globalization.CultureInfo.InvariantCulture),["last4"]=last,["utr"]=utr},"/seller/payouts",tx);
        }
        p.UpdatedAt=now;await data.SaveAsync(p,tx);await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action=action=="use-current-bank"?"payout.bank_confirmed":"payout."+action,EntityType="payout",EntityId=id.ToString(),Detail=detail,CreatedAt=now},tx.Transaction);await tx.CommitAsync();return seller is null?SellerHubBAL.PayoutOut(p):Out(p,seller);
    }
}
