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
}
