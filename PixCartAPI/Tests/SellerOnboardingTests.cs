using System.Text;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Model.CustomeAttributes;
namespace Tests;

/// <summary>Seller workflow cases from test_auth_and_onboarding.py, local synthetic documents only.</summary>
public class SellerOnboardingTests(ApiFactory f) : ApiTest(f)
{
    private static string Gst(string pan = "ABCDE1234F") { var x = "33" + pan + "1Z"; return x + IndianFormats.GstinCheckChar(x); }
    private static object Profile(string gst, string pan = "ABCDE1234F") => new { display_name = "Meena Fabrics", legal_name = "Meena Fabrics LLP", business_type = "llp", contact_email = "MEENA@example.com", contact_phone = "9222222222", gstin = gst, pan };
    private static object Bank(string account = "123456789", string? confirm = null) => new { holder_name = "Meena", account_number = account, confirm_account_number = confirm ?? account, ifsc = "SBIN0001234" };
    private static object Pickup(string state = "33") => new { line1 = "1 Main Rd", city = "Coimbatore", state_code = state, pincode = "641001" };
    private static Task<Res> Upload(Api a, string kind, byte[]? bytes = null)
    {
        var body = new MultipartFormDataContent();
        var file = new ByteArrayContent(bytes ?? Encoding.ASCII.GetBytes("%PDF-1.4\nsynthetic fixture\n%%EOF"));
        file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/pdf");
        body.Add(file,"file","d.pdf");
        return a.Post($"/api/seller/documents/{kind}",body);
    }
    [Fact]
    public async Task Onboarding_validation_documents_review_and_ownership()
    {
        var admin = await Admin(); var a = await LoginPhone("9222222222","Meena");
        var r = await a.Post("/api/seller/register",new { display_name = "Meena Fabrics" });
        Assert.True(r.Status == 201,r.ToString()); var id = r.Json["id"]!.GetValue<string>();
        Assert.Equal(id,(await a.Post("/api/seller/register",new { display_name = "Ignored Name" })).Json["id"]!.GetValue<string>());
        r = await a.Post("/api/seller/submit"); Assert.Equal("onboarding_incomplete",r.ErrorCode); Assert.Contains("Pickup address",r.ErrorMessage);
        Assert.Equal(422,(await a.Put("/api/seller/profile",Profile("33ABCDE1234F1Z0"))).Status);
        Assert.Equal("pan_gstin_mismatch",(await a.Put("/api/seller/profile",Profile(Gst(),"ZZZZZ9999Z"))).ErrorCode);
        r = await a.Put("/api/seller/profile",Profile(Gst())); Assert.True(r.Status == 200,r.ToString());
        Assert.Equal("XXXXXX234F",r.Json["pan"]!.GetValue<string>());
        Assert.Equal("meena@example.com",r.Json["contact_email"]!.GetValue<string>());
        Assert.Equal("account_mismatch",(await a.Put("/api/seller/bank",Bank(confirm:"123456780"))).ErrorCode);
        r = await a.Put("/api/seller/bank",Bank()); Assert.Equal("XXXX6789",r.Json["bank"]!["account_number"]!.GetValue<string>());
        Assert.Equal(200,(await a.Put("/api/seller/pickup-address",Pickup("29"))).Status);
        Assert.Equal(200,(await a.Put("/api/seller/grievance-officer",new { name="Meena R",email="g@example.com",phone="9222222222" })).Status);
        Assert.Equal("invalid_document",(await Upload(a,"pan_card",[0x4d,0x5a,0x90,0])).ErrorCode);
        Assert.Equal(404,(await Upload(a,"invalid_kind")).Status);
        foreach (var k in new[] { "pan_card","gst_certificate","cancelled_cheque" }) Assert.Equal(200,(await Upload(a,k)).Status);
        Assert.Equal(3,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM seller_documents"));
        Assert.Equal(200,(await Upload(a,"pan_card")).Status);
        Assert.Equal(3,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM seller_documents"));
        var doc = await a.Get("/api/seller/documents/pan_card"); Assert.Equal(200,doc.Status); Assert.StartsWith("%PDF",doc.Text);
        Assert.Equal("gstin_state_mismatch",(await a.Post("/api/seller/submit")).ErrorCode);
        Assert.Equal(200,(await a.Put("/api/seller/pickup-address",Pickup())).Status);
        Assert.Equal("33",await ApiFactory.DbScalarAsync<string>("SELECT state_code FROM warehouses WHERE seller_id=@id",new { id }));
        r = await a.Post("/api/seller/submit"); Assert.Equal("submitted",r.Json["status"]!.GetValue<string>());
        Assert.Contains((await admin.Get("/api/notifications")).Json["items"]!.AsArray(),n=>n!["title"]!.GetValue<string>()=="Seller waiting for review");
        Assert.Equal(409,(await a.Put("/api/seller/bank",Bank("999999999"))).Status);
        Assert.Equal(409,(await a.Put("/api/seller/profile",Profile(Gst()))).Status);
        Assert.Equal(403,(await a.Post($"/api/admin/sellers/{id}/approve")).Status);
        using (var client = Factory.CreateClient())
        {
            using var request = new HttpRequestMessage(HttpMethod.Get,$"/api/admin/sellers/{id}/documents/pan_card");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",admin.Token);
            using var response = await client.SendAsync(request);
            Assert.Equal(200,(int)response.StatusCode);
            Assert.True(response.Headers.CacheControl!.Private);
            Assert.True(response.Headers.CacheControl.NoStore);
            Assert.Equal("nosniff",Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
            Assert.Equal("inline",response.Content.Headers.ContentDisposition!.DispositionType);
            Assert.StartsWith("%PDF",await response.Content.ReadAsStringAsync());
        }
        Assert.Equal(403,(await a.Get($"/api/admin/sellers/{id}/documents/pan_card")).Status);
        r = await admin.Get($"/api/admin/sellers/{id}"); Assert.True(r.Status == 200,r.ToString()); Assert.Equal("ABCDE1234F",r.Json["pan"]!.GetValue<string>());
        r = await admin.Post($"/api/admin/sellers/{id}/reject",new { reason="Cheque image is not readable" }); Assert.Equal("rejected",r.Json["status"]!.GetValue<string>());
        Assert.Equal("Cheque image is not readable",(await a.Get("/api/seller/me")).Json["rejection_reason"]!.GetValue<string>());
        Assert.Equal(200,(await a.Post("/api/seller/submit")).Status);
        r = await admin.Post($"/api/admin/sellers/{id}/approve"); Assert.True(r.Status == 200,r.ToString()); Assert.Equal("approved",r.Json["status"]!.GetValue<string>());
        // Non-KYC sections remain editable after approval.
        Assert.Equal(200,(await a.Put("/api/seller/store",new { display_name="Meena New Store",description="Updated",contact_email="m@example.com",contact_phone="9222222222" })).Status);
        Assert.Equal(200,(await a.Put("/api/seller/grievance-officer",new { name="Meena R",email="new@example.com",phone="9222222222" })).Status);
        Assert.Equal(409,(await Upload(a,"address_proof")).Status);
        var other = await LoginPhone("9333333333"); Assert.Equal(403,(await other.Get("/api/seller/documents/pan_card")).Status);
        var enc = await ApiFactory.DbScalarAsync<string>("SELECT pan_enc FROM sellers WHERE id=@id",new { id }); Assert.DoesNotContain("ABCDE1234F",enc);
    }
    [Fact]
    public async Task Duplicate_gstin_is_refused_and_seller_slugs_are_unique()
    {
        var a = await LoginPhone("9444444444"); var b = await LoginPhone("9555555555");
        var one = await a.Post("/api/seller/register",new { display_name="Same Store" }); var two = await b.Post("/api/seller/register",new { display_name="Same Store" });
        Assert.NotEqual(one.Json["slug"]!.GetValue<string>(),two.Json["slug"]!.GetValue<string>());
        Assert.Equal(200,(await a.Put("/api/seller/profile",Profile(Gst()))).Status);
        var r = await b.Put("/api/seller/profile",Profile(Gst())); Assert.Equal(409,r.Status); Assert.Equal("gstin_taken",r.ErrorCode);
    }
    [Fact]
    public async Task Signup_pause_does_not_block_existing_seller()
    {
        var admin = await Admin(); var a = await LoginPhone("9666666666"); var b = await LoginPhone("9777777777");
        Assert.Equal(201,(await a.Post("/api/seller/register",new { display_name="Existing Store" })).Status);
        Assert.Equal(200,(await admin.Put("/api/admin/auth-settings",new { seller_signup=false })).Status);
        Assert.Equal(201,(await a.Post("/api/seller/register",new { display_name="Existing Store" })).Status);
        var r = await b.Post("/api/seller/register",new { display_name="New Store" }); Assert.Equal(403,r.Status); Assert.Equal("seller_signup_closed",r.ErrorCode);
    }
    [Fact]
    public async Task Oversized_document_is_rejected_without_document_row()
    {
        var a = await LoginPhone("9888888888");
        Assert.Equal(201,(await a.Post("/api/seller/register",new { display_name="Big Document Store" })).Status);
        var data = new byte[5*1024*1024+1]; Encoding.ASCII.GetBytes("%PDF-1.4").CopyTo(data,0);
        var r = await Upload(a,"pan_card",data);
        Assert.Equal(400,r.Status); Assert.Equal("file_too_large",r.ErrorCode);
        Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM seller_documents"));
    }

}
