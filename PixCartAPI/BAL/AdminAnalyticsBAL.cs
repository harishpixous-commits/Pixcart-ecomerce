using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
namespace BAL;
public class AdminAnalyticsBAL(AiDAL data,IAccessBAL access):IAdminAnalyticsBAL
{
    private static double Pct(long a,long b)=>b==0?0:Math.Round(a*100.0/b,1,MidpointRounding.ToEven);
    public async Task<JsonObject> ReadAsync(UserModel user,int days)
    {
        await access.RequireAsync(user,"dashboard");var endDay=DateOnly.FromDateTime(DateTime.UtcNow.AddMinutes(330));var startDay=endDay.AddDays(1-days);var start=startDay.ToDateTime(TimeOnly.MinValue).AddMinutes(-330);var end=endDay.AddDays(1).ToDateTime(TimeOnly.MinValue).AddMinutes(-330);
        var current=await data.KpiPeriodAsync(start,end);var previous=await data.KpiPeriodAsync(start.AddDays(-days),start);var units=await data.KpiUnitsAsync(start,end);var returned=await data.KpiReturnsCountAsync(start,end);var delivered=await data.KpiDeliveredAsync(start,end);var ship=await data.KpiShipHoursAsync(start,end);var(views,carts)=await data.KpiViewsCartsAsync(startDay,endDay);var daily=(await data.KpiDailyAsync(start,end)).ToDictionary(x=>DateOnly.FromDateTime(x.D));var products=await data.KpiTopProductsAsync(start,end);var customers=await data.KpiNewCustomersAsync(start,end);var(repeat,buyers)=await data.KpiRepeatBuyersAsync(start,end);var sellers=await data.KpiTopSellersAsync(start,end);var categories=await data.KpiTopCategoriesAsync(start,end);var mix=await data.KpiPayMixAsync(start,end);var overdue=await data.KpiOverdueTicketsAsync();
        var series=new JsonArray();for(var i=0;i<days;i++){var date=startDay.AddDays(i);var d=daily.GetValueOrDefault(date);series.Add(new JsonObject{["date"]=date.ToString("yyyy-MM-dd"),["orders"]=d?.Orders??0,["gmv"]=d?.Gmv??0});}
        return new(){["days"]=days,["from"]=startDay.ToString("yyyy-MM-dd"),["to"]=endDay.ToString("yyyy-MM-dd"),["gmv"]=current.Gmv,["gmv_prev"]=previous.Gmv,["orders"]=current.Orders,["orders_prev"]=previous.Orders,["aov"]=current.Orders>0?current.Gmv/current.Orders:0,["units"]=units,["commission"]=current.Commission,["discounts"]=current.Discounts,["cancellation_rate"]=Pct(current.Cancelled,current.Packages),["return_rate"]=Pct(returned,delivered),["returned_value"]=current.Returned,["avg_hours_to_ship"]=ship is {} h&&h!=0?Math.Round(h,1,MidpointRounding.ToEven):null,["views"]=views,["add_to_cart"]=carts,["conversion_rate"]=Pct(Math.Min(current.Orders,views),views),["cart_rate"]=Pct(Math.Min(carts,views),views),["series"]=series,["top_products"]=new JsonArray(products.Select(p=>(JsonNode)new JsonObject{["product_id"]=p.ProductId.ToString(),["title"]=p.Title,["units"]=p.Units,["revenue"]=p.Revenue}).ToArray()),["new_customers"]=customers,["buyers"]=buyers,["repeat_buyer_rate"]=Pct(repeat,buyers),["top_sellers"]=new JsonArray(sellers.Select(s=>(JsonNode)new JsonObject{["name"]=s.Name,["packages"]=s.Packages,["gmv"]=s.Gmv}).ToArray()),["top_categories"]=new JsonArray(categories.Select(c=>(JsonNode)new JsonObject{["name"]=c.Name,["gmv"]=c.Gmv}).ToArray()),["payment_mix"]=new JsonObject(mix.Select(m=>KeyValuePair.Create<string,JsonNode?>(m.Method,JsonValue.Create(m.C)))),["tickets_ack_overdue"]=overdue};
    }
}
