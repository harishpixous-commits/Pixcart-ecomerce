using System.Net;
using System.Text;
using BAL;
using Model.Constants;
using Model.DomainModel.Integrations;
namespace Tests;
public class GatewayIntegrationsTests
{
    [Fact]public void Gateways_are_listed_with_switches()
    {
        foreach(var code in new[]{"cashfree","phonepe","payu","stripe"})
        {
            var p=IntegrationRegistry.Providers.Single(x=>x.Key==code);
            Assert.Equal("payments",p.Group);Assert.Equal($"/api/payments/{code}/webhook",p.WebhookPath);Assert.True((bool)p.On[$"{code}_checkout"]);Assert.False((bool)p.Off[$"{code}_checkout"]);
            Assert.All(p.Fields,f=>Assert.True(IntegrationSettings.Has(f.Setting),f.Setting));
            Assert.True(IntegrationSettings.Has($"{code}_checkout"));
        }
    }
    [Fact]public void Enabled_needs_keys_and_switch()
    {
        var c=new IntegrationSettings{StripeSecretKey="sk_test_1",PayuKey="K",PayuSalt="S",PayuCheckout=false};
        Assert.True(GatewayConfig.Enabled(c,"stripe"));Assert.False(GatewayConfig.Enabled(c,"payu"));Assert.False(GatewayConfig.Enabled(c,"cashfree"));
    }
    [Fact]public async Task Ping_accepts_good_keys_and_reports_bad()
    {
        var ok=new HttpClient(new FakeHandler(r=>r.RequestUri!.AbsolutePath.EndsWith("/balance")?new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{}",Encoding.UTF8,"application/json")}:new HttpResponseMessage(HttpStatusCode.NotFound){Content=new StringContent("{\"message\":\"order not found\"}",Encoding.UTF8,"application/json")}));
        await GatewayConfig.Build(ok,new IntegrationSettings{StripeSecretKey="sk_test_1"},"stripe").PingAsync();
        await GatewayConfig.Build(ok,new IntegrationSettings{CashfreeClientId="TESTabcdef",CashfreeClientSecret="s"},"cashfree").PingAsync();
        var bad=new HttpClient(new FakeHandler(_=>new HttpResponseMessage(HttpStatusCode.Unauthorized){Content=new StringContent("{\"message\":\"bad keys\"}",Encoding.UTF8,"application/json")}));
        Assert.Equal("bad keys",(await Assert.ThrowsAsync<GatewayException>(()=>GatewayConfig.Build(bad,new IntegrationSettings{StripeSecretKey="sk_test_1"},"stripe").PingAsync())).Message);
    }
}
