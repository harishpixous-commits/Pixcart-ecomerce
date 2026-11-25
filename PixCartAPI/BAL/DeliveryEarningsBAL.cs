using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
namespace BAL;
public partial class DeliveryFleetBAL
{
    private static DateTime IstStart(DateOnly d)=>DateTime.SpecifyKind(d.ToDateTime(TimeOnly.MinValue)-Ist,DateTimeKind.Utc);
    private static JsonObject EarningsOut(EarningTotals p)=>new(){["trips"]=p.Trips,["fees"]=p.Fees,["tips"]=p.Tips,["bonuses"]=p.Bonuses,["earned"]=p.Fees+p.Tips+p.Bonuses,["cod_collected"]=p.CodCollected};
    public async Task<JsonObject> EarningsAsync(UserModel user)
    {
        var boy=await partners.RequirePartnerAsync(user);var today=DateOnly.FromDateTime(DateTime.UtcNow+Ist);var monday=today.AddDays(-(((int)today.DayOfWeek+6)%7));
        async Task<JsonObject> Period(DateTime? since)=>EarningsOut((await fleet.EarningsPeriodAsync(boy.Id,since))!);
        var days=new JsonArray();for(var k=6;k>=0;k--){var d=today.AddDays(-k);var p=(await fleet.EarningsPeriodAsync(boy.Id,IstStart(d),IstStart(d.AddDays(1))))!;days.Add(new JsonObject{["date"]=d.ToString("yyyy-MM-dd"),["trips"]=p.Trips,["earned"]=p.Fees+p.Tips+p.Bonuses});}
        var ps=new JsonArray();foreach(var p in await fleet.PartnerPayoutsAsync(boy.Id))ps.Add(new JsonObject{["id"]=p.Id.ToString(),["period_start"]=p.PeriodStart.ToString("yyyy-MM-dd"),["period_end"]=p.PeriodEnd.ToString("yyyy-MM-dd"),["deliveries"]=p.Deliveries,["amount"]=p.Amount,["cod_deducted"]=p.CodDeducted,["net_amount"]=p.NetAmount,["status"]=p.Status,["paid_at"]=p.PaidAt?.ToString("o"),["reference"]=p.Reference});
        var ds=new JsonArray();foreach(var d in await fleet.PartnerDepositsAsync(boy.Id))ds.Add(new JsonObject{["amount"]=d.Amount,["method"]=d.Method,["reference"]=d.Reference,["at"]=d.CreatedAt.ToString("o")});
        await using var tx=await db.BeginAsync();var cash=await CashInHandAsync(boy.Id,tx);var cfg=await deliverySettings.GetAsync();
        return new JsonObject{["today"]=await Period(IstStart(today)),["week"]=await Period(IstStart(monday)),["month"]=await Period(IstStart(new(today.Year,today.Month,1))),["total"]=await Period(null),["days"]=days,["cash_in_hand"]=cash,["cash_limit"]=Long(cfg,"cod_limit_paise"),["unpaid"]=await fleet.UnpaidEarningsAsync(boy.Id),["payouts"]=ps,["deposits"]=ds};
    }
    public async Task<JsonObject> HistoryAsync(UserModel user,DateOnly? from,DateOnly? to,string status,int page)
    {
        var boy=await partners.RequirePartnerAsync(user);DateTime? since=from is null?null:IstStart(from.Value),until=to is null?null:IstStart(to.Value.AddDays(1));var total=await fleet.PartnerHistoryCountAsync(boy.Id,status,since,until);var items=new JsonArray();
        foreach(var a in await fleet.PartnerHistoryAsync(boy.Id,status,since,until,(page-1)*20)){var item=AssignmentBrief(a);var ship=JsonNode.Parse(a.ShipTo) as JsonObject??new();item["order_number"]=a.OrderNumber;item["drop_area"]=string.Join(", ",new[]{ship["city"]?.GetValue<string>()??"",ship["pincode"]?.GetValue<string>()??""}.Where(x=>x.Length>0));items.Add(item);}
        return new(){["items"]=items,["total"]=total,["page"]=page,["page_size"]=20};
    }
}
