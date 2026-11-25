using System.Text.Json.Nodes;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils.Interface;
namespace Tests;
public class CustomerDeliveryTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Customer_delivery_feedback_proof_and_partner_earnings_history()
    {
        var u=await LoginPhone("9881000001","Synthetic Delivery Shopper");var s=(await u.Post("/api/seller/register",new{display_name="Synthetic Delivery Store"})).Json["id"]!.GetValue<string>();
        var oid=Guid.NewGuid();var sub=Guid.NewGuid();var boy=Guid.NewGuid();var assignment=Guid.NewGuid();
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var dal=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var delivery=scope.ServiceProvider.GetRequiredService<DeliveryDAL>();
        await delivery.InsertPartnerAsync(new(){Id=boy,UserId=Guid.Parse(u.Id),Name="Synthetic Partner",Phone="9881000001",VehicleType="bike",KycStatus="approved",BankDetails="{}",IsActive=true,CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow});
        await using(var tx=await db.BeginAsync())
        {
            await dal.InsertOrderAsync(new(){Id=oid,Number="SYNTH-DELIVERY",UserId=Guid.Parse(u.Id),Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{}",Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);
            await dal.InsertSubOrderAsync(new(){Id=sub,OrderId=oid,SellerId=Guid.Parse(s),Number="SYNTH-PACKAGE",Status="delivered",SettlementStatus="not_due",CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);
            await tx.ExecuteAsync("INSERT INTO delivery_assignments(id,order_id,sub_order_id,delivery_boy_id,mode,status,reject_reason,assigned_at,status_at,cod_amount,cod_collected,cod_method,proof_photo,fee_paise,fail_reason,rating_comment,created_at)VALUES(@assignment,@oid,@sub,@boy,'manual','delivered','',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),0,0,'','',0,'','',UTC_TIMESTAMP(6))",new{assignment,oid,sub,boy});await tx.CommitAsync();
        }
        var r=await u.Post($"/api/orders/{oid}/delivery-rating",new{sub_order_id=sub,rating=5,comment="  Very   good \n delivery  "});Assert.True(r.Status==200,r.ToString());Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT rating_count FROM delivery_boys WHERE id=@boy",new{boy}));
        r=await u.Post($"/api/orders/{oid}/delivery-rating",new{sub_order_id=sub,rating=3});Assert.Equal(200,r.Status);Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT rating_count FROM delivery_boys WHERE id=@boy",new{boy}));Assert.Equal(3,await ApiFactory.DbScalarAsync<decimal>("SELECT rating_avg FROM delivery_boys WHERE id=@boy",new{boy}));
        Assert.Equal(422,(await u.Post($"/api/orders/{oid}/delivery-rating",new{sub_order_id=sub,rating=6})).Status);Assert.Equal(404,(await u.Post($"/api/orders/{oid}/delivery-rating",new{sub_order_id=Guid.NewGuid(),rating=4})).Status);
        var other=await LoginPhone("9881000002");Assert.Equal(404,(await other.Post($"/api/orders/{oid}/delivery-rating",new{sub_order_id=sub,rating=4})).Status);Assert.Equal(404,(await other.Get($"/api/orders/{oid}/delivery-proof/{sub}")).Status);
        Assert.Equal(404,(await u.Get($"/api/orders/{oid}/delivery-proof/{sub}")).Status);
        var storage=scope.ServiceProvider.GetRequiredService<IImageUpload>();var bytes=System.Text.Encoding.ASCII.GetBytes("%PDF-1.4\nSynthetic delivery proof\n%%EOF");var(key,_)=await storage.SavePrivateAsync(bytes,"delivery-proof");await ApiFactory.DbExecAsync("UPDATE delivery_assignments SET proof_photo=@key WHERE id=@assignment",new{key,assignment});
        using var request=new HttpRequestMessage(HttpMethod.Get,$"/api/orders/{oid}/delivery-proof/{sub}");request.Headers.Authorization=new("Bearer",u.Token);using var client=Factory.CreateClient();var proof=await client.SendAsync(request);Assert.Equal(bytes,await proof.Content.ReadAsByteArrayAsync());Assert.True(proof.Headers.CacheControl!.Private);Assert.True(proof.Headers.CacheControl.NoStore);Assert.Equal("nosniff",proof.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("no_delivery",(await u.Post($"/api/orders/{oid}/delivery-complaint",new{sub_order_id=Guid.NewGuid(),category="late"})).ErrorCode);
        Assert.Equal(422,(await u.Post($"/api/orders/{oid}/delivery-complaint",new{sub_order_id=sub,category="unknown"})).Status);
        Assert.Equal(404,(await other.Post($"/api/orders/{oid}/delivery-complaint",new{sub_order_id=sub,category="late"})).Status);
        await ApiFactory.DbExecAsync("UPDATE delivery_assignments SET status='failed' WHERE id=@assignment",new{assignment});
        for(var i=0;i<10;i++){r=await u.Post($"/api/orders/{oid}/delivery-complaint",new{sub_order_id=sub,category="late",text="  Synthetic   complaint  "});Assert.True(r.Status==201,r.ToString());}
        Assert.Equal(429,(await u.Post($"/api/orders/{oid}/delivery-complaint",new{sub_order_id=sub,category="late"})).Status);Assert.Equal("Synthetic complaint",await ApiFactory.DbScalarAsync<string>("SELECT text FROM delivery_complaints LIMIT 1"));
        await ApiFactory.DbExecAsync("UPDATE delivery_assignments SET status='accepted' WHERE id=@assignment",new{assignment});Assert.Equal("not_delivered",(await u.Post($"/api/orders/{oid}/delivery-rating",new{sub_order_id=sub,rating=4})).ErrorCode);

        var today=DateOnly.FromDateTime(DateTime.UtcNow.AddHours(5.5));var start=DateTime.SpecifyKind(today.ToDateTime(TimeOnly.MinValue).AddHours(-5.5),DateTimeKind.Utc);
        await ApiFactory.DbExecAsync("UPDATE delivery_assignments SET status='delivered',assigned_at=@at,delivered_at=@at,fee_paise=100,tip_paise=20,bonus_paise=5,cod_collected=500,cod_method='cash' WHERE id=@assignment",new{at=start,assignment});
        for(var i=0;i<21;i++)await ApiFactory.DbExecAsync("INSERT INTO delivery_assignments(id,order_id,sub_order_id,delivery_boy_id,mode,status,reject_reason,assigned_at,delivered_at,status_at,cod_amount,cod_collected,cod_method,proof_photo,fee_paise,tip_paise,bonus_paise,fail_reason,rating_comment,created_at)VALUES(@id,@oid,@sub,@boy,'manual',@status,'',@at,@at,@at,0,0,'','',@fee,0,0,'','',@at)",new{id=Guid.NewGuid(),oid,sub,boy,status=i==0?"delivered":"failed",at=i==0?start.AddTicks(-10):start.AddMinutes(i+1),fee=i==0?200:999});
        await ApiFactory.DbExecAsync("INSERT INTO delivery_cash_deposits(id,delivery_boy_id,amount,method,reference,note,created_at)VALUES(@id,@boy,100,'cash','SYNTH-DEPOSIT','',UTC_TIMESTAMP(6))",new{id=Guid.NewGuid(),boy});
        r=await u.Get("/api/delivery/earnings");Assert.True(r.Status==200,r.ToString());Assert.Equal(125,r.Json["today"]!["earned"]!.GetValue<long>());Assert.Equal(325,r.Json["total"]!["earned"]!.GetValue<long>());Assert.Equal(325,r.Json["unpaid"]!.GetValue<long>());Assert.Equal(400,r.Json["cash_in_hand"]!.GetValue<long>());Assert.Equal(7,r.Json["days"]!.AsArray().Count);Assert.Equal(200,r.Json["days"]![5]!["earned"]!.GetValue<long>());Assert.Equal(125,r.Json["days"]![6]!["earned"]!.GetValue<long>());Assert.Single(r.Json["deposits"]!.AsArray());
        r=await u.Get("/api/delivery/history");Assert.Equal(22,r.Json["total"]!.GetValue<long>());Assert.Equal(20,r.Json["items"]!.AsArray().Count);Assert.Equal("SYNTH-PACKAGE",r.Json["items"]![0]!["order_number"]!.GetValue<string>());
        Assert.Equal(2,(await u.Get("/api/delivery/history?page=2")).Json["items"]!.AsArray().Count);Assert.Equal(20,(await u.Get("/api/delivery/history?status=failed")).Json["total"]!.GetValue<long>());Assert.Equal(21,(await u.Get($"/api/delivery/history?from={today:yyyy-MM-dd}&to={today:yyyy-MM-dd}")).Json["total"]!.GetValue<long>());
        Assert.Equal(422,(await u.Get("/api/delivery/history?page=0")).Status);Assert.Equal(422,(await u.Get("/api/delivery/history?status=accepted")).Status);Assert.Equal("not_registered",(await other.Get("/api/delivery/earnings")).ErrorCode);

        var payout=Guid.NewGuid();await ApiFactory.DbExecAsync("INSERT INTO delivery_payouts(id,delivery_boy_id,period_start,period_end,deliveries,amount,cod_deducted,net_amount,status,reference,created_at)VALUES(@payout,@boy,@start,@end,1,200,50,150,'pending','SYNTH-PAYOUT',UTC_TIMESTAMP(6))",new{payout,boy,start=today.AddDays(-7).ToDateTime(TimeOnly.MinValue),end=today.AddDays(-1).ToDateTime(TimeOnly.MinValue)});
        await ApiFactory.DbExecAsync("UPDATE delivery_assignments SET payout_id=@payout WHERE fee_paise=200",new{payout});
        r=await u.Get("/api/delivery/earnings");Assert.Equal(125,r.Json["unpaid"]!.GetValue<long>());Assert.Equal("SYNTH-PAYOUT",r.Json["payouts"]![0]!["reference"]!.GetValue<string>());Assert.Equal(150,r.Json["payouts"]![0]!["net_amount"]!.GetValue<long>());
        await ApiFactory.DbExecAsync("UPDATE orders SET ship_to=@ship WHERE id=@oid",new{ship="{\"city\":\"Synthetic City\",\"pincode\":\"641001\"}",oid});
        Assert.Equal("Synthetic City, 641001",(await u.Get("/api/delivery/history")).Json["items"]![0]!["drop_area"]!.GetValue<string>());
        await ApiFactory.DbExecAsync("UPDATE delivery_assignments SET status='accepted' WHERE id=@assignment",new{assignment});Assert.Equal(21,(await u.Get("/api/delivery/history")).Json["total"]!.GetValue<long>());
    }
}
