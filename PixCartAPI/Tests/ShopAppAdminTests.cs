using System.IO.Compression;
namespace Tests;
public class ShopAppAdminTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Shop_app_upload_validates_APK_saves_settings_and_atomic_audit()
    {
        var admin=await Admin();var support=await Staff(admin,"apksupport@example.test","support");static MultipartFormDataContent Body(byte[] bytes){var f=new MultipartFormDataContent();f.Add(new ByteArrayContent(bytes),"file","synthetic.apk");return f;}
        byte[] apk;using(var stream=new MemoryStream()){using(var zip=new ZipArchive(stream,ZipArchiveMode.Create,true)){using(var writer=new StreamWriter(zip.CreateEntry("AndroidManifest.xml").Open()))writer.Write("Synthetic manifest");using(var writer=new StreamWriter(zip.CreateEntry("classes.dex").Open()))writer.Write("Synthetic dex");}apk=stream.ToArray();}
        Assert.Equal(403,(await support.Post("/api/admin/shop-app",Body(apk))).Status);Assert.Equal("invalid_apk",(await admin.Post("/api/admin/shop-app",Body([0,1,2,3]))).ErrorCode);Assert.Equal("invalid_version",(await admin.Post("/api/admin/shop-app?version=bad%2Fversion",Body(apk))).ErrorCode);Assert.Equal(422,(await admin.Post("/api/admin/shop-app?version="+new string('a',21),Body(apk))).Status);
        var r=await admin.Post("/api/admin/shop-app?version=%201.2.3%2Btest%20",Body(apk));Assert.True(r.Status==200,r.ToString());Assert.Equal("1.2.3+test",r.Json["settings"]!["shop_app_version"]!.GetValue<string>());var url=r.Json["settings"]!["shop_android_apk_url"]!.GetValue<string>();Assert.StartsWith("/media/apps/pixcart-shop-1.2.3-test-",url);Assert.Equal(apk.Length,r.Json["size"]!.GetValue<int>());Assert.Equal(1,await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM audit_logs WHERE action='settings.shop_app_upload'"));
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_apk_fail BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='settings.shop_app_upload' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic APK rollback'; END IF; END");try{Assert.Equal(500,(await admin.Post("/api/admin/shop-app?version=2.0",Body(apk))).Status);Assert.Equal(url,(await admin.Get("/api/admin/settings")).Json["shop_android_apk_url"]!.GetValue<string>());}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_apk_fail");}
        r=await admin.Post("/api/admin/shop-app",Body(apk));Assert.Equal("1.2.3+test",r.Json["settings"]!["shop_app_version"]!.GetValue<string>());Assert.StartsWith("/media/apps/pixcart-shop-",r.Json["settings"]!["shop_android_apk_url"]!.GetValue<string>());
    }
}
