namespace Tests;
public class SetupStatusTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Setup_status_uses_saved_published_pages_not_public_fallback_and_never_calls_providers()
    {
        var admin=await Admin();var user=await LoginPhone("9890000096");Assert.Equal(403,(await user.Get("/api/admin/setup-status")).Status);var r=await admin.Get("/api/admin/setup-status");Assert.True(r.Status==200,r.ToString());Assert.Equal(11,r.Json["total"]!.GetValue<int>());bool Done(Res response,string key)=>response.Json["items"]!.AsArray().Single(x=>x!["key"]!.GetValue<string>()==key)!["done"]!.GetValue<bool>();Assert.False(Done(r,"terms"));Assert.False(Done(r,"privacy"));Assert.False(Done(r,"returns"));Assert.False(Done(r,"sms"));Assert.False(Done(r,"two_step"));
        await admin.Put("/api/admin/storefront/pages/terms",new{slug="terms",title="Synthetic terms",body="Synthetic placeholder",is_published=true});await admin.Put("/api/admin/storefront/pages/privacy",new{slug="privacy",title="Synthetic privacy",body="Synthetic body",is_published=false});await admin.Put("/api/admin/storefront/pages/returns-policy",new{slug="returns-policy",title="Synthetic returns",body="Synthetic body"});
        r=await admin.Put("/api/admin/storefront/site",new{business=new{legal_name="Synthetic Company",registered_address="Synthetic Address",grievance=new{name="Synthetic Officer",email="officer@example.test"}},contact=new{items=new[]{new{type="email",label="Synthetic care",value="care@example.test",enabled=true}}}});Assert.True(r.Status==200,r.ToString());r=await admin.Get("/api/admin/setup-status");Assert.True(Done(r,"business_name"));Assert.True(Done(r,"registered_address"));Assert.True(Done(r,"grievance"));Assert.True(Done(r,"contact"));Assert.True(Done(r,"terms"));Assert.False(Done(r,"privacy"));Assert.True(Done(r,"returns"));Assert.False(Done(r,"gstin"));Assert.Equal(r.Json["items"]!.AsArray().Count(x=>x!["done"]!.GetValue<bool>()),r.Json["done"]!.GetValue<int>());
        await ApiFactory.DbExecAsync("UPDATE users SET totp_enabled=1 WHERE id=@id",new{id=admin.Id});r=await admin.Get("/api/admin/setup-status");Assert.True(Done(r,"two_step"));
    }
}
