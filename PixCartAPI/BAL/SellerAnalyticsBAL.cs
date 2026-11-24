using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
namespace BAL;
public partial interface ISellerHubBAL { Task<JsonObject> AnalyticsAsync(SellerModel seller,int days); }
public partial class SellerHubBAL
{
    private sealed class Period {public long Orders{get;set;}public long Packages{get;set;}public long Gmv{get;set;}public long Cancelled{get;set;}public long Commission{get;set;}public long Returned{get;set;}public long Discounts{get;set;}}
    private sealed class Stats {public long Views{get;set;}public long Carts{get;set;}}
    private sealed class Daily {public string Day{get;set;}="";public long Orders{get;set;}public long Gmv{get;set;}}
    private sealed class TopProduct {public Guid ProductId{get;set;}public string Title{get;set;}="";public long Units{get;set;}public long Revenue{get;set;}}
    private sealed class Performance {public Guid Id{get;set;}public string Title{get;set;}="";public string Slug{get;set;}="";public long Price{get;set;}public bool InStock{get;set;}public long Views{get;set;}public long Carts{get;set;}public long Orders{get;set;}public long Units{get;set;}public long Revenue{get;set;}}
    private static double Pct(long a,long b)=>b==0?0:Math.Round(a*100.0/b,1,MidpointRounding.ToEven);
    public async Task<JsonObject> AnalyticsAsync(SellerModel s,int days)
    {
        var endDay=DateOnly.FromDateTime(DateTime.UtcNow.AddHours(5.5));var startDay=endDay.AddDays(1-days);
        var start=DateTime.SpecifyKind(startDay.ToDateTime(TimeOnly.MinValue).AddHours(-5.5),DateTimeKind.Utc);var end=start.AddDays(days);
        const string filter="seller_id=@sid AND status<>'pending_payment'";
        async Task<Period> ReadPeriod(DateTime a,DateTime b)=> (await db.QueryFirstOrDefaultAsync<Period>("SELECT COUNT(DISTINCT order_id) AS orders,COUNT(*) AS packages,COALESCE(SUM(IF(status<>'cancelled',total,0)),0) AS gmv,COALESCE(SUM(status='cancelled'),0) AS cancelled,COALESCE(SUM(IF(status<>'cancelled',commission_paise,0)),0) AS commission,COALESCE(SUM(returned_total),0) AS returned,COALESCE(SUM(IF(status<>'cancelled',platform_discount+seller_discount,0)),0) AS discounts FROM sub_orders WHERE "+filter+" AND created_at>=@a AND created_at<@b",new{sid=s.Id,a,b}))!;
        var current=await ReadPeriod(start,end);var previous=await ReadPeriod(start.AddDays(-days),start);var args=new{sid=s.Id,start,end,startDay=startDay.ToString("yyyy-MM-dd"),endDay=endDay.ToString("yyyy-MM-dd")};
        var units=await db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(i.qty),0) FROM order_items i JOIN sub_orders p ON p.id=i.sub_order_id WHERE p.seller_id=@sid AND p.status NOT IN ('pending_payment','cancelled') AND p.created_at>=@start AND p.created_at<@end",args);
        var returns=await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM return_requests WHERE seller_id=@sid AND created_at>=@start AND created_at<@end",args);
        var delivered=await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sub_orders WHERE "+filter+" AND status='delivered' AND delivered_at>=@start AND delivered_at<@end",args);
        var ship=await db.ExecuteScalarAsync<double?>("SELECT AVG(TIMESTAMPDIFF(MICROSECOND,created_at,shipped_at)/3600000000.0) FROM sub_orders WHERE "+filter+" AND shipped_at>=@start AND shipped_at<@end",args);
        var stats=(await db.QueryFirstOrDefaultAsync<Stats>("SELECT COALESCE(SUM(d.views),0) AS views,COALESCE(SUM(d.add_to_cart),0) AS carts FROM product_daily_stats d JOIN products p ON p.id=d.product_id WHERE p.seller_id=@sid AND d.day>=@startDay AND d.day<=@endDay",args))!;
        var daily=(await db.QueryAsync<Daily>("SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 330 MINUTE),'%Y-%m-%d') AS day,COUNT(DISTINCT order_id) AS orders,COALESCE(SUM(IF(status<>'cancelled',total,0)),0) AS gmv FROM sub_orders WHERE "+filter+" AND created_at>=@start AND created_at<@end GROUP BY day ORDER BY day",args)).ToDictionary(d=>d.Day);
        var tops=await db.QueryAsync<TopProduct>("SELECT i.product_id,i.title,SUM(i.qty) AS units,SUM(i.line_total-i.seller_discount) AS revenue FROM order_items i JOIN sub_orders p ON p.id=i.sub_order_id WHERE p.seller_id=@sid AND p.status NOT IN ('pending_payment','cancelled') AND p.created_at>=@start AND p.created_at<@end GROUP BY i.product_id,i.title ORDER BY SUM(i.line_total) DESC LIMIT 10",args);
        var products=await db.QueryAsync<Performance>("SELECT p.id,p.title,p.slug,p.price_from AS price,p.in_stock,COALESCE(SUM(d.views),0) AS views,COALESCE(SUM(d.add_to_cart),0) AS carts,COALESCE(SUM(d.orders),0) AS orders,COALESCE(SUM(d.units),0) AS units,COALESCE(SUM(d.revenue),0) AS revenue FROM products p LEFT JOIN product_daily_stats d ON d.product_id=p.id AND d.day>=@startDay AND d.day<=@endDay WHERE p.seller_id=@sid AND p.status='approved' GROUP BY p.id ORDER BY revenue DESC LIMIT 100",args);
        var series=new JsonArray();for(var i=0;i<days;i++){var date=startDay.AddDays(i).ToString("yyyy-MM-dd");var d=daily.GetValueOrDefault(date);series.Add(new JsonObject{["date"]=date,["orders"]=d?.Orders??0,["gmv"]=d?.Gmv??0});}
        return new JsonObject{["days"]=days,["from"]=startDay.ToString("yyyy-MM-dd"),["to"]=endDay.ToString("yyyy-MM-dd"),["gmv"]=current.Gmv,["gmv_prev"]=previous.Gmv,["orders"]=current.Orders,["orders_prev"]=previous.Orders,["aov"]=current.Orders>0?current.Gmv/current.Orders:0,["units"]=units,["commission"]=current.Commission,["discounts"]=current.Discounts,["cancellation_rate"]=Pct(current.Cancelled,current.Packages),["return_rate"]=Pct(returns,delivered),["returned_value"]=current.Returned,["avg_hours_to_ship"]=ship is {} h&&h!=0?Math.Round(h,1,MidpointRounding.ToEven):null,["views"]=stats.Views,["add_to_cart"]=stats.Carts,["conversion_rate"]=Pct(Math.Min(current.Orders,stats.Views),stats.Views),["cart_rate"]=Pct(Math.Min(stats.Carts,stats.Views),stats.Views),["series"]=series,["top_products"]=new JsonArray(tops.Select(p=>(JsonNode)new JsonObject{["product_id"]=p.ProductId.ToString(),["title"]=p.Title,["units"]=p.Units,["revenue"]=p.Revenue}).ToArray()),["products"]=new JsonArray(products.Select(p=>(JsonNode)new JsonObject{["id"]=p.Id.ToString(),["title"]=p.Title,["slug"]=p.Slug,["price"]=p.Price,["in_stock"]=p.InStock,["views"]=p.Views,["add_to_cart"]=p.Carts,["orders"]=p.Orders,["units"]=p.Units,["revenue"]=p.Revenue,["conversion"]=Pct(p.Orders,p.Views)}).ToArray())};
    }
}
