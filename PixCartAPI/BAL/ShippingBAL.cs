using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Model.DomainModel.Integrations;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Shiprocket booking with a fail-closed provider boundary and a transaction-scoped local result.</summary>
public sealed class ShippingBAL(IIntegrationBAL integrations,AppSettings app,IMySqlDapperHelper db,OrdersDAL orders,
    IOrdersBAL orderRules,DeliveryFleetBAL fleet,AuditDAL audit,ShippingDAL shipping):IShippingBAL
{
    public static Func<HttpMessageHandler>? TestTransportFactory{get;set;}
    private static bool Loopback(string address)=>Uri.TryCreate(address,UriKind.Absolute,out var uri)&&uri.Scheme is "http" or "https"&&System.Net.IPAddress.TryParse(uri.Host,out var ip)&&System.Net.IPAddress.IsLoopback(ip);
    private static string Text(JsonNode? n)=>n is null?"":n is JsonValue v&&v.TryGetValue<string>(out var s)?s:n.ToJsonString();
    private async Task<JsonObject> Call(IntegrationSettings config,IUnitOfWork tx,string path,JsonObject body,bool login=false)
    {
        var restricted=app.ExternalProviderMode!="open";
        if(restricted&&!Loopback(config.ShiprocketApiBase))throw new AppException("External provider calls are restricted to a local mock in this environment","shiprocket_error",502);
        var token="";
        if(!login)
        {
            var cached=await shipping.TokenAsync(tx);
            if(cached is not null&&cached.ExpiresAt>DateTime.UtcNow.AddHours(6))token=cached.Token;
            else
            {
                var result=await Call(config,tx,"/auth/login",new(){["email"]=config.ShiprocketEmail,["password"]=config.ShiprocketPassword},true);token=Text(result["token"]);
                if(token.Length==0)throw new AppException("Shiprocket login failed; check the API user in settings","shiprocket_auth",502);
                await shipping.SaveTokenAsync(token,DateTime.UtcNow.AddDays(9),tx);
            }
        }
        using var client=new HttpClient(TestTransportFactory?.Invoke()??new HttpClientHandler{AllowAutoRedirect=false});client.Timeout=TimeSpan.FromSeconds(login?20:30);
        using var req=new HttpRequestMessage(HttpMethod.Post,config.ShiprocketApiBase.TrimEnd('/')+path){Content=JsonContent.Create(body)};if(!login)req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
        try
        {
            using var response=await client.SendAsync(req);var text=await response.Content.ReadAsStringAsync();JsonObject? result=null;try{result=JsonNode.Parse(text) as JsonObject;}catch(System.Text.Json.JsonException){}
            if((int)response.StatusCode>=300||result is null)throw new AppException(login?"Shiprocket login failed; check the API user in settings":"Shiprocket: "+(Text(result?["message"]) is {Length:>0} message?message:"request failed"),login?"shiprocket_auth":"shiprocket_error",502);
            return result;
        }
        catch(HttpRequestException){throw new AppException("Shiprocket: request failed","shiprocket_error",502);}
    }
    public async Task<JsonObject> BookAsync(UserModel user,SellerModel seller,Guid subId)
    {
        await using var tx=await db.BeginAsync();var sub=await orders.SubForUpdateAsync(subId,tx);
        if(sub is null||sub.SellerId!=seller.Id)throw new NotFoundException("Order");
        if(sub.Status!="packed")throw new AppException("Pack the order before booking the courier","not_packed",409);
        if(sub.ShippingProvider=="fleet")throw new AppException("Our delivery partner picks up this order","fleet_order");
        var order=await orders.GetOrderAsync(sub.OrderId,tx)??throw new NotFoundException("Order");var route=await fleet.RouteAsync(sub,order);
        if(route["eligible"]!.GetValue<bool>()&&!route["choice"]!.GetValue<bool>())throw new AppException("Our delivery partners deliver this order. Mark it Ready for pickup instead.","fleet_order");
        var config=await integrations.GetAsync();if(config.ShippingProvider!="shiprocket"||config.ShiprocketEmail.Length==0||config.ShiprocketPassword.Length==0)throw new AppException("Courier booking is not set up; enter the courier and AWB yourself","shipping_manual");
        var warehouse=await shipping.WarehouseAsync(sub.WarehouseId,tx)??throw new NotFoundException("Warehouse");
        var items=await orders.ItemsAsync([sub.Id],tx);var weights=(await shipping.VariantsAsync(items.Select(i=>i.VariantId).ToArray(),tx)).ToDictionary(v=>v.Id,v=>v.WeightGrams);
        var pickup=warehouse.ShiprocketPickupName;
        if(pickup.Length==0)
        {
            pickup="PC"+warehouse.Id.ToString("N")[..10];
            await Call(config,tx,"/settings/company/addpickup",new(){["pickup_location"]=pickup,["name"]=warehouse.ContactName.Length>0?warehouse.ContactName:seller.DisplayName,["email"]=seller.ContactEmail,["phone"]=warehouse.ContactPhone.Length>0?warehouse.ContactPhone:seller.ContactPhone,["address"]=warehouse.Line1[..Math.Min(80,warehouse.Line1.Length)],["address_2"]=warehouse.Line2[..Math.Min(80,warehouse.Line2.Length)],["city"]=warehouse.City,["state"]=IndianStates.Names.GetValueOrDefault(warehouse.StateCode,""),["country"]="India",["pin_code"]=warehouse.Pincode});
            await shipping.SavePickupAsync(warehouse.Id,pickup,tx);
        }
        var ship=JsonNode.Parse(order.ShipTo) as JsonObject??new();string S(string key)=>Text(ship[key]);string Money(long n)=>(n/100m).ToString("F2",CultureInfo.InvariantCulture);
        var extra=order.PaymentMethod=="cod"?await orderRules.CollectAmountAsync(sub,order,tx)-(sub.Total-sub.PlatformDiscount):0;
        var created=await Call(config,tx,"/orders/create/adhoc",new(){["order_id"]=sub.Number,["order_date"]=sub.CreatedAt.ToString("yyyy-MM-dd HH:mm",CultureInfo.InvariantCulture),["pickup_location"]=pickup,["billing_customer_name"]=S("full_name"),["billing_last_name"]="",["billing_address"]=S("line1"),["billing_address_2"]=S("line2"),["billing_city"]=S("city"),["billing_pincode"]=S("pincode"),["billing_state"]=S("state"),["billing_country"]="India",["billing_email"]="",["billing_phone"]=S("phone"),["shipping_is_billing"]=true,["order_items"]=new JsonArray(items.Select(i=>(JsonNode)new JsonObject{["name"]=i.Title[..Math.Min(100,i.Title.Length)],["sku"]=i.Sku,["units"]=i.Qty,["selling_price"]=Money(i.UnitPrice),["hsn"]=i.HsnCode}).ToArray()),["payment_method"]=order.PaymentMethod=="cod"?"COD":"Prepaid",["shipping_charges"]=Money(sub.ShippingFee),["sub_total"]=Money(sub.Total-sub.ShippingFee),["total_discount"]=Money(sub.PlatformDiscount),["transaction_charges"]=Money(Math.Max(0,extra)),["length"]=20,["breadth"]=15,["height"]=10,["weight"]=Math.Round(Math.Max(0.1,items.Sum(i=>(long)weights.GetValueOrDefault(i.VariantId,500)*i.Qty)/1000d),2)});
        sub.ProviderOrderId=Text(created["order_id"]);sub.ProviderShipmentId=Text(created["shipment_id"]);
        var awb=await Call(config,tx,"/courier/assign/awb",new(){["shipment_id"]=sub.ProviderShipmentId});var data=awb["response"]?["data"];
        sub.TrackingNumber=Text(data?["awb_code"]);sub.CourierName=Text(data?["courier_name"]);sub.CourierName=sub.CourierName[..Math.Min(60,sub.CourierName.Length)];sub.TrackingUrl=sub.TrackingNumber.Length>0?"https://shiprocket.co/tracking/"+sub.TrackingNumber:"";
        await Call(config,tx,"/courier/generate/pickup",new(){["shipment_id"]=new JsonArray(sub.ProviderShipmentId)});var label=await Call(config,tx,"/courier/generate/label",new(){["shipment_id"]=new JsonArray(sub.ProviderShipmentId)});sub.LabelUrl=Text(label["label_url"]);sub.LabelUrl=sub.LabelUrl[..Math.Min(400,sub.LabelUrl.Length)];sub.ShippingProvider="shiprocket";
        await shipping.SaveShipmentAsync(sub,tx);
        await orderRules.TransitionAsync(sub,"shipped","seller","Booked with "+sub.CourierName+" "+sub.TrackingNumber,tx);
        await audit.InsertAsync(new(){Id=Guid.NewGuid(),ActorUserId=user.Id,Action="suborder.book_courier",EntityType="sub_order",EntityId=sub.Id.ToString(),CreatedAt=DateTimeFunctions.UtcNow()},tx.Transaction);await tx.CommitAsync();
        return new(){["courier_name"]=sub.CourierName,["tracking_number"]=sub.TrackingNumber,["label_url"]=sub.LabelUrl,["status"]=sub.Status};
    }
}
