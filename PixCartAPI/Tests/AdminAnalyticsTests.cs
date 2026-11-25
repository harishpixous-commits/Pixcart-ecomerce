using DAL;
using Microsoft.Extensions.DependencyInjection;
using Utils.Interface;
namespace Tests;
public class AdminAnalyticsTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Analytics_IST_periods_cancelled_packages_distinct_orders_repeat_buyers_and_series()
    {
        var admin=await Admin();var user=await LoginPhone("9890000098");
        Assert.Equal(403,(await user.Get("/api/admin/analytics")).Status);
        Assert.Equal(422,(await admin.Get("/api/admin/analytics?days=6")).Status);
        Assert.Equal(422,(await admin.Get("/api/admin/analytics?days=366")).Status);var r=await admin.Get("/api/admin/analytics?days=7");
        Assert.True(r.Status==200,r.ToString());
        Assert.Equal(28,r.Json.AsObject().Count);
        Assert.Equal(7,r.Json["series"]!.AsArray().Count);
        Assert.Equal(0,r.Json["gmv"]!.GetValue<long>());
        Assert.Null(r.Json["avg_hours_to_ship"]);var seller=(await user.Post("/api/seller/register",new{display_name="Synthetic Analytics Store"})).Json["id"]!.GetValue<string>();
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var orders=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var today=DateTime.UtcNow.AddMinutes(330).Date.AddMinutes(-330);var start=today.AddDays(-6);var ids=new List<Guid>();await using(var tx=await db.BeginAsync())
        {
            for(var i=0;i<4;i++){var id=Guid.NewGuid();ids.Add(id);await orders.InsertOrderAsync(new(){Id=id,Number="SYNTH-AN-"+i,UserId=Guid.Parse(user.Id),Status="placed",PaymentMethod=i==1?"online":"cod",PaymentStatus="paid",ShipTo="{}",ItemsTotal=10000,GrandTotal=10000,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),PlacedAt=i==0?start:i==1?start.AddDays(-1):i==2?today:today.AddDays(1),CreatedAt=today,UpdatedAt=today},tx);}
            for(var i=0;i<5;i++)await orders.InsertSubOrderAsync(new(){Id=Guid.NewGuid(),OrderId=i==4?ids[0]:ids[i%4],SellerId=Guid.Parse(seller),Number="SYNTH-AN-SUB-"+i,Status=i==2?"cancelled":i==3?"pending_payment":"delivered",ItemsTotal=i==4?5100:10100,Total=i==4?5000:10000,CommissionPaise=500,ReturnedTotal=i==2?200:0,PlatformDiscount=50,SellerDiscount=100,SettlementStatus="pending",CreatedAt=i==1?start.AddSeconds(-1):i==0?start:i==4?today:today,DeliveredAt=today,ShippedAt=i==0?start.AddHours(2):null,UpdatedAt=today},tx);
            await tx.CommitAsync();
        }
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET returned_total=200 WHERE number='SYNTH-AN-SUB-2'");
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET shipped_at=DATE_ADD(created_at,INTERVAL 2 HOUR),delivered_at=@today WHERE number='SYNTH-AN-SUB-0'",new{today});
        var cat=Guid.NewGuid();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Synthetic Analytics','synthetic-analytics','',500,500,0,1,'[]')",new{cat});var product=await user.Post("/api/seller/products",new{category_id=cat,title="Synthetic Analytics Product",hsn_code="6205",gst_bps=500,variants=new[]{new{sku="ANALYTICS-SKU",mrp_paise=20000,price_paise=10000,stock=5}}});Assert.True(product.Status==201,product.ToString());var pid=Guid.Parse(product.Json["id"]!.GetValue<string>());var variant=await ApiFactory.DbScalarAsync<Guid>("SELECT id FROM variants WHERE product_id=@pid",new{pid});var sub=await ApiFactory.DbScalarAsync<Guid>("SELECT id FROM sub_orders WHERE number='SYNTH-AN-SUB-0'");await using(var tx=await db.BeginAsync()){await orders.InsertOrderItemAsync(new(){Id=Guid.NewGuid(),SubOrderId=sub,ProductId=pid,VariantId=variant,Title="Synthetic Analytics Product",Qty=2,UnitPrice=5000,UnitMrp=10000,LineTotal=10000,SellerDiscount=100,TaxableValue=9900},tx);await tx.CommitAsync();}await ApiFactory.DbExecAsync("INSERT INTO product_daily_stats(product_id,day,views,add_to_cart,orders,units,revenue)VALUES(@pid,@day,1,5,0,0,0)",new{pid,day=today.AddMinutes(330).ToString("yyyy-MM-dd")});
        r=await admin.Get("/api/admin/analytics?days=7");
        Assert.True(r.Status==200,r.ToString());
        Assert.Equal(2,r.Json["units"]!.GetValue<long>());Assert.Equal(100,r.Json["conversion_rate"]!.GetValue<double>());Assert.Equal(100,r.Json["cart_rate"]!.GetValue<double>());Assert.Equal(5,r.Json["add_to_cart"]!.GetValue<long>());Assert.Equal(9900,r.Json["top_products"]![0]!["revenue"]!.GetValue<long>());Assert.Equal("Synthetic Analytics",r.Json["top_categories"]![0]!["name"]!.GetValue<string>());Assert.Equal(9900,r.Json["top_categories"]![0]!["gmv"]!.GetValue<long>());
        Assert.Equal(15000,r.Json["gmv"]!.GetValue<long>());
        Assert.Equal(10000,r.Json["gmv_prev"]!.GetValue<long>());
        Assert.Equal(2,r.Json["orders"]!.GetValue<long>());
        Assert.Equal(1,r.Json["orders_prev"]!.GetValue<long>());
        Assert.Equal(7500,r.Json["aov"]!.GetValue<long>());
        Assert.Equal(1000,r.Json["commission"]!.GetValue<long>());
        Assert.Equal(300,r.Json["discounts"]!.GetValue<long>());
        Assert.Equal(33.3,r.Json["cancellation_rate"]!.GetValue<double>());
        Assert.Equal(200,r.Json["returned_value"]!.GetValue<long>());
        Assert.Equal(2,r.Json["avg_hours_to_ship"]!.GetValue<double>());
        Assert.Equal(1,r.Json["buyers"]!.GetValue<long>());
        Assert.Equal(100,r.Json["repeat_buyer_rate"]!.GetValue<double>());
        Assert.Equal(2,r.Json["payment_mix"]!["cod"]!.GetValue<long>());
        Assert.Equal(15000,r.Json["top_sellers"]![0]!["gmv"]!.GetValue<long>());
        Assert.Equal(7,r.Json["series"]!.AsArray().Count);
        Assert.Equal(10000,r.Json["series"]![0]!["gmv"]!.GetValue<long>());
        Assert.Equal(5000,r.Json["series"]![6]!["gmv"]!.GetValue<long>());
        Assert.Equal(start.AddMinutes(330).ToString("yyyy-MM-dd"),r.Json["from"]!.GetValue<string>());
    }
}
