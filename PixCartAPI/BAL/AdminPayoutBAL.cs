using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class AdminPayoutBAL(AdminPayoutDAL data,IAccessBAL access,IIntegrationBAL integrations,EncryptDecrypt crypto,IMySqlDapperHelper db,AuditDAL audit,INotifyBAL notify,ISiteBAL site,IPayoutsBAL payouts,IPlatformSettingsBAL platform,IPayoutGatewayBAL gateway):IAdminPayoutBAL
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
    internal static string Narration(string brand,string number){var text=System.Text.RegularExpressions.Regex.Replace(brand+" "+number,"[^A-Za-z0-9 ]"," ");text=System.Text.RegularExpressions.Regex.Replace(text,@"\s+"," ").Trim();return text[..Math.Min(30,text.Length)].Trim();}
    internal static string Cell(string value){if(value.Length>0&&"=+-@\t\r".Contains(value[0]))value="'"+value;return "\""+value.Replace("\"","\"\"")+"\"";}
    public async Task<(string Csv,string Filename)> BankFileAsync(UserModel user)
    {
        await access.RequireAsync(user,"payouts");var rows=(await data.ManualPendingAsync()).ToList();await using(var tx=await db.BeginAsync()){await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="payout.bank_file",EntityType="payout",EntityId="batch",Detail=$"{rows.Count} rows",CreatedAt=DateTime.UtcNow},tx.Transaction);await tx.CommitAsync();}var brand=(await site.GetSiteAsync())["brand_name"]!.GetValue<string>();var lines=new List<string>{"Payout number,Beneficiary name,Account number,IFSC,Amount (INR),Narration"};foreach(var p in rows){var seller=(await data.SellerAsync(p.SellerId))!;if(BankChanged(p,seller))continue;var snap=JsonNode.Parse(p.BankSnapshot) as JsonObject??[];string Saved(string key,string fallback)=>string.IsNullOrEmpty(snap[key]?.GetValue<string>())?fallback:snap[key]!.GetValue<string>();var account=crypto.Decrypt(Saved("account_enc",seller.BankAccountEnc??""));lines.Add(string.Join(",",Cell(p.Number),Cell(Saved("holder",seller.BankHolderName)),Cell(account),Cell(Saved("ifsc",seller.BankIfsc)),(p.Amount/100.0).ToString("F2",System.Globalization.CultureInfo.InvariantCulture),Cell(Narration(brand,p.Number))));}var slug=System.Text.RegularExpressions.Regex.Replace(brand.ToLowerInvariant(),"[^a-z0-9]+","-").Trim('-');if(slug.Length==0)slug="payouts";return(string.Join("\n",lines)+"\n",$"{slug}-bank-transfer-{DateTime.UtcNow.AddMinutes(330):yyyy-MM-dd}.csv");
    }

    public async Task<JsonObject> RunAsync(UserModel user)
    {await access.RequireAsync(user,"payouts");var cfg=await platform.GetAsync();await using var tx=await db.BeginAsync();var made=await payouts.CreatePayoutsAsync(cfg.Long("payout_min_paise"),tx);await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="payout.run",EntityType="payout",EntityId="batch",Detail=$"{made.Count} payouts",CreatedAt=DateTime.UtcNow},tx.Transaction);await tx.CommitAsync();return new(){["created"]=made.Count,["items"]=new JsonArray(made.Select(p=>(JsonNode)SellerHubBAL.PayoutOut(p)).ToArray())};}

    public async Task<JsonObject> SendAsync(UserModel user,Guid id)
    {
        await access.RequireAsync(user,"payouts");await using var tx=await db.BeginAsync();var p=await data.LockAsync(id,tx)??throw new NotFoundException("Payout");if(p.Status!="pending")throw new AppException($"A {p.Status} payout cannot be sent","invalid_status",409);var cfg=await integrations.GetAsync();var seller=(await data.SellerAsync(p.SellerId))!;if(BankChanged(p,seller))throw new AppException("The seller's bank account changed after this payout was created. Check it with the seller, then confirm the new account on the payout (or cancel it) before sending.","bank_changed",409);if(!(cfg.RazorpayEnabled&&cfg.RazorpayxAccountNumber.Length>0))throw new AppException("RazorpayX is not configured","payout_not_configured");
        if(seller.PayoutFundAccountId.Length==0)
        {
            var contact=await gateway.PostAsync(cfg,"/contacts",new(){["name"]=seller.LegalName[..Math.Min(50,seller.LegalName.Length)],["email"]=seller.ContactEmail,["contact"]=seller.ContactPhone,["type"]="vendor",["reference_id"]=seller.Id.ToString()});var fund=await gateway.PostAsync(cfg,"/fund_accounts",new(){["contact_id"]=contact["id"]!.GetValue<string>(),["account_type"]="bank_account",["bank_account"]=new JsonObject{["name"]=seller.BankHolderName,["ifsc"]=seller.BankIfsc,["account_number"]=crypto.Decrypt(seller.BankAccountEnc)}});seller.PayoutContactId=contact["id"]!.GetValue<string>();seller.PayoutFundAccountId=fund["id"]!.GetValue<string>();await data.SaveGatewayAccountAsync(seller,tx);
        }
        var brand=(await site.GetSiteAsync())["brand_name"]!.GetValue<string>();var result=await gateway.PostAsync(cfg,"/payouts",new(){["account_number"]=cfg.RazorpayxAccountNumber,["fund_account_id"]=seller.PayoutFundAccountId,["amount"]=p.Amount,["currency"]="INR",["mode"]=p.Amount<=50000000?"IMPS":"NEFT",["purpose"]="vendor bill",["queue_if_low_balance"]=true,["reference_id"]=p.Number,["narration"]=Narration(brand,p.Number)},p.Id.ToString());p.ProviderPayoutId=result["id"]?.GetValue<string>()??"";p.Status="processing";p.UpdatedAt=DateTime.UtcNow;await data.SaveAsync(p,tx);await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="payout.send",EntityType="payout",EntityId=p.Id.ToString(),CreatedAt=DateTime.UtcNow},tx.Transaction);await tx.CommitAsync();return SellerHubBAL.PayoutOut(p);
    }

}
