namespace Tests;
public class CmsMediaTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Cms_media_sniffs_content_filters_sorts_and_rolls_back_db_with_audit()
    {
        var admin=await Admin();var support=await Staff(admin,"mediasupport@example.test","support");Assert.Equal(403,(await support.Get("/api/admin/media")).Status);
        static MultipartFormDataContent Body(byte[] b,string name){var form=new MultipartFormDataContent();form.Add(new ByteArrayContent(b),"file",name);return form;}
        using var bitmap=new SkiaSharp.SKBitmap(200,200);bitmap.Erase(SkiaSharp.SKColors.Blue);using var image=SkiaSharp.SKImage.FromBitmap(bitmap);using var encoded=image.Encode(SkiaSharp.SKEncodedImageFormat.Png,100);var png=encoded.ToArray();
        var r=await admin.Post("/api/admin/media",Body(png,"not-a-video.mp4"));Assert.True(r.Status==201,r.ToString());Assert.Equal("image",r.Json["kind"]!.GetValue<string>());Assert.Equal("not-a-video.mp4",r.Json["label"]!.GetValue<string>());Assert.EndsWith(".webp",r.Json["url"]!.GetValue<string>());
        byte[] mp4=[0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0,0,0,0];r=await admin.Post("/api/admin/media?label="+new string('a',130),Body(mp4,"actually-video.jpg"));Assert.True(r.Status==201,r.ToString());Assert.Equal("video",r.Json["kind"]!.GetValue<string>());Assert.Equal(120,r.Json["label"]!.GetValue<string>().Length);var videoId=r.Json["id"]!.GetValue<string>();
        var mov=(byte[])mp4.Clone();System.Text.Encoding.ASCII.GetBytes("qt  ").CopyTo(mov,8);Assert.Equal("invalid_video",(await admin.Post("/api/admin/media",Body(mov,"not-mp4.mov"))).ErrorCode);Assert.Equal("invalid_video",(await admin.Post("/api/admin/media",Body([0x1A,0x45,0xDF,0xA3,0,0,0,0],"matroska.webm"))).ErrorCode);
        byte[] webm=[0x1A,0x45,0xDF,0xA3,0x77,0x65,0x62,0x6d];Assert.Equal(("video/webm","webm"),Utils.ImageUpload.SniffVideo(webm));
        r=await admin.Get("/api/admin/media");Assert.Equal(2,r.Json.AsArray().Count);Assert.Equal(videoId,r.Json[0]!["id"]!.GetValue<string>());Assert.Single((await admin.Get("/api/admin/media?kind=image")).Json.AsArray());Assert.Single((await admin.Get("/api/admin/media?kind=video")).Json.AsArray());Assert.Equal(422,(await admin.Get("/api/admin/media?kind=audio")).Status);Assert.Equal("invalid_image",(await admin.Post("/api/admin/media",Body([0,1,2,3],"bad.png"))).ErrorCode);
        await ApiFactory.DbExecAsync("INSERT INTO media_assets(id,url,label,created_at)VALUES(UUID(),'/media/UPPER.WEBM?x=1','Synthetic query URL',UTC_TIMESTAMP(6))");Assert.Equal(2,(await admin.Get("/api/admin/media?kind=video")).Json.AsArray().Count);
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_media_fail BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='storefront.media_upload' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic media rollback'; END IF; END");try{Assert.Equal(500,(await admin.Post("/api/admin/media",Body(png,"rollback.png"))).Status);Assert.Equal(3,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM media_assets"));}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_media_fail");}Assert.Equal(2,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='storefront.media_upload'"));
    }
}
