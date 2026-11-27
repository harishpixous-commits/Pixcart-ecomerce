using System.Net.Http.Headers;
using System.IO.Compression;
using System.Net.Http.Json;
using System.Text;
using ClosedXML.Excel;
using DAL;
using Model.DomainModel;
using Utils.Interface;
using Microsoft.Extensions.DependencyInjection;
using Utils;
namespace Tests;
public class ExportRoutesTests(ApiFactory f):ApiTest(f)
{
    private async Task<byte[]> Download(Api user,string path,string media,string filename)
    {
        using var client=Factory.CreateClient();using var req=new HttpRequestMessage(HttpMethod.Get,path);req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",user.Token);using var res=await client.SendAsync(req);var bytes=await res.Content.ReadAsByteArrayAsync();Assert.True((int)res.StatusCode==200,Encoding.UTF8.GetString(bytes));Assert.Equal(media,res.Content.Headers.ContentType!.MediaType);Assert.True(res.Headers.CacheControl!.NoStore);Assert.Equal("nosniff",res.Headers.GetValues("X-Content-Type-Options").Single());Assert.Equal(filename,res.Content.Headers.ContentDisposition!.FileName!.Trim('"'));return bytes;
    }
    [Fact]
    public async Task Lists_permissions_lookups_and_all_formats_execute_for_each_spec()
    {
        var admin=await Admin();var support=await Staff(admin,"export-support@example.test");var user=await LoginPhone("9876100087");var seller=Guid.Parse((await user.Post("/api/seller/register",new{display_name="Synthetic Export Routes"})).Json["id"]!.GetValue<string>());
        Assert.Equal(17,(await admin.Get("/api/admin/exports")).Json["items"]!.AsArray().Count);Assert.Equal(8,(await user.Get("/api/seller/exports")).Json["items"]!.AsArray().Count);Assert.Equal(403,(await user.Get("/api/admin/exports")).Status);Assert.Equal(403,(await admin.Get("/api/seller/exports")).Status);
        Assert.DoesNotContain((await support.Get("/api/admin/exports")).Json["items"]!.AsArray(),i=>i!["name"]!.GetValue<string>()=="payouts");Assert.Equal(403,(await support.Get("/api/admin/exports/payouts.csv")).Status);Assert.Equal(200,(await support.Get("/api/admin/exports/lookup/category")).Status);
        Assert.Equal(404,(await admin.Get("/api/admin/exports/missing.csv")).Status);Assert.Equal(404,(await admin.Get("/api/admin/exports/orders.exe")).Status);Assert.Equal(400,(await admin.Get("/api/admin/exports/orders.csv?status=pending_payment")).Status);Assert.Equal(400,(await admin.Get("/api/admin/exports/products.csv?payment_method=cod")).Status);Assert.Equal(422,(await admin.Get("/api/admin/exports/products.csv?low_stock=-1")).Status);
        Assert.Single((await admin.Get("/api/admin/exports/lookup/seller?q=Synthetic")).Json["items"]!.AsArray());Assert.Equal(404,(await admin.Get("/api/admin/exports/lookup/unknown")).Status);Assert.Equal(200,(await user.Get("/api/seller/exports/lookup/category")).Status);
        using var scope=Factory.Services.CreateScope();await scope.ServiceProvider.GetRequiredService<SettingsDAL>().SaveAsync("site",new System.Text.Json.Nodes.JsonObject{["brand_name"]="Synthetic"});
        foreach(var spec in ExportDefinitions.All)
        {
            var actor=spec.Scope=="admin"?admin:user;var root="/api/"+spec.Scope+"/exports/"+spec.Name;var dates=spec.NeedsMonth?"?month=2026-11":"?from=2026-11-01&to=2026-11-01";var period=spec.NeedsMonth?"2026-11":spec.DateLabel.Length>0?"2026-11-01-to-2026-11-01":ExportDefinitions.PeriodLabel(ExportDefinitions.Parse(spec));
            var csv=await Download(actor,root+".csv"+dates,"text/csv","synthetic-"+spec.Name+"-"+period+".csv");Assert.Equal(new byte[]{0xef,0xbb,0xbf},csv.Take(3));Assert.Contains(spec.Headers[0],Encoding.UTF8.GetString(csv));
            // Rate limits are tested separately; keep each format loop independent.
            await ApiFactory.DbExecAsync("DELETE FROM rate_limit_events WHERE `key`=@key",new{key="export:"+actor.Id});
            var xlsx=await Download(actor,root+".xlsx"+dates,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","synthetic-"+spec.Name+"-"+period+".xlsx");using var book=new XLWorkbook(new MemoryStream(xlsx));Assert.Equal(spec.Headers[0],book.Worksheet(1).Cell(1,1).GetString());Assert.Contains(book.Worksheets,w=>w.Name=="About");
            var pdf=await Download(actor,root+".pdf"+dates,"application/pdf","synthetic-"+spec.Name+"-"+period+".pdf");Assert.Equal("%PDF",Encoding.ASCII.GetString(pdf,0,4));
        }
        Assert.Equal(75,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action LIKE 'export.%'"));
    }
    [Fact]
    public async Task Selected_columns_keep_source_order_audit_and_rate_limit_are_atomic()
    {
        var admin=await Admin();Assert.Equal(400,(await admin.Get("/api/admin/exports/orders.csv?columns=NoSuchColumn")).Status);Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM rate_limit_events WHERE `key`=@key",new{key="export:"+admin.Id}));
        var bytes=await Download(admin,"/api/admin/exports/orders.csv?from=2026-11-01&to=2026-11-01&columns=Order&columns=Package&columns=Order","text/csv","pixcart-orders-2026-11-01-to-2026-11-01.csv");Assert.Equal("\ufeffPackage,Order\r\n",Encoding.UTF8.GetString(bytes));
        for(var i=1;i<30;i++)await ApiFactory.DbExecAsync("INSERT INTO rate_limit_events(`key`,created_at)VALUES(@key,UTC_TIMESTAMP(6))",new{key="export:"+admin.Id});Assert.Equal(429,(await admin.Get("/api/admin/exports/orders.csv")).Status);Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='export.orders'"));
    }
    [Fact]
    public void Csv_has_formula_guard_cr_normalization_boolean_and_rowcap_selection()
    {
        var csv=Encoding.UTF8.GetString(ExportCsv.Encode([new object?[]{"=SUM(A1)","+12","-12.3","-cmd","@bad","\tbad","a\r\nb\rc\nd",true,null}]));Assert.Equal("'=SUM(A1),'+12,-12.3,'-cmd,'@bad,'\tbad,\"a b c\nd\",yes,\r\n",csv);Assert.Equal(new object?[]{"cap note"},ExportCsv.Pick(new object?[]{"cap note"},new[]{2,3}));
    }
    [Fact]
    public async Task Bulk_validates_all_plans_first_and_streams_numbered_formats_manifest_and_one_audit()
    {
        var admin=await Admin();var invalid=await admin.Post("/api/admin/exports/bulk",new{items=new[]{new{name="orders",format="csv"},new{name="missing",format="csv"}}});Assert.Equal(404,invalid.Status);Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='export.bulk'"));
        Assert.Equal(422,(await admin.Post("/api/admin/exports/bulk",new{items=Array.Empty<object>()})).Status);
        using var client=Factory.CreateClient();using var request=new HttpRequestMessage(HttpMethod.Post,"/api/admin/exports/bulk");request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",admin.Token);
        request.Content=JsonContent.Create(new{items=new object[]{new{name="orders",format="csv",@from="2026-11-01",to="2026-11-02",columns=new[]{"Order","Package"}},new{name="stock",format="xlsx",date_from="2026-11-01",date_to="2026-11-02"},new{name="tcs",format="pdf",month="2026-11"}}});
        using var response=await client.SendAsync(request);var bytes=await response.Content.ReadAsByteArrayAsync();Assert.True((int)response.StatusCode==200,Encoding.UTF8.GetString(bytes));Assert.Equal("application/zip",response.Content.Headers.ContentType!.MediaType);Assert.True(response.Headers.CacheControl!.NoStore);
        using var zip=new ZipArchive(new MemoryStream(bytes),ZipArchiveMode.Read);Assert.Equal(4,zip.Entries.Count);Assert.Contains(zip.Entries,e=>e.FullName=="1-pixcart-orders-2026-11-01-to-2026-11-02.csv");Assert.Contains(zip.Entries,e=>e.FullName.StartsWith("2-pixcart-stock-")&&e.FullName.EndsWith(".xlsx"));Assert.Contains(zip.Entries,e=>e.FullName=="3-pixcart-tcs-2026-11.pdf");
        using var csvReader=new StreamReader(zip.GetEntry("1-pixcart-orders-2026-11-01-to-2026-11-02.csv")!.Open());Assert.Equal("Package,Order\r\n",await csvReader.ReadToEndAsync());using var manifestReader=new StreamReader(zip.GetEntry("MANIFEST.csv")!.Open());var manifest=await manifestReader.ReadToEndAsync();Assert.Contains("#,File,Export,Format,Filters",manifest);Assert.Contains("01 Nov 2026 to 02 Nov 2026",manifest);
        Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='export.bulk'"));Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM rate_limit_events WHERE `key`=@key",new{key="export:"+admin.Id}));
    }

