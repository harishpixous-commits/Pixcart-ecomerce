using System.Text;
using System.Text.Json;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;
using BAL.Interface;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
namespace Tests;
public class PaymentWebhookTests(ApiFactory f):ApiTest(f)
{
    private Task<Res> Send(object evt,string? eid=null,bool valid=true)
    {
        var bytes=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(evt));var headers=new Dictionary<string,string>{["x-razorpay-signature"]=valid?EncryptDecrypt.HmacSha256Hex("whsec_test",bytes):"wrong"};if(eid is not null)headers["x-razorpay-event-id"]=eid;
        return Factory.Browser().Post("/api/payments/razorpay/webhook",new ByteArrayContent(bytes),headers:headers);
    }
    [Fact]
    public async Task Signed_capture_failure_dedup_and_amount_mismatch_rollback_are_local()
    {
        var u=await LoginPhone("9898000001","Synthetic Webhook Shopper");var oid=Guid.NewGuid();var pid=Guid.NewGuid();
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var dal=scope.ServiceProvider.GetRequiredService<OrdersDAL>();await using(var tx=await db.BeginAsync())
        {
            await dal.InsertOrderAsync(new(){Id=oid,Number="SYNTH-WEBHOOK",UserId=Guid.Parse(u.Id),Status="pending_payment",PaymentMethod="online",PaymentStatus="pending",ShipTo="{}",ItemsTotal=10000,GrandTotal=10000,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);
            await tx.ExecuteAsync("INSERT INTO payments(id,order_id,provider,provider_order_id,amount_paise,currency,status,method,error)VALUES(@pid,@oid,'razorpay','order_SYNTH_WEBHOOK',10000,'INR','created','','')",new{pid,oid});await tx.CommitAsync();
        }
        object Capture(long amount)=>new{ @event="payment.captured",payload=new{payment=new{entity=new{id="pay_SYNTH_WEBHOOK",order_id="order_SYNTH_WEBHOOK",status="captured",method="upi",amount}}}};
        var r=await Send(Capture(10000),"bad-sign",false);Assert.Equal("bad_signature",r.ErrorCode);Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM webhook_events WHERE provider='razorpay'"));
        r=await Send(Capture(9999),"mismatch");Assert.Equal("amount_mismatch",r.ErrorCode);Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM webhook_events WHERE event_id='mismatch'"));
        r=await Send(new{@event="payment.failed",payload=new{payment=new{entity=new{order_id="order_SYNTH_WEBHOOK",error_description="Synthetic failure"}}}},"failed");Assert.Equal(200,r.Status);Assert.Equal("created",await ApiFactory.DbScalarAsync<string>("SELECT status FROM payments WHERE id=@pid",new{pid}));Assert.Equal("Synthetic failure",await ApiFactory.DbScalarAsync<string>("SELECT error FROM payments WHERE id=@pid",new{pid}));
        r=await Send(Capture(10000),"captured");Assert.True(r.Status==200,r.ToString());Assert.Equal("captured",await ApiFactory.DbScalarAsync<string>("SELECT status FROM payments WHERE id=@pid",new{pid}));Assert.Equal("paid",await ApiFactory.DbScalarAsync<string>("SELECT payment_status FROM orders WHERE id=@oid",new{oid}));
        r=await Send(Capture(10000),"captured");Assert.True(r.Json["duplicate"]!.GetValue<bool>());
        var unknown=new{@event="unknown.synthetic",payload=new{}};r=await Send(unknown);Assert.Equal(200,r.Status);Assert.True((await Send(unknown)).Json["duplicate"]!.GetValue<bool>());
    }

    private sealed class RecordingQueue:IRefundQueue {public List<Guid> Ids=[];public void Enqueue(IEnumerable<Guid> ids)=>Ids.AddRange(ids);}
    [Fact]public async Task Duplicate_charge_queue_and_refund_status_events_never_run_worker()
    {
        var u=await LoginPhone("9898000002","Synthetic Refund Shopper");var oid=Guid.NewGuid();var pid=Guid.NewGuid();
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var dal=scope.ServiceProvider.GetRequiredService<OrdersDAL>();await using(var tx=await db.BeginAsync())
        {
            await dal.InsertOrderAsync(new(){Id=oid,Number="SYNTH-REFUND",UserId=Guid.Parse(u.Id),Status="placed",PaymentMethod="online",PaymentStatus="paid",ShipTo="{}",ItemsTotal=10000,GrandTotal=10000,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);
            await tx.ExecuteAsync("INSERT INTO payments(id,order_id,provider,provider_order_id,provider_payment_id,amount_paise,currency,status,method,error)VALUES(@pid,@oid,'razorpay','order_SYNTH_REFUND','pay_ORIGINAL',10000,'INR','captured','upi','')",new{pid,oid});await tx.CommitAsync();
        }
        var queue=new RecordingQueue();using var isolated=Factory.WithWebHostBuilder(b=>b.ConfigureTestServices(services=>
        {
            foreach(var d in services.Where(d=>d.ServiceType==typeof(IHostedService)&&d.ImplementationType==typeof(API.Infrastructure.RefundWorker)).ToList())services.Remove(d);
            services.RemoveAll<IRefundQueue>();services.AddSingleton<IRefundQueue>(queue);
        }));
        using var client=isolated.CreateClient();
        async Task<System.Text.Json.Nodes.JsonNode> Post(object evt,string eid)
        {
            var bytes=Encoding.UTF8.GetBytes(JsonSerializer.Serialize(evt));using var req=new HttpRequestMessage(HttpMethod.Post,"/api/payments/razorpay/webhook"){Content=new ByteArrayContent(bytes)};req.Headers.Add("x-razorpay-signature",EncryptDecrypt.HmacSha256Hex("whsec_test",bytes));req.Headers.Add("x-razorpay-event-id",eid);var response=await client.SendAsync(req);var text=await response.Content.ReadAsStringAsync();Assert.True(response.IsSuccessStatusCode,text);return System.Text.Json.Nodes.JsonNode.Parse(text)!;
        }
        var capture=new{@event="payment.captured",payload=new{payment=new{entity=new{id="pay_DUPLICATE",order_id="order_SYNTH_REFUND",status="captured",method="upi",amount=10000}}}};
        await Post(capture,"duplicate-charge");Assert.Single(queue.Ids);var rid=queue.Ids[0];Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT attempts FROM refunds WHERE id=@rid",new{rid}));Assert.True((await Post(capture,"duplicate-charge"))["duplicate"]!.GetValue<bool>());Assert.Single(queue.Ids);
        await ApiFactory.DbExecAsync("UPDATE refunds SET provider_refund_id='rfnd_SYNTHETIC' WHERE id=@rid",new{rid});
        object Refund(string type)=>new{@event=type,payload=new{refund=new{entity=new{id="rfnd_SYNTHETIC"}}}};
        await Post(Refund("refund.failed"),"refund-failed");Assert.Equal("failed",await ApiFactory.DbScalarAsync<string>("SELECT status FROM refunds WHERE id=@rid",new{rid}));Assert.Equal("Gateway reported the refund failed",await ApiFactory.DbScalarAsync<string>("SELECT last_error FROM refunds WHERE id=@rid",new{rid}));
        await Post(Refund("refund.processed"),"refund-processed");Assert.Equal("processed",await ApiFactory.DbScalarAsync<string>("SELECT status FROM refunds WHERE id=@rid",new{rid}));Assert.Equal("",await ApiFactory.DbScalarAsync<string>("SELECT last_error FROM refunds WHERE id=@rid",new{rid}));
        var count=await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE event='refund_processed'");await Post(Refund("refund.processed"),"refund-processed-again");Assert.Equal(count,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE event='refund_processed'"));Assert.Equal(1,count);Assert.Single(queue.Ids);
    }
}
