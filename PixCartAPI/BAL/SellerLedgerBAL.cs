using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
namespace BAL;
public partial interface ISellerHubBAL
{
    Task<JsonObject> PayoutsAsync(SellerModel seller);
    Task<JsonObject> LedgerAsync(SellerModel seller,int page);
}
public partial class SellerHubBAL
{
    private sealed class LedgerRow:SellerLedgerModel{public string? OrderNumber{get;set;}public string? PayoutNumber{get;set;}}
    public async Task<JsonObject> PayoutsAsync(SellerModel s)
    {
        var bal=await orders.LedgerBalancesAsync(s.Id);var rows=await db.QueryAsync<PayoutModel>("SELECT * FROM payouts WHERE seller_id=@sid ORDER BY created_at DESC LIMIT 100",new{sid=s.Id});
        return new JsonObject{["balances"]=new JsonObject{["available"]=bal.Available,["upcoming"]=bal.Upcoming,["paid_out"]=bal.PaidOut},["payouts"]=new JsonArray(rows.Select(p=>(JsonNode)PayoutOut(p)).ToArray()),["schedule"]=payouts.Schedule(await platform.GetAsync())};
    }
    internal static JsonObject PayoutOut(PayoutModel p)
    {
        var bank=JsonNode.Parse(p.BankSnapshot) as JsonObject??[];bank.Remove("account_enc");
        return new JsonObject{["id"]=p.Id.ToString(),["number"]=p.Number,["seller_id"]=p.SellerId.ToString(),["seller_name"]="",["amount"]=p.Amount,["status"]=p.Status,["mode"]=p.Mode,["utr"]=p.Utr,["failure_reason"]=p.FailureReason,["bank"]=bank,["bank_changed"]=false,["created_at"]=DateTimeFunctions.Iso(p.CreatedAt),["paid_at"]=p.PaidAt is {} at?DateTimeFunctions.Iso(at):null};
    }
    public async Task<JsonObject> LedgerAsync(SellerModel s,int page)
    {
        var now=DateTimeFunctions.UtcNow();var rows=await db.QueryAsync<LedgerRow>("SELECT l.*,s.number AS order_number,p.number AS payout_number FROM seller_ledger l LEFT JOIN sub_orders s ON s.id=l.sub_order_id LEFT JOIN payouts p ON p.id=l.payout_id WHERE l.seller_id=@sid ORDER BY l.created_at DESC,l.kind LIMIT 50 OFFSET @offset",new{sid=s.Id,offset=(long)(page-1)*50});
        return new JsonObject{["items"]=new JsonArray(rows.Select(e=>(JsonNode)new JsonObject{["at"]=DateTimeFunctions.Iso(e.CreatedAt),["kind"]=e.Kind,["amount"]=e.Amount,["description"]=e.Description,["order"]=e.OrderNumber,["available_at"]=DateTimeFunctions.Iso(e.AvailableAt),["available"]=e.AvailableAt<=now,["payout"]=e.PayoutNumber}).ToArray()),["page"]=page};
    }
}
