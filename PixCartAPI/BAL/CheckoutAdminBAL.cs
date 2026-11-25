using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class CheckoutAdminBAL(IAccessBAL access,IPlatformSettingsBAL platform,IFeesBAL fees,CatalogSupportDAL support,IAuditBAL audit,IMySqlDapperHelper db):ICheckoutAdminBAL
{
    private static readonly string[] Keys=["shipping_fee_paise","free_shipping_threshold_paise","cod_enabled","cod_fee_paise","cod_max_order_paise"];
    private static JsonObject Market(JsonObject body)=>body["marketplace"] is JsonObject m?new JsonObject(m.Where(x=>Keys.Contains(x.Key)).Select(x=>KeyValuePair.Create(x.Key,x.Value?.DeepClone()))):new();
    private async Task<JsonObject> OutAsync(){var cfg=await platform.GetAsync();var ck=await fees.GetAsync();return new(){["marketplace"]=new JsonObject(Keys.Select(k=>KeyValuePair.Create(k,cfg[k]?.DeepClone()))),["fees"]=ck,["status"]=FeesBAL.Status(ck)};}
    public async Task<JsonObject> ReadAsync(UserModel u){await access.RequireAsync(u,"settings");return await OutAsync();}
    public async Task<JsonObject> SaveAsync(UserModel u,JsonObject body)
    {await access.RequireAsync(u,"settings");var market=platform.Validate(Market(body));var sent=body["fees"] as JsonObject??new();var clean=FeesBAL.ValidateUpdates(sent,await fees.GetAsync());await using var tx=await db.BeginAsync();if(market.Count>0)await platform.MergeValidatedAsync(market,tx);if(clean.Count>0)await support.MergeSettingsAsync(FeesBAL.Key,clean,tx);var detail=string.Join(",",market.Select(x=>x.Key).Concat(sent.Select(x=>x.Key)).Order());await audit.AuditAsync(u,"settings.checkout","settings","checkout",detail[..Math.Min(200,detail.Length)],tx);await tx.CommitAsync();platform.InvalidateCache();return await OutAsync();}
    public async Task<JsonObject> PreviewAsync(UserModel u,JsonObject body)
    {
        await access.RequireAsync(u,"settings");var cfg=(JsonObject)(await platform.GetAsync()).DeepClone();foreach(var(k,v)in Market(body))cfg[k]=v?.DeepClone();var saved=await fees.GetAsync();var ck=(JsonObject)saved.DeepClone();var sent=body["fees"] as JsonObject??new();foreach(var(k,v)in sent)if(FeesBAL.Defaults().ContainsKey(k)&&k!="surge_until")ck[k]=v?.DeepClone();
        if(sent.ContainsKey("surge_hours")){if(!SettingsJson.IsWholeNumber(sent["surge_hours"],out var h)||h is <0 or >FeesBAL.SurgeHoursMax)throw new AppException($"Charge the bad weather fee for 1 to {FeesBAL.SurgeHoursMax} hours, or until you switch it off","invalid_setting");ck["surge_until"]=FeesBAL.SurgeHoursUntil((int)h);}else if(sent.ContainsKey("surge_enabled")&&sent.Bool("surge_enabled")!=saved.Bool("surge_enabled"))ck["surge_until"]="";
        if(!FeesBAL.ValidTime(ck.Str("late_night_from"))||!FeesBAL.ValidTime(ck.Str("late_night_to"))||ck.Str("late_night_from")==ck.Str("late_night_to"))ck["late_night_enabled"]=false;
        var items=Math.Max(0,body.Long("items_total"));var shipping=items>=cfg.Long("free_shipping_threshold_paise")||items==0?0:cfg.Long("shipping_fee_paise");var cod=body.Bool("cod")?cfg.Long("cod_fee_paise"):0;var lines=FeesBAL.OrderFees(ck,items,night:body.Bool("night"));var groups=new JsonArray(new JsonObject{["seller"]=new JsonObject{["name"]="a seller"},["shipping_fee"]=shipping,["free_shipping_gap"]=shipping>0?Math.Max(0,cfg.Long("free_shipping_threshold_paise")-items):0});return new(){["items_total"]=items,["shipping"]=shipping,["cod_fee"]=cod,["fees"]=lines,["total"]=items+shipping+cod+lines.Sum(x=>x!["amount"]!.GetValue<long>()),["hints"]=FeesBAL.Hints(ck,cfg,items,groups)};
    }
}
