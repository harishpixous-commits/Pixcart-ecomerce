using Microsoft.Extensions.DependencyInjection;
using Utils.Interface;
namespace Tests;
public class GrowthTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Growth_settings_default_off_validate_and_scorecard_is_admin_only()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000071");
        var r=await admin.Get("/api/admin/growth/settings");Assert.True(r.Status==200,r.ToString());Assert.False(r.Json["settings"]!["loyalty"]!["enabled"]!.GetValue<bool>());Assert.True(r.Json["settings"]!["seo"]!["sitemap_enabled"]!.GetValue<bool>());
        r=await admin.Put("/api/admin/growth/settings",new{loyalty=new{enabled=true,points_per_100=2},cod_risk=new{blocked_pincodes=new[]{"641001","bad","641001"}}});Assert.True(r.Status==200,r.ToString());
        Assert.True(r.Json["settings"]!["loyalty"]!["enabled"]!.GetValue<bool>());Assert.Equal(2,r.Json["settings"]!["loyalty"]!["points_per_100"]!.GetValue<int>());Assert.Single(r.Json["settings"]!["cod_risk"]!["blocked_pincodes"]!.AsArray());
        Assert.Equal("invalid_setting",(await admin.Put("/api/admin/growth/settings",new{loyalty=new{points_per_100=-1}})).ErrorCode);
        Assert.Equal("invalid_setting",(await admin.Put("/api/admin/growth/settings",new{nope=new{}})).ErrorCode);
        Assert.Equal("invalid_setting",(await admin.Put("/api/admin/growth/settings",new{loyalty=new{tier_silver_points=900,tier_gold_points=100}})).ErrorCode);
        Assert.Equal("invalid_setting",(await admin.Put("/api/admin/growth/settings",new{scorecard=new{late_warn_percent=50,late_critical_percent=10}})).ErrorCode);
        Assert.Equal(403,(await buyer.Get("/api/admin/growth/scorecard")).Status);Assert.Equal(403,(await buyer.Get("/api/admin/growth/settings")).Status);
        r=await admin.Get("/api/admin/growth/scorecard");Assert.True(r.Status==200,r.ToString());Assert.NotNull(r.Json["items"]);
    }
    [Fact]public async Task Loyalty_points_are_earned_once_per_package_only_when_on_and_staff_can_adjust()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000072");var uid=Guid.Parse(buyer.Id);var sub=Guid.NewGuid();
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        async Task<int> Earn(){await using var tx=await db.BeginAsync();await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=0");var n=await BAL.LoyaltyPoints.EarnAsync(tx,sub,"SYNTH-LOY-1",250000,uid);await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=1");await tx.CommitAsync();return n;}
        Assert.Equal(0,await Earn());Assert.Equal(0,(await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{loyalty=new{enabled=true,points_per_100=2}})).Status);
        Assert.Equal(50,await Earn());Assert.Equal(0,await Earn());
        var me=(await buyer.Get("/api/loyalty")).Json;Assert.Equal(50,me["balance"]!.GetValue<long>());Assert.Equal("member",me["tier"]!.GetValue<string>());Assert.Equal("earn",me["history"]![0]!["kind"]!.GetValue<string>());
        var r=await admin.Post("/api/admin/growth/loyalty/adjust",new{user_id=uid,points=10,note="Goodwill"});Assert.True(r.Status==200,r.ToString());Assert.Equal(60,r.Json["balance"]!.GetValue<long>());
        Assert.Equal("balance_too_low",(await admin.Post("/api/admin/growth/loyalty/adjust",new{user_id=uid,points=-61,note="Too much"})).ErrorCode);
        Assert.Equal(403,(await buyer.Post("/api/admin/growth/loyalty/adjust",new{user_id=uid,points=5,note="Nope"})).Status);
    }
    [Fact]public async Task Sitemap_and_robots_follow_the_search_engine_settings()
    {
        var admin=await Admin();var c=Factory.CreateClient();
        var r=await c.GetAsync("/api/seo/sitemap.xml");Assert.Equal(200,(int)r.StatusCode);Assert.Contains("xml",r.Content.Headers.ContentType!.ToString());var xml=await r.Content.ReadAsStringAsync();Assert.Contains("<urlset",xml);Assert.DoesNotContain("/store/",xml);
        Assert.Equal(200,(int)(await c.GetAsync("/sitemap.xml")).StatusCode);var robots=await (await c.GetAsync("/robots.txt")).Content.ReadAsStringAsync();Assert.Contains("Disallow: /admin",robots);Assert.Contains("/sitemap.xml",robots);
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{seo=new{sitemap_enabled=false}})).Status);Assert.Equal(404,(int)(await c.GetAsync("/api/seo/sitemap.xml")).StatusCode);
    }
    [Fact]public async Task Cod_risk_rules_refuse_cash_orders_by_pincode_value_and_first_order()
    {
        var admin=await Admin();using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var uid=Guid.NewGuid();
        async Task<string?> Check(string pin,long total){await using var tx=await db.BeginAsync();return await BAL.CodRisk.ReasonAsync(tx,uid,pin,total);}
        Assert.Null(await Check("641001",99999999));
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{cod_risk=new{enabled=true,max_cod_paise=500000,new_account_max_cod_paise=200000,blocked_pincodes=new[]{"641001"}}})).Status);
        Assert.Contains("pincode",await Check("641001",100));Assert.Contains("order value",await Check("641002",600000));Assert.Contains("first order",await Check("641002",300000));Assert.Null(await Check("641002",150000));
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{cod_risk=new{enabled=false}})).Status);Assert.Null(await Check("641001",99999999));
    }
    [Fact]public async Task Seller_sees_only_their_own_scorecard()
    {
        var admin=await Admin();var u=await LoginPhone("9880000073","Synthetic Scorecard Seller");var sid=Guid.Parse((await u.Post("/api/seller/register",new{display_name="Synthetic Scorecard Store"})).Json["id"]!.GetValue<string>());
        Assert.Equal(403,(await u.Get("/api/seller/scorecard")).Status);await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@sid",new{sid});
        Assert.False((await u.Get("/api/seller/scorecard")).Json["enabled"]!.GetValue<bool>());
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{scorecard=new{enabled=true,min_orders=1}})).Status);
        var r=await u.Get("/api/seller/scorecard");Assert.True(r.Status==200,r.ToString());Assert.True(r.Json["enabled"]!.GetValue<bool>());Assert.Equal(0,r.Json["you"]!["orders"]!.GetValue<int>());Assert.Equal(10,r.Json["limits"]!["late_warn_percent"]!.GetValue<int>());
    }
    [Fact]public async Task Referral_rewards_both_sides_once_on_the_friends_first_delivery()
    {
        var admin=await Admin();var ann=await LoginPhone("9880000081");var bob=await LoginPhone("9880000082");var cy=await LoginPhone("9880000083");var a=Guid.Parse(ann.Id);var b=Guid.Parse(bob.Id);
        var code=(await ann.Get("/api/referral")).Json["code"]!.GetValue<string>();
        Assert.Equal("referral_off",(await bob.Post("/api/referral/apply",new{code})).ErrorCode);
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{referral=new{enabled=true,min_order_paise=100,referrer_reward_paise=10000,friend_reward_paise=5000}})).Status);
        Assert.Equal("invalid_code",(await bob.Post("/api/referral/apply",new{code="PX00000000"})).ErrorCode);
        Assert.Equal("own_code",(await ann.Post("/api/referral/apply",new{code})).ErrorCode);
        Assert.Equal(200,(await bob.Post("/api/referral/apply",new{code})).Status);
        Assert.Equal("already_used",(await bob.Post("/api/referral/apply",new{code})).ErrorCode);
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        async Task<bool> Reward(Guid u,long total){await using var tx=await db.BeginAsync();var ok=await BAL.ReferralRewards.RewardAsync(tx,total,u);await tx.CommitAsync();return ok;}
        Assert.False(await Reward(b,50));                      // below the minimum order
        Assert.Equal(0,(await ann.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        Assert.True(await Reward(b,5000));Assert.False(await Reward(b,5000));  // once
        Assert.Equal(100,(await ann.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());Assert.Equal(50,(await bob.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        var s=(await ann.Get("/api/referral")).Json;Assert.Equal(1,s["joined"]!.GetValue<int>());Assert.Equal(1,s["rewarded"]!.GetValue<int>());Assert.Equal(10000,s["earned_paise"]!.GetValue<long>());
        var rows=(await admin.Get("/api/admin/growth/referrals")).Json["items"]!.AsArray();Assert.Single(rows);Assert.Equal("rewarded",rows[0]!["status"]!.GetValue<string>());
        Assert.Equal(403,(await ann.Get("/api/admin/growth/referrals")).Status);
        // a customer who already ordered cannot join afterwards
        await ApiFactory.DbExecAsync("INSERT INTO orders(id,number,user_id,status,payment_method,payment_status,ship_to,items_total,shipping_total,cod_fee,refunded_total,grand_total,currency,fx_rate,fees,idempotency_key,created_at,updated_at) VALUES(@id,'PXREF1',@u,'placed','cod','pending','{}',100,0,0,0,100,'INR',1,'[]',@k,UTC_TIMESTAMP(),UTC_TIMESTAMP())",new{id=Guid.NewGuid(),u=Guid.Parse(cy.Id),k=Guid.NewGuid().ToString()});
        Assert.Equal("not_new",(await cy.Post("/api/referral/apply",new{code})).ErrorCode);
    }
    [Fact]public void Flash_sale_limits_only_apply_when_switched_on()
    {
        var on=new System.Text.Json.Nodes.JsonObject{["enabled"]=true,["max_duration_hours"]=4,["max_discount_percent"]=50};
        var off=new System.Text.Json.Nodes.JsonObject{["enabled"]=false,["max_duration_hours"]=4,["max_discount_percent"]=50};
        Assert.Null(BAL.DealsBAL.FlashGuard(off,TimeSpan.FromHours(30),100000,1000));
        Assert.Equal("too_long",BAL.DealsBAL.FlashGuard(on,TimeSpan.FromHours(5),100000,60000)!.Value.Code);
        Assert.Equal("discount_too_large",BAL.DealsBAL.FlashGuard(on,TimeSpan.FromHours(3),100000,40000)!.Value.Code);
        Assert.Null(BAL.DealsBAL.FlashGuard(on,TimeSpan.FromHours(3),100000,50000));
    }
}
