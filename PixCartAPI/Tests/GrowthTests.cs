using System.Text.Json.Nodes;
using BAL.Interface;
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
    [Fact]public async Task First_order_bonus_is_added_to_the_first_delivered_package_only()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000081");var uid=Guid.Parse(buyer.Id);
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        async Task<int> Earn(string number){await using var tx=await db.BeginAsync();await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=0");var n=await BAL.LoyaltyPoints.EarnAsync(tx,Guid.NewGuid(),number,250000,uid);await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=1");await tx.CommitAsync();return n;}
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{loyalty=new{enabled=true,points_per_100=2,first_order_points=50}})).Status);
        Assert.Equal(100,await Earn("SYNTH-FIRST-1")); // 50 for the goods plus 50 for the first order
        Assert.Contains("first order bonus",(await buyer.Get("/api/loyalty")).Json["history"]![0]!["note"]!.GetValue<string>());
        Assert.Equal(50,await Earn("SYNTH-FIRST-2")); // no bonus the second time
        Assert.Equal(150,(await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
    }
    [Fact]public async Task Tier_bonus_adds_points_only_for_silver_and_up()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000074");var uid=Guid.Parse(buyer.Id);
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        async Task<int> Earn(Guid sub,string no){await using var tx=await db.BeginAsync();await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=0");var n=await BAL.LoyaltyPoints.EarnAsync(tx,sub,no,250000,uid);await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=1");await tx.CommitAsync();return n;}
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{loyalty=new{enabled=true,points_per_100=2,tier_silver_points=60,tier_gold_points=0,silver_bonus_percent=50}})).Status);
        Assert.Equal(50,await Earn(Guid.NewGuid(),"SYNTH-TIER-1"));
        Assert.Equal(0,(await buyer.Get("/api/loyalty")).Json["bonus_percent"]!.GetValue<int>());
        Assert.Equal(200,(await admin.Post("/api/admin/growth/loyalty/adjust",new{user_id=uid,points=10,note="Reach silver"})).Status);
        var me=(await buyer.Get("/api/loyalty")).Json;Assert.Equal("silver",me["tier"]!.GetValue<string>());Assert.Equal(50,me["bonus_percent"]!.GetValue<int>());
        Assert.Equal(75,await Earn(Guid.NewGuid(),"SYNTH-TIER-2"));
        Assert.Contains("50% tier bonus",(await buyer.Get("/api/loyalty")).Json["history"]![0]!["note"]!.GetValue<string>());
        Assert.Equal(400,(await admin.Put("/api/admin/growth/settings",new{loyalty=new{gold_bonus_percent=900}})).Status);
    }
    [Fact]public async Task Segment_campaign_goes_only_to_opted_in_customers_within_the_caps()
    {
        var admin=await Admin();var body=new{segment="never_ordered",title="Weekend offer",message="Free shipping this weekend",link="/offers",dry_run=true};
        Assert.Equal("campaigns_off",(await admin.Post("/api/admin/growth/campaigns",body)).ErrorCode);
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{campaigns=new{enabled=true,max_recipients=2,max_per_day=2}})).Status);
        Assert.Equal("segments_off",(await admin.Post("/api/admin/growth/campaigns",body)).ErrorCode);
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{segments=new{enabled=true}})).Status);
        var people=new List<Api>();for(var i=0;i<4;i++)people.Add(await LoginPhone($"96100100{i:00}",$"Camp {i}"));
        for(var i=0;i<3;i++)await ApiFactory.DbExecAsync("UPDATE users SET marketing_opt_in=1 WHERE id=@id",new{id=people[i].Id});
        async Task<bool> Has(Api p)=>(await p.Get("/api/notifications")).Json["items"]!.AsArray().Any(n=>n!["title"]!.GetValue<string>()=="Weekend offer");
        var r=await admin.Post("/api/admin/growth/campaigns",body);Assert.True(r.Status==200,r.ToString());
        Assert.True(r.Json["dry_run"]!.GetValue<bool>());Assert.Equal(3,r.Json["opted_in"]!.GetValue<int>());Assert.Equal(2,r.Json["recipients"]!.GetValue<int>());Assert.True(r.Json["capped"]!.GetValue<bool>());
        Assert.Empty((await admin.Get("/api/admin/growth/campaigns")).Json["items"]!.AsArray());
        foreach(var p in people)Assert.False(await Has(p));
        r=await admin.Post("/api/admin/growth/campaigns",new{segment="never_ordered",title="Weekend offer",message="Free shipping this weekend",link="/offers",dry_run=false});
        Assert.Equal(2,r.Json["recipients"]!.GetValue<int>());
        var seen=new List<bool>();foreach(var p in people)seen.Add(await Has(p));
        Assert.Equal(2,seen.Count(x=>x));Assert.False(seen[3]);
        var log=(await admin.Get("/api/admin/growth/campaigns")).Json["items"]!.AsArray();Assert.Single(log);Assert.Equal(2,log[0]!["recipients"]!.GetValue<int>());
        Assert.Equal(200,(await admin.Post("/api/admin/growth/campaigns",new{segment="never_ordered",title="Weekend offer",message="Free shipping this weekend",link="/offers",dry_run=false})).Status);
        Assert.Equal("campaign_limit",(await admin.Post("/api/admin/growth/campaigns",new{segment="never_ordered",title="Weekend offer",message="Free shipping this weekend",link="/offers",dry_run=false})).ErrorCode);
        Assert.Equal("invalid_link",(await admin.Post("/api/admin/growth/campaigns",new{segment="never_ordered",title="T",message="M",link="https://evil.example"})).ErrorCode);
        Assert.Equal("invalid_segment",(await admin.Post("/api/admin/growth/campaigns",new{segment="nope",title="T",message="M"})).ErrorCode);
        Assert.Equal(403,(await people[0].Post("/api/admin/growth/campaigns",body)).Status);
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
    [Fact]public async Task Customer_segments_are_off_by_default_and_classify_customers()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000081","Fresh Face");
        Assert.Equal("segments_off",(await admin.Get("/api/admin/growth/segments")).ErrorCode);
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{segments=new{enabled=true}})).Status);
        var r=await admin.Get("/api/admin/growth/segments?segment=new");Assert.True(r.Status==200,r.ToString());
        var counts=r.Json["segments"]!.AsArray().ToDictionary(x=>x!["key"]!.GetValue<string>(),x=>x!["count"]!.GetValue<int>());
        Assert.True(counts["new"]>=1&&counts["never_ordered"]>=1);Assert.Equal(0,counts["vip"]);Assert.Equal(0,counts["lapsed"]);
        Assert.Contains(r.Json["items"]!.AsArray(),x=>x!["name"]!.GetValue<string>()=="Fresh Face"&&x["orders"]!.GetValue<int>()==0);
        Assert.Equal("invalid_segment",(await admin.Get("/api/admin/growth/segments?segment=nope")).ErrorCode);
        Assert.Equal(403,(await buyer.Get("/api/admin/growth/segments")).Status);
    }
    [Fact]public async Task Data_export_includes_loyalty_referral_and_support_requests()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000082","Export Me");
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{loyalty=new{enabled=true}})).Status);
        Assert.Equal(200,(await admin.Post("/api/admin/growth/loyalty/adjust",new{user_id=Guid.Parse(buyer.Id),points=25,note="Goodwill"})).Status);
        var t=await buyer.Post("/api/support/tickets",new{category="other",subject="Question about things",message="Please help me out here"});Assert.True(t.Status==201,t.ToString());
        var d=(await buyer.Get("/api/account/export")).Json;
        Assert.Equal(25,d["loyalty"]!["balance"]!.GetValue<long>());Assert.Equal("Goodwill",d["loyalty"]!["history"]![0]!["note"]!.GetValue<string>());
        Assert.Equal("Question about things",d["support_tickets"]![0]!["subject"]!.GetValue<string>());Assert.False(string.IsNullOrEmpty(d["referral_code"]!.GetValue<string>()));Assert.Equal(0,d["wishlist_count"]!.GetValue<long>());
    }
    [Fact]public async Task Returned_items_take_back_their_share_of_earned_points_once_and_never_below_zero()
    {
        var admin=await Admin();var buyer=await LoginPhone("9880000083");var uid=Guid.Parse(buyer.Id);var sub=Guid.NewGuid();
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{loyalty=new{enabled=true,points_per_100=2}})).Status);
        async Task<int> Run(Func<Utils.Interface.IUnitOfWork,Task<int>> f){await using var tx=await db.BeginAsync();await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=0");var n=await f(tx);await tx.ExecuteAsync("SET FOREIGN_KEY_CHECKS=1");await tx.CommitAsync();return n;}
        Assert.Equal(40,await Run(tx=>BAL.LoyaltyPoints.EarnAsync(tx,sub,"SYNTH-RET-1",200000,uid)));
        Assert.Equal(20,await Run(tx=>BAL.LoyaltyPoints.ReverseForReturnAsync(tx,sub,"SYNTH-RET-1",200000,100000,uid)));
        Assert.Equal(0,await Run(tx=>BAL.LoyaltyPoints.ReverseForReturnAsync(tx,sub,"SYNTH-RET-1",200000,100000,uid)));
        Assert.Equal(20,(await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        Assert.Equal(20,await Run(tx=>BAL.LoyaltyPoints.ReverseForReturnAsync(tx,sub,"SYNTH-RET-1",200000,200000,uid)));
        Assert.Equal(0,(await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        Assert.Equal("reverse",(await buyer.Get("/api/loyalty")).Json["history"]![0]!["kind"]!.GetValue<string>());
    }
    [Fact]public async Task Scheduled_campaign_is_held_until_its_time_and_can_be_cancelled()
    {
        var admin=await Admin();
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{campaigns=new{enabled=true,max_per_day=5},segments=new{enabled=true}})).Status);
        var fan=await LoginPhone("9610100001","Sched Fan");
        await ApiFactory.DbExecAsync("UPDATE users SET marketing_opt_in=1 WHERE id=@id",new{id=fan.Id});
        var soon=DateTime.UtcNow.AddHours(2);
        object Body(string title,DateTime at)=>new{segment="never_ordered",title,message="See you soon",link="/offers",dry_run=false,send_at=at};
        Assert.Equal("invalid_send_at",(await admin.Post("/api/admin/growth/campaigns",Body("Later offer",DateTime.UtcNow.AddSeconds(30)))).ErrorCode);
        Assert.Equal("invalid_send_at",(await admin.Post("/api/admin/growth/campaigns",Body("Later offer",DateTime.UtcNow.AddDays(40)))).ErrorCode);
        var r=await admin.Post("/api/admin/growth/campaigns",Body("Later offer",soon));
        Assert.True(r.Status==200&&r.Json["scheduled"]!.GetValue<bool>(),r.ToString());
        var cid=r.Json["id"]!.GetValue<string>();
        using var scope=Factory.Services.CreateScope();
        var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var notify=scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        async Task<bool> Has()=>(await fan.Get("/api/notifications")).Json["items"]!.AsArray().Any(n=>n!["title"]!.GetValue<string>()=="Later offer");
        Task<int> Due()=>BAL.SegmentCampaigns.SendDueAsync(db,notify);
        Assert.Equal(0,await Due());Assert.False(await Has());
        JsonNode Row(string id)=>(admin.Get("/api/admin/growth/campaigns").Result).Json["items"]!.AsArray().First(i=>i!["id"]!.GetValue<string>()==id)!;
        Assert.Equal("scheduled",Row(cid)["status"]!.GetValue<string>());
        await ApiFactory.DbExecAsync("UPDATE segment_campaigns SET send_at=@t WHERE id=@id",new{t=DateTime.UtcNow.AddMinutes(-1),id=cid});
        Assert.Equal(1,await Due());Assert.True(await Has());Assert.Equal(0,await Due());
        Assert.Equal("sent",Row(cid)["status"]!.GetValue<string>());Assert.True(Row(cid)["recipients"]!.GetValue<int>()>=1);
        Assert.Equal("not_scheduled",(await admin.Delete("/api/admin/growth/campaigns/"+cid)).ErrorCode);
        var r2=await admin.Post("/api/admin/growth/campaigns",Body("Never goes",soon));var id2=r2.Json["id"]!.GetValue<string>();
        Assert.Equal(200,(await admin.Delete("/api/admin/growth/campaigns/"+id2)).Status);
        Assert.Equal("cancelled",Row(id2)["status"]!.GetValue<string>());
    }
    sealed class FailingNotify : ICatalogNotifyBAL
    {
        public Task NotifyUserAsync(Guid userId, string @event, IReadOnlyDictionary<string, string> variables, string link = "") => throw new InvalidOperationException("gateway down");
        public Task NotifySellerAsync(Guid sellerId, string @event, IReadOnlyDictionary<string, string> variables, string link = "") => throw new InvalidOperationException("gateway down");
    }
    [Fact]public async Task Campaign_that_fails_mid_send_goes_back_to_scheduled_and_is_sent_on_the_next_run()
    {
        var admin=await Admin();
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{campaigns=new{enabled=true,max_per_day=5},segments=new{enabled=true}})).Status);
        var fan=await LoginPhone("9610100003","Retry Fan");
        await ApiFactory.DbExecAsync("UPDATE users SET marketing_opt_in=1 WHERE id=@id",new{id=fan.Id});
        var r=await admin.Post("/api/admin/growth/campaigns",new{segment="never_ordered",title="Retry offer",message="Hi",link="/offers",dry_run=false,send_at=DateTime.UtcNow.AddHours(2)});
        var cid=r.Json["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE segment_campaigns SET send_at=@t WHERE id=@id",new{t=DateTime.UtcNow.AddMinutes(-1),id=cid});
        using var scope=Factory.Services.CreateScope();
        var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var notify=scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        await Assert.ThrowsAsync<InvalidOperationException>(()=>BAL.SegmentCampaigns.SendDueAsync(db,new FailingNotify()));
        Assert.Equal("scheduled",await db.QueryFirstOrDefaultAsync<string>("SELECT status FROM segment_campaigns WHERE id=@id",new{id=cid}));
        Assert.True(await BAL.SegmentCampaigns.SendDueAsync(db,notify)>=1);
        Assert.Equal("sent",await db.QueryFirstOrDefaultAsync<string>("SELECT status FROM segment_campaigns WHERE id=@id",new{id=cid}));
    }
    [Fact]public async Task Repeating_campaign_makes_the_next_one_after_each_send_and_cancel_ends_it()
    {
        var admin=await Admin();
        Assert.Equal(200,(await admin.Put("/api/admin/growth/settings",new{campaigns=new{enabled=true,max_per_day=5},segments=new{enabled=true}})).Status);
        var fan=await LoginPhone("9610100002","Repeat Fan");
        await ApiFactory.DbExecAsync("UPDATE users SET marketing_opt_in=1 WHERE id=@id",new{id=fan.Id});
        object Body(int days,int times,bool withTime=true)=>withTime?new{segment="never_ordered",title="Weekly deal",message="New this week",dry_run=false,send_at=DateTime.UtcNow.AddHours(2),repeat_days=days,repeat_times=times}:new{segment="never_ordered",title="Weekly deal",message="New this week",dry_run=false,repeat_days=days,repeat_times=times};
        Assert.Equal("invalid_repeat",(await admin.Post("/api/admin/growth/campaigns",Body(5,2))).ErrorCode);
        Assert.Equal("invalid_repeat",(await admin.Post("/api/admin/growth/campaigns",Body(7,0))).ErrorCode);
        Assert.Equal("invalid_repeat",(await admin.Post("/api/admin/growth/campaigns",Body(0,3))).ErrorCode);
        Assert.Equal("invalid_repeat",(await admin.Post("/api/admin/growth/campaigns",Body(7,2,false))).ErrorCode);
        var r=await admin.Post("/api/admin/growth/campaigns",Body(7,2));
        Assert.True(r.Status==200&&r.Json["repeat_days"]!.GetValue<int>()==7&&r.Json["repeats_left"]!.GetValue<int>()==2,r.ToString());
        using var scope=Factory.Services.CreateScope();
        var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var notify=scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        Task<int> Due()=>BAL.SegmentCampaigns.SendDueAsync(db,notify);
        Task MakeDue()=>ApiFactory.DbExecAsync("UPDATE segment_campaigns SET send_at=@t WHERE title='Weekly deal' AND status='scheduled'",new{t=DateTime.UtcNow.AddMinutes(-1)});
        async Task<List<(string Status,int Left,int Days)>> Rows()=>(await db.QueryAsync<(string Status,int Left,int Days)>("SELECT status AS Status, repeats_left AS `Left`, repeat_days AS Days FROM segment_campaigns WHERE title='Weekly deal' ORDER BY created_at, send_at")).ToList();
        await MakeDue();Assert.Equal(1,await Due());
        var got=await Rows();Assert.Equal(new[]{"sent","scheduled"},got.Select(x=>x.Status).ToArray());Assert.Equal((1,7),(got[1].Left,got[1].Days));
        Assert.Equal(1,(await fan.Get("/api/notifications")).Json["items"]!.AsArray().Count(n=>n!["title"]!.GetValue<string>()=="Weekly deal"));
        await MakeDue();Assert.Equal(1,await Due());
        got=await Rows();Assert.Equal(new[]{"sent","sent","scheduled"},got.Select(x=>x.Status).ToArray());Assert.Equal(0,got[2].Left);
        var last=await db.QueryFirstOrDefaultAsync<Guid>("SELECT id FROM segment_campaigns WHERE title='Weekly deal' AND status='scheduled'");
        Assert.Equal(200,(await admin.Delete("/api/admin/growth/campaigns/"+last)).Status);
        await MakeDue();Assert.Equal(0,await Due());
        Assert.Equal(new[]{"sent","sent","cancelled"},(await Rows()).Select(x=>x.Status).ToArray());
    }
}
