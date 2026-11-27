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
}
