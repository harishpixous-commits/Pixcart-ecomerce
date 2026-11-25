using System.Text.Json.Nodes;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils.Interface;
namespace Tests;
public class SellerAnalyticsTests(ApiFactory f):ApiTest(f)
{
    [Fact]
    public async Task Empty_window_validation_and_synthetic_IST_period_metrics()
    {
        var u=await LoginPhone("9897000001","Synthetic Analytics Seller");var sid=Guid.Parse((await u.Post("/api/seller/register",new{display_name="Synthetic Analytics Store"})).Json["id"]!.GetValue<string>());
        var r=await u.Get("/api/seller/analytics?days=7");Assert.True(r.Status==200,r.ToString());Assert.Equal(7,r.Json["series"]!.AsArray().Count);Assert.Equal(0,r.Json["gmv"]!.GetValue<long>());Assert.Null(r.Json["avg_hours_to_ship"]);Assert.Empty(r.Json["products"]!.AsArray());Assert.Equal(422,(await u.Get("/api/seller/analytics?days=6")).Status);Assert.Equal(422,(await u.Get("/api/seller/analytics?days=366")).Status);
        var cat=Guid.NewGuid().ToString();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Synthetic Analytics','synthetic-analytics','',1000,500,0,1,'[]')",new{cat});
        var p=(await u.Post("/api/seller/products",new{category_id=cat,title="Synthetic Analytics Cotton Shirt",hsn_code="6205",gst_bps=500,variants=new[]{new{sku="ANALYTICS-SKU",mrp_paise=20000,price_paise=10000,stock=10}}})).Json;var pid=Guid.Parse(p["id"]!.GetValue<string>());var vid=Guid.Parse(p["variants"]![0]!["id"]!.GetValue<string>());await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@pid",new{pid});
        var endDay=DateOnly.FromDateTime(DateTime.UtcNow.AddHours(5.5));var start=DateTime.SpecifyKind(endDay.AddDays(-6).ToDateTime(TimeOnly.MinValue).AddHours(-5.5),DateTimeKind.Utc);
        using var scope=Factory.Services.CreateScope();var dal=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();await using(var tx=await db.BeginAsync())
        {
            var oid=Guid.NewGuid();await dal.InsertOrderAsync(new(){Id=oid,Number="SYNTH-ANALYTICS",UserId=Guid.Parse(u.Id),Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{}",ItemsTotal=10000,GrandTotal=10000,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=start,UpdatedAt=start},tx);
            var n=0;
            async Task Sub(string status,long total,DateTime at,long disc=0,bool withItem=false)
            {
                var id=Guid.NewGuid();n++;await dal.InsertSubOrderAsync(new(){Id=id,OrderId=oid,SellerId=sid,Number="SYNTH-SUB-"+n,Status=status,ItemsTotal=total+disc,Total=total,SellerDiscount=disc,CommissionPaise=total/10,SettlementStatus="not_due",CreatedAt=at,UpdatedAt=at},tx);
                if(status=="delivered")await tx.ExecuteAsync("UPDATE sub_orders SET shipped_at=DATE_ADD(created_at,INTERVAL 2 HOUR),delivered_at=DATE_ADD(created_at,INTERVAL 3 HOUR),returned_total=500 WHERE id=@id",new{id});
                if(withItem)await dal.InsertOrderItemAsync(new(){Id=Guid.NewGuid(),SubOrderId=id,ProductId=pid,VariantId=vid,Title="Synthetic historical title",Sku="ANALYTICS-SKU",HsnCode="6205",Qty=2,UnitPrice=5000,UnitMrp=10000,LineTotal=10000,SellerDiscount=1000,TaxableValue=9000},tx);
            }
            await Sub("delivered",9000,start.AddHours(1),1000,true);await Sub("placed",5000,start.AddDays(1));await Sub("cancelled",3000,start.AddDays(2));await Sub("pending_payment",7000,start.AddDays(3));await Sub("placed",2000,start.AddTicks(-10));
            await tx.ExecuteAsync("INSERT INTO product_daily_stats(product_id,day,views,add_to_cart,orders,units,revenue)VALUES(@pid,@day,1,3,2,4,18000)",new{pid,day=endDay.ToString("yyyy-MM-dd")});await tx.CommitAsync();
        }
        r=await u.Get("/api/seller/analytics?days=7");Assert.True(r.Status==200,r.ToString());Assert.Equal(14000,r.Json["gmv"]!.GetValue<long>());Assert.Equal(2000,r.Json["gmv_prev"]!.GetValue<long>());Assert.Equal(1,r.Json["orders"]!.GetValue<long>());Assert.Equal(1,r.Json["orders_prev"]!.GetValue<long>());Assert.Equal(14000,r.Json["aov"]!.GetValue<long>());Assert.Equal(2,r.Json["units"]!.GetValue<long>());Assert.Equal(1400,r.Json["commission"]!.GetValue<long>());Assert.Equal(1000,r.Json["discounts"]!.GetValue<long>());Assert.Equal(500,r.Json["returned_value"]!.GetValue<long>());Assert.Equal(33.3,r.Json["cancellation_rate"]!.GetValue<double>());Assert.Equal(2,r.Json["avg_hours_to_ship"]!.GetValue<double>());Assert.Equal(100,r.Json["conversion_rate"]!.GetValue<double>());Assert.Equal(100,r.Json["cart_rate"]!.GetValue<double>());Assert.Equal(9000,r.Json["top_products"]![0]!["revenue"]!.GetValue<long>());Assert.Equal(200,r.Json["products"]![0]!["conversion"]!.GetValue<double>());Assert.Equal(9000,r.Json["series"]![0]!["gmv"]!.GetValue<long>());
        var other=await LoginPhone("9897000002");await other.Post("/api/seller/register",new{display_name="Other Analytics Store"});r=await other.Get("/api/seller/analytics?days=7");Assert.Equal(0,r.Json["gmv"]!.GetValue<long>());Assert.Empty(r.Json["products"]!.AsArray());Assert.Empty(r.Json["top_products"]!.AsArray());
    }
}