    [Fact]
    public async Task Nonempty_orders_TCS_and_seller_csv_xlsx_pdf_preserve_scope_and_figures()
    {
        var admin=await Admin();var user=await LoginPhone("9876100088");var seller=Guid.Parse((await user.Post("/api/seller/register",new{display_name="Synthetic Export Evidence"})).Json["id"]!.GetValue<string>());var other=await LoginPhone("9876100089");await other.Post("/api/seller/register",new{display_name="Synthetic Other"});
        await ApiFactory.DbExecAsync("UPDATE sellers SET legal_name='Synthetic Export Legal',gstin='33ABCDE1234F1Z0' WHERE id=@seller",new{seller});
        using var scope=Factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();var orders=scope.ServiceProvider.GetRequiredService<OrdersDAL>();var at=new DateTime(2026,10,31,18,30,0);var oid=Guid.NewGuid();var sub=Guid.NewGuid();
        await using(var tx=await db.BeginAsync())
        {
            await orders.InsertOrderAsync(new(){Id=oid,UserId=Guid.Parse(user.Id),Number="EXPORT-EVIDENCE-O",Status="placed",PaymentMethod="cod",PaymentStatus="cod",ShipTo="{\"state_code\":\"33\"}",ItemsTotal=10500,GrandTotal=10500,Currency="INR",FxRate=1,Fees="[]",IdempotencyKey=Guid.NewGuid().ToString(),CreatedAt=at,PlacedAt=at,UpdatedAt=at},tx);
            await orders.InsertSubOrderAsync(new(){Id=sub,OrderId=oid,SellerId=seller,Number="EXPORT-EVIDENCE-P",Status="delivered",SettlementStatus="not_due",ItemsTotal=10500,Total=10500,TaxableTotal=10000,TcsPaise=101,CreatedAt=at,UpdatedAt=at},tx);await tx.CommitAsync();
        }
        var tail="?from=2026-11-01&to=2026-11-01&columns=Package&columns=Package%20total&columns=Placed%20(IST)";
        var csv=await Download(user,"/api/seller/exports/orders.csv"+tail,"text/csv","pixcart-orders-2026-11-01-to-2026-11-01.csv");Assert.Equal("\ufeffPackage,Placed (IST),Package total\r\nEXPORT-EVIDENCE-P,2026-11-01 00:00,105.00\r\n",Encoding.UTF8.GetString(csv));
        var empty=await Download(other,"/api/seller/exports/orders.csv"+tail+"&seller="+seller,"text/csv","pixcart-orders-2026-11-01-to-2026-11-01.csv");Assert.DoesNotContain("EXPORT-EVIDENCE-P",Encoding.UTF8.GetString(empty));
        var xlsx=await Download(user,"/api/seller/exports/orders.xlsx"+tail,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","pixcart-orders-2026-11-01-to-2026-11-01.xlsx");using(var workbook=new XLWorkbook(new MemoryStream(xlsx))){Assert.Equal("EXPORT-EVIDENCE-P",workbook.Worksheet(1).Cell(2,1).GetString());Assert.Equal(105,workbook.Worksheet(1).Cell(2,3).GetDouble());}
        var pdf=await Download(user,"/api/seller/exports/orders.pdf"+tail,"application/pdf","pixcart-orders-2026-11-01-to-2026-11-01.pdf");
        var tcs=await Download(admin,"/api/admin/exports/tcs.csv?month=2026-11","text/csv","pixcart-tcs-2026-11.csv");Assert.Contains("33ABCDE1234F1Z0,Synthetic Export Legal,1,0.00,100.00,0.00,0.50,0.51",Encoding.UTF8.GetString(tcs));
        if(Environment.GetEnvironmentVariable("PIXCART_EXPORT_DIAGNOSTICS")=="1"){await File.WriteAllBytesAsync("/tmp/pixcart-export87.pdf",pdf);await File.WriteAllBytesAsync("/tmp/pixcart-export87.xlsx",xlsx);}
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_export_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='export.orders' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic export audit failure'; END IF; END");
        var before=await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM rate_limit_events WHERE `key`=@key",new{key="export:"+user.Id});try{Assert.Equal(500,(await user.Get("/api/seller/exports/orders.csv"+tail)).Status);Assert.Equal(before,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM rate_limit_events WHERE `key`=@key",new{key="export:"+user.Id}));}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_export_audit_failure");}
    }

}
