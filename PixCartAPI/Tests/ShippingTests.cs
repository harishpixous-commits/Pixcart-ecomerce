using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace Tests;
public class ShippingTests(ApiFactory f):ApiTest(f)
{
    private sealed class Handler(List<(string Path,JsonObject Body)> calls,string? failure=null):HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            Assert.True(System.Net.IPAddress.IsLoopback(System.Net.IPAddress.Parse(request.RequestUri!.Host)));var path=request.RequestUri.AbsolutePath;var body=JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();calls.Add((path,body));
            if(failure=="malformed"&&path=="/auth/login")return new(HttpStatusCode.OK){Content=new StringContent("not json")};
            if(failure=="missing-token"&&path=="/auth/login")return new(HttpStatusCode.OK){Content=new StringContent("{}")};
            if(path==failure)return new(HttpStatusCode.BadRequest){Content=new StringContent("{\"message\":\"Synthetic failure\"}")};
            if(path!="/auth/login")Assert.Equal("Bearer",request.Headers.Authorization?.Scheme);
            var json=path switch{"/auth/login"=>"{\"token\":\"synthetic-only\"}","/orders/create/adhoc"=>"{\"order_id\":123,\"shipment_id\":456}","/courier/assign/awb"=>"{\"response\":{\"data\":{\"awb_code\":\"SYNTH123\",\"courier_name\":\"Synthetic Courier\"}}}","/courier/generate/label"=>"{\"label_url\":\"https://example.test/synthetic-label\"}",_=>"{}"};return new(HttpStatusCode.OK){Content=new StringContent(json,Encoding.UTF8,"application/json")};
        }
    }
    [Fact]
    public async Task Courier_mock_flow_guards_payloads_token_reuse_and_rollback()
    {
        var admin=await Admin();var user=await LoginPhone("9876100090");var seller=Guid.Parse((await user.Post("/api/seller/register",new{display_name="Synthetic Courier Store"})).Json["id"]!.GetValue<string>());await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved',legal_name='Synthetic Courier Legal' WHERE id=@seller",new{seller});
        var whResponse=await user.Post("/api/seller/warehouses",new{code="SYNTH",name="Synthetic Warehouse",line1="1 Synthetic Road",city="Coimbatore",state_code="33",pincode="641001"});Assert.Equal(201,whResponse.Status);var wh=Guid.Parse(whResponse.Json.AsArray()[0]!["id"]!.GetValue<string>());
        var category=Guid.NewGuid();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@category,'Synthetic Courier','synthetic-courier','',1000,500,0,1,'[]')",new{category});var product=await user.Post("/api/seller/products",new{category_id=category,title="Synthetic Courier Product",hsn_code="6205",gst_bps=500,variants=new[]{new{sku="SYNTH-COURIER",mrp_paise=20000,price_paise=10000,stock=10,weight_grams=750}}});Assert.Equal(201,product.Status);var pid=Guid.Parse(product.Json["id"]!.GetValue<string>());var vid=Guid.Parse(product.Json["variants"]![0]!["id"]!.GetValue<string>());
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var orders=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var config=scope.ServiceProvider.GetRequiredService<AppSettings>();var integrations=scope.ServiceProvider.GetRequiredService<IIntegrationBAL>();var oldBase=config.ShiprocketApiBase;var oldMode=config.ExternalProviderMode;
        async Task<Guid> Package(int n)
        {
            var oid=Guid.NewGuid();var sub=Guid.NewGuid();var at=DateTime.UtcNow;await using var tx=await db.BeginAsync();await orders.InsertOrderAsync(new(){Id=oid,UserId=Guid.Parse(user.Id),Number="SYNTH-COURIER-O"+n,Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{\"full_name\":\"Synthetic Buyer\",\"line1\":\"2 Synthetic Road\",\"city\":\"Coimbatore\",\"pincode\":\"641002\",\"phone\":\"9876100099\",\"state\":\"Tamil Nadu\"}",ItemsTotal=10000,FeesTotal=300,TipPaise=200,GrandTotal=10500,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=at,UpdatedAt=at},tx);await orders.InsertSubOrderAsync(new(){Id=sub,OrderId=oid,SellerId=seller,Number="SYNTH-COURIER-P"+n,Status="packed",SettlementStatus="not_due",WarehouseId=wh,ShippingProvider="manual",ItemsTotal=10000,Total=10000,PlatformDiscount=500,CreatedAt=at,UpdatedAt=at},tx);await orders.InsertOrderItemAsync(new(){Id=Guid.NewGuid(),SubOrderId=sub,ProductId=pid,VariantId=vid,Title="Synthetic Courier Product",Sku="SYNTH-COURIER",HsnCode="6205",Qty=2,UnitPrice=5000,UnitMrp=6000,LineTotal=10000,TaxableValue=10000},tx);await tx.CommitAsync();return sub;
        }
        var id=await Package(1);string Route(Guid x)=>"/api/seller/orders/"+x+"/book-courier";var calls=new List<(string Path,JsonObject Body)>();
        try
        {
            config.ExternalProviderMode="";ShippingBAL.TestTransportFactory=()=>new Handler(calls);Assert.Equal("shipping_manual",(await user.Post(Route(id))).ErrorCode);Assert.Empty(calls);
            await integrations.SaveAsync("shiprocket",new(){["email"]="synthetic@example.test",["password"]="synthetic-not-real",["webhook_token"]="synthetic-not-real"},[],true,"Synthetic");
            Assert.Equal(502,(await user.Post(Route(id))).Status);Assert.Empty(calls);config.ShiprocketApiBase="http://127.0.0.1:9";integrations.Invalidate();
            var other=await LoginPhone("9876100091");await other.Post("/api/seller/register",new{display_name="Other"});await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE user_id=@id",new{id=other.Id});Assert.Equal(404,(await other.Post(Route(id))).Status);
            await ApiFactory.DbExecAsync("UPDATE sub_orders SET status='confirmed' WHERE id=@id",new{id});Assert.Equal("not_packed",(await user.Post(Route(id))).ErrorCode);await ApiFactory.DbExecAsync("UPDATE sub_orders SET status='packed',shipping_provider='fleet' WHERE id=@id",new{id});Assert.Equal("fleet_order",(await user.Post(Route(id))).ErrorCode);await ApiFactory.DbExecAsync("UPDATE sub_orders SET shipping_provider='manual' WHERE id=@id",new{id});Assert.Empty(calls);
            foreach(var failure in new[]{"/auth/login","malformed","missing-token"}){ShippingBAL.TestTransportFactory=()=>new Handler(calls,failure);Assert.Equal("shiprocket_auth",(await user.Post(Route(id))).ErrorCode);Assert.Equal("packed",await ApiFactory.DbScalarAsync<string>("SELECT status FROM sub_orders WHERE id=@id",new{id}));}
            calls.Clear();ShippingBAL.TestTransportFactory=()=>new Handler(calls,"/courier/assign/awb");var failed=await user.Post(Route(id));Assert.Equal(502,failed.Status);Assert.Equal("packed",await ApiFactory.DbScalarAsync<string>("SELECT status FROM sub_orders WHERE id=@id",new{id}));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM integration_tokens WHERE provider='shiprocket'"));
            calls.Clear();ShippingBAL.TestTransportFactory=()=>new Handler(calls);
            await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_shipping_fail BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='suborder.book_courier' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic shipping rollback'; END IF; END");try{Assert.Equal(500,(await user.Post(Route(id))).Status);Assert.Equal(6,calls.Count);Assert.Equal("packed",await ApiFactory.DbScalarAsync<string>("SELECT status FROM sub_orders WHERE id=@id",new{id}));Assert.Equal("",await ApiFactory.DbScalarAsync<string>("SELECT provider_order_id FROM sub_orders WHERE id=@id",new{id}));Assert.Equal("",await ApiFactory.DbScalarAsync<string>("SELECT shiprocket_pickup_name FROM warehouses WHERE id=@wh",new{wh}));}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_shipping_fail");}
            calls.Clear();var success=await user.Post(Route(id));Assert.True(success.Status==200,success.ToString());Assert.Equal("shipped",success.Json["status"]!.GetValue<string>());Assert.Equal(6,calls.Count);Assert.Equal("PC"+wh.ToString("N")[..10],calls[1].Body["pickup_location"]!.GetValue<string>());var create=calls.Single(c=>c.Path=="/orders/create/adhoc").Body;Assert.Equal("5.00",create["transaction_charges"]!.GetValue<string>());Assert.Equal("5.00",create["total_discount"]!.GetValue<string>());Assert.Equal("50.00",create["order_items"]![0]!["selling_price"]!.GetValue<string>());Assert.Equal(1.5,create["weight"]!.GetValue<double>());
            Assert.Equal("123",await ApiFactory.DbScalarAsync<string>("SELECT provider_order_id FROM sub_orders WHERE id=@id",new{id}));Assert.Equal("shiprocket",await ApiFactory.DbScalarAsync<string>("SELECT shipping_provider FROM sub_orders WHERE id=@id",new{id}));Assert.NotEmpty(await ApiFactory.DbScalarAsync<string>("SELECT invoice_number FROM sub_orders WHERE id=@id",new{id}));Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='suborder.book_courier'"));
            calls.Clear();var second=await Package(2);Assert.Equal(200,(await user.Post(Route(second))).Status);Assert.Equal(4,calls.Count);Assert.DoesNotContain(calls,c=>c.Path is "/auth/login" or "/settings/company/addpickup");Assert.Equal("not_packed",(await user.Post(Route(second))).ErrorCode);
            await ApiFactory.DbExecAsync("UPDATE integration_tokens SET expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 5 HOUR) WHERE provider='shiprocket'");calls.Clear();var third=await Package(3);await ApiFactory.DbExecAsync("UPDATE orders SET payment_method='online',payment_status='paid' WHERE id=(SELECT order_id FROM sub_orders WHERE id=@third)",new{third});Assert.Equal(200,(await user.Post(Route(third))).Status);Assert.Equal(5,calls.Count);Assert.Equal("/auth/login",calls[0].Path);var prepaid=calls.Single(c=>c.Path=="/orders/create/adhoc").Body;Assert.Equal("Prepaid",prepaid["payment_method"]!.GetValue<string>());Assert.Equal("0.00",prepaid["transaction_charges"]!.GetValue<string>());
        }
        finally{ShippingBAL.TestTransportFactory=null;config.ShiprocketApiBase=oldBase;config.ExternalProviderMode=oldMode;integrations.Invalidate();}
    }
}
