using System.Text.Json.Nodes;
using BAL;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Utils;
using Utils.Interface;
namespace Tests;
public class PaymentRoutingTests(ApiFactory f):ApiTest(f)
{
    private static readonly DateTime Now=new(2026,11,27,12,0,0,DateTimeKind.Utc);
    private static PaymentRouting.Event Ev(string g,bool ok,int secsAgo)=>new(g,ok,Now.AddSeconds(-secsAgo));
    private static JsonObject Cfg(Action<JsonObject>? edit=null){var c=PaymentRouting.Defaults();edit?.Invoke(c);return c;}
    private static HashSet<string> On(params string[] g)=>g.ToHashSet();
    [Fact]public void Priority_order_skips_disabled_and_unsupported_currency()
    {
        Assert.Equal(["razorpay","cashfree","stripe"],PaymentRouting.Eligible(Cfg(),On("razorpay","cashfree","stripe"),"INR",[],Now));
        Assert.Equal(["razorpay","stripe"],PaymentRouting.Eligible(Cfg(),On("razorpay","cashfree","stripe"),"USD",[],Now));
        Assert.Equal(["stripe","razorpay","cashfree"],PaymentRouting.Eligible(Cfg(c=>c["order"]=new JsonArray("stripe","razorpay")),On("razorpay","cashfree","stripe"),"INR",[],Now));
        Assert.Empty(PaymentRouting.Eligible(Cfg(),On(),"INR",[],Now));
    }
    [Fact]public void Circuit_opens_half_opens_and_closes()
    {
        var three=new List<PaymentRouting.Event>{Ev("razorpay",false,10),Ev("razorpay",false,20),Ev("razorpay",false,30)};
        Assert.Equal("open",PaymentRouting.CircuitState(three,Cfg(),Now));Assert.Equal(["payu"],PaymentRouting.Eligible(Cfg(),On("razorpay","payu"),"INR",three,Now));
        var old=new List<PaymentRouting.Event>{Ev("razorpay",false,200),Ev("razorpay",false,210),Ev("razorpay",false,220)};
        Assert.Equal("half_open",PaymentRouting.CircuitState(old,Cfg(),Now));Assert.Equal(["razorpay"],PaymentRouting.Eligible(Cfg(),On("razorpay"),"INR",old,Now));
        Assert.Equal("closed",PaymentRouting.CircuitState(old.Append(Ev("razorpay",true,5)),Cfg(),Now));Assert.Equal("closed",PaymentRouting.CircuitState([Ev("razorpay",false,5),Ev("razorpay",false,6)],Cfg(),Now));
    }
    [Fact]public void Success_rate_strategy_and_failover()
    {
        var cfg=Cfg(c=>c["strategy"]="success_rate");var events=new List<PaymentRouting.Event>();
        for(var i=0;i<10;i++){events.Add(Ev("razorpay",i%2==0,60+i));events.Add(Ev("cashfree",true,60+i));}events.Add(Ev("payu",false,30));events.Add(Ev("payu",false,31));
        Assert.Equal(["cashfree","payu","razorpay"],PaymentRouting.Eligible(cfg,On("razorpay","cashfree","payu"),"INR",events,Now));
        Assert.Equal(["razorpay","cashfree","payu"],PaymentRouting.Eligible(Cfg(),On("razorpay","cashfree","payu"),"INR",events,Now));
        Assert.Equal(["razorpay","payu"],PaymentRouting.ToTry(Cfg(),["razorpay","payu"]));Assert.Equal(["razorpay"],PaymentRouting.ToTry(Cfg(c=>c["failover"]=false),["razorpay","payu"]));Assert.Empty(PaymentRouting.ToTry(Cfg(c=>c["failover"]=false),[]));
    }
    [Fact]public async Task Settings_validate_and_events_are_recorded()
    {
        using var scope=Factory.Services.CreateScope();var sp=scope.ServiceProvider;var settings=sp.GetRequiredService<SettingsDAL>();var support=sp.GetRequiredService<CatalogSupportDAL>();var db=sp.GetRequiredService<IMySqlDapperHelper>();
        var cfg=await PaymentRouting.UpdateAsync(settings,support,new JsonObject{["order"]=new JsonArray("payu","stripe"),["strategy"]="success_rate",["timeout_seconds"]=10});
        Assert.Equal("payu",cfg["order"]![0]!.GetValue<string>());Assert.Equal("success_rate",cfg["strategy"]!.GetValue<string>());Assert.Equal(10,cfg["timeout_seconds"]!.GetValue<int>());
        foreach(var bad in new[]{"{\"timeout_seconds\":2}","{\"order\":[\"razorpay\",\"razorpay\"]}","{\"order\":[\"nope\"]}","{\"strategy\":\"x\"}","{\"failover\":1}","{\"x\":1}"})
            Assert.Equal("invalid_setting",Assert.Throws<AppException>(()=>PaymentRouting.Validate((JsonObject)JsonNode.Parse(bad)!)).Code);
        await PaymentRouting.RecordAsync(db,"razorpay",false,8001,new string('x',400));
        var ev=await PaymentRouting.RecentEventsAsync(db,DateTime.UtcNow);Assert.Contains(ev,e=>e.Gateway=="razorpay"&&!e.Ok);
        Assert.Equal(300,await ApiFactory.DbScalarAsync<int>("SELECT MAX(CHAR_LENGTH(`error`)) FROM payment_gateway_events"));
    }
}
