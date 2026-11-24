using System.Text.Json.Nodes;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils.Interface;
namespace Tests;
public class CustomerDeliveryTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Customer_delivery_rating_revision_complaint_rate_and_private_proof()
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
    }
}
