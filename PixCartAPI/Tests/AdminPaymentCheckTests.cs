using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Utils.Interface;
namespace Tests;
public class AdminPaymentCheckTests(ApiFactory f):ApiTest(f)
{
    private sealed class Queue:IRefundQueue{public List<Guid> Ids=[];public void Enqueue(IEnumerable<Guid> ids)=>Ids.AddRange(ids);}
    private sealed class Gateway:IRazorpayBAL
    {
        public string Mode="empty";public int Calls;public int Captures;
        public Task<bool> OnlinePaymentsAsync()=>Task.FromResult(true);
        public Task<JsonObject> CreateOrderAsync(long a,string r,IReadOnlyDictionary<string,string> n,string c="INR")=>throw new InvalidOperationException("Unexpected mock call");
        public Task<JsonObject> CreateCustomerAsync(string n,string c,string e)=>throw new InvalidOperationException("Unexpected mock call");
        public Task<JsonObject> RefundPaymentAsync(string p,long a,string r,IReadOnlyDictionary<string,string> n)=>throw new InvalidOperationException("Refund worker must stay off");
        public Task<bool> VerifyPaymentSignatureAsync(string a,string b,string c)=>throw new InvalidOperationException("Unexpected mock call");
        public Task<bool> VerifyWebhookSignatureAsync(byte[] b,string s)=>throw new InvalidOperationException("Unexpected mock call");
        private JsonObject Payment(string status)=>new(){["id"]="pay_SYNTH_ADMIN",["order_id"]="order_SYNTH_ADMIN",["status"]=status,["method"]="upi",["amount"]=Mode=="mismatch"?9999L:10000L,["created_at"]=1L};
        public Task<IReadOnlyList<JsonObject>> OrderPaymentsAsync(string id){Calls++;if(Mode=="error")throw new RazorpayBAL.GatewayException("Synthetic unavailable");return Task.FromResult<IReadOnlyList<JsonObject>>(Mode switch{"empty"=>[],"failed"=>[new(){["id"]="pay_failed",["status"]="failed",["error_description"]="Synthetic declined"}],"waiting"=>[new(){["id"]="pay_wait",["status"]="created"}],_=>[Payment(Mode=="authorized"?"authorized":"captured")]});}
        public Task<JsonObject> FetchPaymentAsync(string id){Calls++;return Task.FromResult(Payment(Mode=="authorized"?"authorized":"captured"));}
        public Task<JsonObject> CapturePaymentAsync(string id,long amount,string currency="INR"){Calls++;Captures++;return Task.FromResult(Payment("captured"));}
    }
    [Fact]public async Task Admin_payment_check_mock_only_capture_errors_idempotency_audit_rollback_and_refund_queue()
    {
        var admin=await Admin();var buyer=await LoginPhone("9890000093");using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var orders=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var oid=Guid.NewGuid();var pid=Guid.NewGuid();await using(var tx=await db.BeginAsync()){await orders.InsertOrderAsync(new(){Id=oid,Number="SYNTH-ADMIN-CHECK",UserId=Guid.Parse(buyer.Id),Status="pending_payment",PaymentMethod="online",PaymentStatus="pending",ShipTo="{}",ItemsTotal=10000,GrandTotal=10000,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=DateTime.UtcNow,UpdatedAt=DateTime.UtcNow},tx);await tx.ExecuteAsync("INSERT INTO payments(id,order_id,provider,provider_order_id,amount_paise,currency,status,method,error)VALUES(@pid,@oid,'razorpay','order_SYNTH_ADMIN',10000,'INR','created','','')",new{pid,oid});await tx.CommitAsync();}
        var gateway=new Gateway();var queue=new Queue();using var isolated=Factory.WithWebHostBuilder(b=>b.ConfigureTestServices(s=>{s.RemoveAll<IRazorpayBAL>();s.AddSingleton<IRazorpayBAL>(gateway);foreach(var d in s.Where(d=>d.ServiceType==typeof(IHostedService)&&d.ImplementationType==typeof(API.Infrastructure.RefundWorker)).ToList())s.Remove(d);s.RemoveAll<IRefundQueue>();s.AddSingleton<IRefundQueue>(queue);}));using var client=isolated.CreateClient();client.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",admin.Token);
        async Task<(int Status,JsonNode Json)> Check(Guid? id=null){var response=await client.PostAsync("/api/admin/orders/"+(id??oid)+"/check-payment",new StringContent("{}",System.Text.Encoding.UTF8,"application/json"));return ((int)response.StatusCode,JsonNode.Parse(await response.Content.ReadAsStringAsync())!);}
        Assert.Equal(403,(await buyer.Post("/api/admin/orders/"+oid+"/check-payment")).Status);var r=await Check(Guid.NewGuid());Assert.Equal("no_online_payment",r.Json["error"]!["code"]!.GetValue<string>());Assert.Equal(0,gateway.Calls);
        r=await Check();Assert.Equal("not_paid",r.Json["result"]!.GetValue<string>());gateway.Mode="waiting";r=await Check();Assert.True(r.Json["waiting"]!.GetValue<bool>());gateway.Mode="failed";r=await Check();Assert.Equal("Synthetic declined",r.Json["reason"]!.GetValue<string>());Assert.Equal("Synthetic declined",await ApiFactory.DbScalarAsync<string>("SELECT error FROM payments WHERE id=@pid",new{pid}));
        gateway.Mode="error";r=await Check();Assert.Equal(502,r.Status);Assert.Equal("gateway_error",r.Json["error"]!["code"]!.GetValue<string>());gateway.Mode="mismatch";r=await Check();Assert.Equal("amount_mismatch",r.Json["error"]!["code"]!.GetValue<string>());Assert.Equal("created",await ApiFactory.DbScalarAsync<string>("SELECT status FROM payments WHERE id=@pid",new{pid}));
        gateway.Mode="captured";await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_paycheck_fail BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='payment.check' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic paycheck rollback'; END IF; END");try{r=await Check();Assert.Equal(500,r.Status);Assert.Equal("pending_payment",await ApiFactory.DbScalarAsync<string>("SELECT status FROM orders WHERE id=@oid",new{oid}));Assert.Equal("created",await ApiFactory.DbScalarAsync<string>("SELECT status FROM payments WHERE id=@pid",new{pid}));}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_paycheck_fail");}
        gateway.Mode="authorized";r=await Check();Assert.Equal(200,r.Status);Assert.Equal("paid",r.Json["result"]!.GetValue<string>());Assert.Equal(1,gateway.Captures);Assert.Equal("paid",await ApiFactory.DbScalarAsync<string>("SELECT payment_status FROM orders WHERE id=@oid",new{oid}));var calls=gateway.Calls;var audits=await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM audit_logs WHERE action='payment.check'");r=await Check();Assert.Equal("already_paid",r.Json["result"]!.GetValue<string>());Assert.Equal(calls,gateway.Calls);Assert.Equal(audits,await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM audit_logs WHERE action='payment.check'"));
        await ApiFactory.DbExecAsync("UPDATE orders SET status='cancelled' WHERE id=@oid; UPDATE payments SET status='created',provider_payment_id=NULL WHERE id=@pid",new{oid,pid});gateway.Mode="captured";r=await Check();Assert.Equal("refund",r.Json["result"]!.GetValue<string>());Assert.Single(queue.Ids);Assert.Equal(0,await ApiFactory.DbScalarAsync<int>("SELECT attempts FROM refunds WHERE id=@rid",new{rid=queue.Ids[0]}));Assert.Equal(1,gateway.Captures);
    }
}
