using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;
public class TcsReportBAL(TcsReportDAL data,IAccessBAL access,IPlatformSettingsBAL settings):ITcsReportBAL
{
    public async Task<JsonObject> ReadAsync(UserModel user,string month)
    {
        await access.RequireAsync(user,"reports");return await DataAsync(month);
    }
    /// <summary>Reference: services.reports.tcs_report_data (the caller has checked the reports permission).</summary>
    public async Task<JsonObject> DataAsync(string month)
    {
        DateTime start,end;try{var local=DateTime.ParseExact(month+"-01","yyyy-MM-dd",System.Globalization.CultureInfo.InvariantCulture);start=local.AddMinutes(-330);end=local.AddMonths(1).AddMinutes(-330);}catch(ArgumentException){throw new AppException("Invalid month","validation",422);}catch(FormatException){throw new AppException("Invalid month","validation",422);}
        var rows=(await data.SalesAsync(start,end)).Concat(await data.ReturnsAsync(start,end));var by=new Dictionary<Guid,JsonObject>();foreach(var r in rows){if(!by.TryGetValue(r.SellerId,out var o)){o=new(){["seller_id"]=r.SellerId.ToString(),["legal_name"]=r.LegalName,["gstin"]=r.Gstin,["net_taxable_value"]=0L,["igst_tcs"]=0L,["cgst_tcs"]=0L,["sgst_tcs"]=0L,["sub_orders"]=0L,["returned_value"]=0L};by[r.SellerId]=o;}var taxable=(long)r.Taxable;void Add(string key,long n)=>o[key]=o[key]!.GetValue<long>()+n;Add("net_taxable_value",taxable);if(taxable<0)Add("returned_value",-taxable);Add("sub_orders",r.N);if(r.Inter)Add("igst_tcs",r.Tcs);else{Add("cgst_tcs",r.Tcs/2);Add("sgst_tcs",r.Tcs-r.Tcs/2);}}
        var totals=new JsonObject();foreach(var key in new[]{"net_taxable_value","igst_tcs","cgst_tcs","sgst_tcs"})totals[key]=by.Values.Sum(x=>x[key]!.GetValue<long>());return new(){["month"]=month,["tcs_rate_bps"]=(await settings.GetAsync())["tcs_bps"]!.DeepClone(),["note"]="Basis for GSTR-8 (due by the 10th of the next month): packages placed in the month, less returns received in the month. Verify with your CA before filing.",["items"]=new JsonArray(by.Values.Select(x=>(JsonNode)x).ToArray()),["totals"]=totals};
    }
}
