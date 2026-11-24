namespace Tests;
public class GoLiveTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Checklist_excludes_optional_from_totals_requires_real_policy_body_and_keeps_source_only_flags()
    {
        var admin=await Admin();var user=await LoginPhone("9890000097");
        Assert.Equal(403,(await user.Get("/api/admin/go-live")).Status);var r=await admin.Get("/api/admin/go-live");
        Assert.True(r.Status==200,r.ToString());var sections=r.Json["sections"]!.AsArray();
        Assert.Equal(8,sections.Count);var items=sections.SelectMany(x=>x!["items"]!.AsArray()).ToList();
        Assert.Equal(24,items.Count);
        Assert.Equal(17,r.Json["total"]!.GetValue<int>());bool Done(Res res,string key)=>res.Json["sections"]!.AsArray().SelectMany(x=>x!["items"]!.AsArray()).Single(x=>x!["key"]!.GetValue<string>()==key)!["done"]!.GetValue<bool>();
        Assert.False(Done(r,"terms"));
        Assert.False(Done(r,"privacy"));
        Assert.False(Done(r,"returns_policy"));
        Assert.False(Done(r,"ai"));
        Assert.True(Done(r,"tax"));
        Assert.True(Done(r,"staff"));
        Assert.False(Done(r,"msg91"));
        Assert.False(r.Json["ready"]!.GetValue<bool>());
        await admin.Put("/api/admin/storefront/pages/terms",new{slug="terms",title="Synthetic terms",body="Synthetic PLACEHOLDER",is_published=true});
        await admin.Put("/api/admin/storefront/pages/privacy",new{slug="privacy",title="Synthetic privacy",body="Synthetic policy",is_published=false});
        await admin.Put("/api/admin/storefront/pages/returns-policy",new{slug="returns-policy",title="Synthetic returns",body="Synthetic policy",is_published=true});
        r=await admin.Put("/api/admin/storefront/site",new{business=new{legal_name="Synthetic Company",gstin="33ABCDE1234F1Z"+Model.CustomeAttributes.IndianFormats.GstinCheckChar("33ABCDE1234F1Z"),registered_address="Synthetic Address",grievance=new{name="Synthetic Officer",email="officer@example.test"}},analytics=new{meta_pixel_id="123456789"}});Assert.True(r.Status==200,r.ToString());r=await admin.Get("/api/admin/go-live");
        Assert.False(Done(r,"terms"));
        Assert.False(Done(r,"privacy"));
        Assert.True(Done(r,"returns_policy"));
        Assert.True(Done(r,"legal_name"));
        Assert.True(Done(r,"gstin"));
        Assert.True(Done(r,"address"));
        Assert.False(Done(r,"grievance"));
        Assert.True(Done(r,"analytics"));
        await admin.Put("/api/admin/storefront/pages/terms",new{slug="terms",title="Synthetic terms",body="Synthetic policy",is_published=true});
        r=await admin.Put("/api/admin/storefront/site",new{business=new{legal_name="Synthetic Company",registered_address="Synthetic Address",grievance=new{name="Synthetic Officer",email="officer@example.test",phone="9990000000"}}});
        await ApiFactory.DbExecAsync("UPDATE users SET totp_enabled=1 WHERE id=@id",new{id=admin.Id});r=await admin.Get("/api/admin/go-live");
        Assert.True(Done(r,"terms"));
        Assert.True(Done(r,"grievance"));
        Assert.True(Done(r,"two_step"));var req=r.Json["sections"]!.AsArray().SelectMany(x=>x!["items"]!.AsArray()).Where(i=>i!["required"]!.GetValue<bool>()).ToList();
        Assert.Equal(req.Count,r.Json["total"]!.GetValue<int>());
        Assert.Equal(req.Count(i=>i!["done"]!.GetValue<bool>()),r.Json["done"]!.GetValue<int>());
        Assert.Equal(req.All(i=>i!["done"]!.GetValue<bool>()),r.Json["ready"]!.GetValue<bool>());
    }
}
