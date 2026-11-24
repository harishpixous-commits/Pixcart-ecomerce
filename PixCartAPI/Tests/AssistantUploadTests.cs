using System.Text;
using System.IO.Compression;
namespace Tests;
public class AssistantUploadTests(ApiFactory f):ApiTest(f)
{
    private static MultipartFormDataContent File(string name,byte[] bytes){var form=new MultipartFormDataContent();form.Add(new ByteArrayContent(bytes),"file",name);return form;}
    [Fact]public async Task Upload_profiles_exact_decimals_headers_dates_text_json_limits_ownership_and_audit_rollback()
    {
        var admin=await Admin();var user=await LoginPhone("9890000110");
        Assert.Equal(403,(await user.Post("/api/admin/assistant/uploads",File("a.csv",Encoding.UTF8.GetBytes("a\n1")))).Status);async Task<Res> Upload(string name,string text)=>await admin.Post("/api/admin/assistant/uploads",File(name,Encoding.UTF8.GetBytes(text)));var r=await Upload("synthetic.csv","Name,Amount,Amount,,Date\nA,₹1.20,2,,2026-11-24\nB,(0.20),4,,2026-11-25\nA,2.00,6,,2026-11-26");
        Assert.True(r.Status==201,r.ToString());
        Assert.Equal(3,r.Json["rows"]!.GetValue<int>());
        Assert.Equal("3.00",r.Json["columns"]![1]!["sum"]!.GetValue<string>());
        Assert.Equal("1.00",r.Json["columns"]![1]!["average"]!.GetValue<string>());
        Assert.Equal("Amount (2)",r.Json["columns"]![2]!["name"]!.GetValue<string>());
        Assert.Equal("Column 4",r.Json["columns"]![3]!["name"]!.GetValue<string>());
        Assert.Equal("date",r.Json["columns"]![4]!["type"]!.GetValue<string>());var id=r.Json["id"]!.GetValue<string>();
        Assert.Equal(1,await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM assistant_uploads WHERE id=@id AND DATEDIFF(expires_at,created_at)=7 AND row_count=3",new{id}));
        Assert.Equal(403,(await user.Delete("/api/admin/assistant/uploads/"+id)).Status);
        Assert.True((await admin.Delete("/api/admin/assistant/uploads/"+Guid.NewGuid())).Json["ok"]!.GetValue<bool>());await admin.Delete("/api/admin/assistant/uploads/"+id);
        Assert.Equal(0,await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM assistant_uploads WHERE id=@id",new{id}));
        r=await Upload("a.tsv","x\ty\n1\t2\n3\t4");Assert.True(r.Status==201,r.ToString());
        Assert.Equal(2,r.Json["rows"]!.GetValue<int>());
        r=await Upload("a.json","[{\"a\":1,\"b\":{\"nested\":true}},{\"a\":2,\"c\":\"later\"}]");
        Assert.Equal("3",r.Json["columns"]![0]!["sum"]!.GetValue<string>());
        Assert.Equal(3,r.Json["columns"]!.AsArray().Count);
        r=await Upload("a.md",new string('x',200001));Assert.True(r.Status==201,r.ToString());
        Assert.True(r.Json["truncated"]!.GetValue<bool>());
        Assert.Equal(200000,r.Json["characters"]!.GetValue<int>());
        Assert.Equal(3000,r.Json["preview"]!.GetValue<string>().Length);
        Assert.Equal("bad_upload",(await Upload("a.json","invalid")).ErrorCode);
        Assert.Equal("bad_upload",(await Upload("a.xlsm","invalid")).ErrorCode);
        Assert.Equal("bad_upload",(await Upload("a.xlsx","invalid")).ErrorCode);
        Assert.Equal("bad_upload",(await admin.Post("/api/admin/assistant/uploads",File("big.txt",new byte[5*1024*1024+1]))).ErrorCode);
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_upload_fail BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='assistant.upload' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic upload rollback'; END IF; END");try{var before=await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM assistant_uploads");
        Assert.Equal(500,(await Upload("rollback.txt","Synthetic data")).Status);
        Assert.Equal(before,await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM assistant_uploads"));}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_upload_fail");}
    }
    [Fact]public async Task Xlsx_uses_first_sheet_and_cached_formula_not_expression()
    {
        var admin=await Admin();using var memory=new MemoryStream();using(var zip=new ZipArchive(memory,ZipArchiveMode.Create,true)){void Entry(string path,string content){using var w=new StreamWriter(zip.CreateEntry(path).Open());w.Write(content);}Entry("xl/workbook.xml","<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Synthetic\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");Entry("xl/_rels/workbook.xml.rels","<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Target=\"worksheets/sheet2.xml\"/></Relationships>");Entry("xl/worksheets/sheet2.xml","<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Amount</t></is></c></row><row r=\"2\"><c r=\"A2\"><f>1+2</f><v>7</v></c></row></sheetData></worksheet>");}var r=await admin.Post("/api/admin/assistant/uploads",File("synthetic.xlsx",memory.ToArray()));
        Assert.True(r.Status==201,r.ToString());
        Assert.Equal("7",r.Json["columns"]![0]!["sum"]!.GetValue<string>());
        Assert.Equal(1,r.Json["rows"]!.GetValue<int>());
    }
}
