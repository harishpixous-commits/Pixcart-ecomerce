using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using BAL;
namespace Tests;
public class PaymentGatewaysTests
{
    private static readonly JsonObject Cust=new(){["id"]="u1",["name"]="Asha Rao",["contact"]="+919800000000",["email"]="a@x.in"};
    private static HttpClient Client(Func<HttpRequestMessage,string,(int,string)> f)=>new(new FakeHandler(r=>{var body=r.Content==null?"":r.Content.ReadAsStringAsync().Result;var(code,json)=f(r,body);return new HttpResponseMessage((HttpStatusCode)code){Content=new StringContent(json,Encoding.UTF8,"application/json")};}));
    private static Dictionary<string,string> D(params (string,string)[] kv)=>kv.ToDictionary(x=>x.Item1,x=>x.Item2);
    private static string Sha512(string s)=>Convert.ToHexString(SHA512.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    private static string Hmac(string k,string s)=>Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(k),Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    [Fact]public async Task Cashfree()
    {
        var seen=new List<(string,string)>();
        var g=new CashfreeGateway(Client((r,b)=>{seen.Add((r.RequestUri!.AbsolutePath,b));if(r.RequestUri.AbsolutePath.EndsWith("/payments"))return(200,"[{\"cf_payment_id\":7,\"payment_status\":\"SUCCESS\",\"payment_group\":\"upi\",\"payment_amount\":499.0}]");if(r.Method==HttpMethod.Post&&r.RequestUri.AbsolutePath.EndsWith("/orders"))return(200,"{\"order_id\":\"PC-1\",\"payment_session_id\":\"sess_1\"}");return(200,"{\"cf_refund_id\":\"r1\",\"refund_status\":\"SUCCESS\"}");}),D(("client_id","TEST123"),("client_secret","sec")));
        var o=await g.CreateAsync(49900,"INR","PC-1",Cust,"https://s/cb","https://s/hook");
        Assert.Equal("modal",o.Mode);Assert.Equal("sandbox",o.Fields["env"]!.ToString());Assert.Equal("sess_1",o.Fields["payment_session_id"]!.ToString());Assert.Contains("\"order_amount\":499",seen[0].Item2);
        var at=(await g.AttemptsAsync("PC-1"))[0];Assert.Equal("captured",at.Status);Assert.Equal(49900,at.Amount);Assert.Equal("upi",at.Method);
        Assert.Equal("processed",(await g.RefundAsync("PC-1","7",1000,"rf1","x")).Status);
        var body="{\"data\":{\"order\":{\"order_id\":\"PC-1\"}}}";var sig=Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes("sec"),Encoding.UTF8.GetBytes("123"+body)));
        Assert.Equal("PC-1",g.VerifyWebhook(D(("x-webhook-timestamp","123"),("x-webhook-signature",sig)),Encoding.UTF8.GetBytes(body)));
        Assert.Null(g.VerifyWebhook(D(("x-webhook-timestamp","123"),("x-webhook-signature","bad")),Encoding.UTF8.GetBytes(body)));
        var err=new CashfreeGateway(Client((_,_)=>(400,"{\"message\":\"bad order\"}")),D(("client_id","TESTx"),("client_secret","s")));
        Assert.Equal("bad order",(await Assert.ThrowsAsync<GatewayException>(()=>err.CreateAsync(100,"INR","A",Cust,"u","n"))).Message);
    }
    [Fact]public async Task PhonePe()
    {
        var tokens=0;var auths=new List<string>();
        var g=new PhonePeGateway(Client((r,b)=>{var p=r.RequestUri!.AbsolutePath;if(p.Contains("oauth")){tokens++;return(200,"{\"access_token\":\"tok\",\"expires_at\":"+DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds()+"}");}auths.Add(r.Headers.Authorization?.ToString()??r.Headers.GetValues("Authorization").First());if(p.EndsWith("/pay")){Assert.Contains("49900",b);return(200,"{\"redirectUrl\":\"https://pp/pay\"}");}if(p.EndsWith("/refund"))return(200,"{\"refundId\":\"R\",\"state\":\"PENDING\"}");return(200,"{\"state\":\"COMPLETED\",\"amount\":49900,\"paymentDetails\":[{\"transactionId\":\"T1\",\"paymentMode\":\"UPI\"}]}");}),D(("client_id","c"),("client_secret","s"),("webhook_username","u"),("webhook_password","p")));
        Assert.Equal("https://pp/pay",(await g.CreateAsync(49900,"INR","PC-2",Cust,"https://s/cb","")).Fields["url"]!.ToString());
        var at=(await g.AttemptsAsync("PC-2"))[0];Assert.Equal("captured",at.Status);Assert.Equal("T1",at.Id);
        Assert.Equal("pending",(await g.RefundAsync("PC-2","T1",100,"rf","")).Status);Assert.Equal(1,tokens);Assert.All(auths,a=>Assert.Equal("O-Bearer tok",a));
        var body=Encoding.UTF8.GetBytes("{\"payload\":{\"merchantOrderId\":\"PC-2\"}}");var auth=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("u:p"))).ToLowerInvariant();
        Assert.Equal("PC-2",g.VerifyWebhook(D(("Authorization",auth)),body));Assert.Null(g.VerifyWebhook(D(("Authorization","nope")),body));
    }
    [Fact]public async Task PayU()
    {
        var g=new PayUGateway(Client((r,b)=>b.Contains("verify_payment")?(200,"{\"status\":1,\"transaction_details\":{\"PC-3\":{\"mihpayid\":\"99\",\"status\":\"success\",\"mode\":\"UPI\",\"amt\":\"499.00\"}}}"):(200,"{\"status\":1,\"request_id\":\"q1\"}")),D(("key","K"),("salt","S")));
        var o=await g.CreateAsync(49900,"INR","PC-3",Cust,"https://s/cb","");var f=(JsonObject)o.Fields["fields"]!;
        Assert.Equal("form",o.Mode);Assert.Equal("https://test.payu.in/_payment",o.Fields["action"]!.ToString());Assert.Equal("499.00",f["amount"]!.ToString());
        Assert.Equal(Sha512("K|PC-3|499.00|Order PC-3|Asha|a@x.in"+new string('|',11)+"S"),f["hash"]!.ToString());
        var post=D(("status","success"),("email","a@x.in"),("firstname","Asha"),("productinfo","Order PC-3"),("amount","499.00"),("txnid","PC-3"),("key","K"));post["hash"]=Sha512("S|success|||||||||||a@x.in|Asha|Order PC-3|499.00|PC-3|K");
        Assert.Equal("PC-3",g.ReferenceFromReturn(post));post["status"]="failure";Assert.Null(g.ReferenceFromReturn(post));
        var at=(await g.AttemptsAsync("PC-3"))[0];Assert.Equal("captured",at.Status);Assert.Equal("99",at.Id);Assert.Equal(49900,at.Amount);
        Assert.Equal("q1",(await g.RefundAsync("PC-3","99",500,"rf","")).Id);
    }
    [Fact]public async Task Stripe()
    {
        var g=new StripeGateway(Client((r,b)=>{var p=r.RequestUri!.AbsolutePath;if(r.Method==HttpMethod.Post&&p.EndsWith("/checkout/sessions")){Assert.Contains("unit_amount%5D=49900",b);Assert.Contains("client_reference_id=PC-4",b);Assert.Equal("Bearer sk_test_1",r.Headers.Authorization!.ToString());return(200,"{\"id\":\"cs_1\",\"url\":\"https://stripe/pay\"}");}if(p.EndsWith("/refunds"))return(200,"{\"id\":\"re_1\",\"status\":\"succeeded\"}");return(200,"{\"payment_status\":\"paid\",\"amount_total\":49900,\"payment_intent\":{\"id\":\"pi_1\"}}");}),D(("secret_key","sk_test_1"),("webhook_secret","whsec")));
        var o=await g.CreateAsync(49900,"USD","PC-4",Cust,"https://s/cb","");Assert.Equal("cs_1",o.Reference);Assert.Equal("https://stripe/pay",o.Fields["url"]!.ToString());
        var at=(await g.AttemptsAsync("cs_1"))[0];Assert.Equal("captured",at.Status);Assert.Equal("pi_1",at.Id);Assert.Equal("processed",(await g.RefundAsync("cs_1","pi_1",100,"rf","")).Status);
        var body="{\"data\":{\"object\":{\"id\":\"cs_1\"}}}";var t=DateTimeOffset.UtcNow.ToUnixTimeSeconds();var bytes=Encoding.UTF8.GetBytes(body);
        Assert.Equal("cs_1",g.VerifyWebhook(D(("Stripe-Signature",$"t={t},v1={Hmac("whsec",t+"."+body)}")),bytes));
        Assert.Null(g.VerifyWebhook(D(("Stripe-Signature",$"t={t},v1=bad")),bytes));
        var old=t-1000;Assert.Null(g.VerifyWebhook(D(("Stripe-Signature",$"t={old},v1={Hmac("whsec",old+"."+body)}")),bytes));
    }
}
