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
        Assert.True((await admin.Delete("/api/admin/assistant/uploads/"+Guid.NewGuid())).Json["ok"]!.GetValue<bool>());var conv=await admin.Post("/api/admin/assistant/conversations",new{title="Synthetic files"});var cid=conv.Json["id"]!.GetValue<string>();var answer=await admin.Post("/api/admin/assistant/conversations/"+cid+"/messages",new{text="Read this file",upload_ids=new[]{id,"invalid",Guid.NewGuid().ToString()}});Assert.True(answer.Status==200,answer.ToString());Assert.Contains("file_overview",answer.Text);Assert.Contains("file_analysis",answer.Text);Assert.Contains("Amount (2)",answer.Text);var saved=await admin.Get("/api/admin/assistant/conversations/"+cid);Assert.Equal("files",saved.Json["messages"]![0]!["blocks"]![0]!["type"]!.GetValue<string>());Assert.Single(saved.Json["messages"]![0]!["blocks"]![0]!["items"]!.AsArray());
        await admin.Delete("/api/admin/assistant/uploads/"+id);
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
        r=await Upload("plain.json","{\"title\":\"Tamil தமிழ்\",\"items\":[1,2]}");Assert.Equal("{\n \"title\": \"Tamil தமிழ்\",\n \"items\": [\n  1,\n  2\n ]\n}",r.Json["preview"]!.GetValue<string>());
        r=await Upload("blank-header.csv","\n1,2\n");Assert.Equal("Column 1",r.Json["columns"]![0]!["name"]!.GetValue<string>());Assert.Equal(1,r.Json["rows"]!.GetValue<int>());r=await Upload("quotes.csv","a,b\n\"multi\nline\",\"quote\"\"inside\"\n");Assert.Equal("multi\nline",r.Json["first_rows"]![0]!["a"]!.GetValue<string>());
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
        var admin=await Admin();using var memory=new MemoryStream();using(var zip=new ZipArchive(memory,ZipArchiveMode.Create,true)){void Entry(string path,string content){using var w=new StreamWriter(zip.CreateEntry(path).Open());w.Write(content);}Entry("xl/workbook.xml","<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Synthetic\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");Entry("xl/_rels/workbook.xml.rels","<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Target=\"worksheets/sheet2.xml\"/></Relationships>");Entry("xl/styles.xml","<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><cellXfs count=\"2\"><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/></cellXfs></styleSheet>");Entry("xl/worksheets/sheet2.xml","<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Amount</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>Date</t></is></c></row><row r=\"2\"><c r=\"A2\"><f>1+2</f><v>7</v></c><c r=\"B2\" s=\"1\"><v>1</v></c></row></sheetData></worksheet>");}var r=await admin.Post("/api/admin/assistant/uploads",File("synthetic.xlsx",memory.ToArray()));
        Assert.True(r.Status==201,r.ToString());
        Assert.Equal("7",r.Json["columns"]![0]!["sum"]!.GetValue<string>());Assert.Equal("1900-01-01T00:00:00",r.Json["first_rows"]![0]!["Date"]!.GetValue<string>());
        Assert.Equal(1,r.Json["rows"]!.GetValue<int>());
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Excel_time_duration_epoch_and_millisecond_values_are_exact(bool epoch1904)
    {
        var admin = await Admin();
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
        {
            void Entry(string path, string content) { using var w = new StreamWriter(zip.CreateEntry(path).Open()); w.Write(content); }
            Entry("xl/workbook.xml", "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><workbookPr date1904=\"" + (epoch1904 ? "1" : "0") + "\"/><sheets><sheet name=\"Synthetic\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
            Entry("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>");
            Entry("xl/styles.xml", "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts><numFmt numFmtId=\"164\" formatCode=\"[h]:mm:ss\"/></numFmts><cellXfs><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/><xf numFmtId=\"20\"/><xf numFmtId=\"164\"/></cellXfs></styleSheet>");
            Entry("xl/worksheets/sheet1.xml", "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Value</t></is></c></row><row r=\"2\"><c r=\"A2\" s=\"2\"><v>0.5</v></c></row><row r=\"3\"><c r=\"A3\" s=\"3\"><v>1.5</v></c></row><row r=\"4\"><c r=\"A4\" s=\"1\"><v>1</v></c></row><row r=\"5\"><c r=\"A5\" s=\"1\"><v>1.12345678</v></c></row><row r=\"6\"><c r=\"A6\" s=\"3\"><v>-0.5</v></c></row></sheetData></worksheet>");
        }
        var r = await admin.Post("/api/admin/assistant/uploads", File("time.xlsx", memory.ToArray()));
        Assert.True(r.Status == 201, r.ToString());
        var rows = r.Json["first_rows"]!;
        Assert.Equal("12:00:00", rows[0]!["Value"]!.GetValue<string>());
        Assert.Equal("1 day, 12:00:00", rows[1]!["Value"]!.GetValue<string>());
        Assert.Equal(epoch1904 ? "1904-01-02T00:00:00" : "1900-01-01T00:00:00", rows[2]!["Value"]!.GetValue<string>());
        Assert.Equal(epoch1904 ? "1904-01-02T02:57:46.666000" : "1900-01-01T02:57:46.666000", rows[3]!["Value"]!.GetValue<string>());
        Assert.Equal("-1 day, 12:00:00", rows[4]!["Value"]!.GetValue<string>());
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Excel_sparse_header_keeps_declared_columns_and_missing_first_row(bool missingFirstRow)
    {
        var admin = await Admin(); using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
        {
            void Entry(string path, string content) { using var w = new StreamWriter(zip.CreateEntry(path).Open()); w.Write(content); }
            Entry("xl/workbook.xml", "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Synthetic\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
            Entry("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>");
            var first = missingFirstRow ? "" : "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Name</t></is></c></row>";
            Entry("xl/worksheets/sheet1.xml", "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:C3\"/><sheetData>" + first + "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>Synthetic value</t></is></c></row></sheetData></worksheet>");
        }
        var r = await admin.Post("/api/admin/assistant/uploads", File("sparse.xlsx", memory.ToArray()));
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(1, r.Json["rows"]!.GetValue<int>());
        Assert.Equal(3, r.Json["columns"]!.AsArray().Count);
        Assert.Equal(missingFirstRow ? "Column 1" : "Name", r.Json["columns"]![0]!["name"]!.GetValue<string>());
        Assert.Equal("Column 3", r.Json["columns"]![2]!["name"]!.GetValue<string>());
        Assert.Equal("Synthetic value", r.Json["first_rows"]![0]![missingFirstRow ? "Column 1" : "Name"]!.GetValue<string>());
    }
    [Theory]
    [InlineData(50000, false)]
    [InlineData(50001, true)]
    public async Task Csv_row_and_column_caps_are_exact(int count, bool truncated)
    {
        var admin = await Admin();
        var csv = "x\n" + string.Concat(Enumerable.Repeat("1\n", count));
        var r = await admin.Post("/api/admin/assistant/uploads", File("caps.csv", Encoding.UTF8.GetBytes(csv)));
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(50000, r.Json["rows"]!.GetValue<int>());
        Assert.Equal(truncated, r.Json["truncated"]!.GetValue<bool>());
        Assert.Single(r.Json["columns"]!.AsArray());
        Assert.Equal("50000", r.Json["columns"]![0]!["sum"]!.GetValue<string>());
    }
}
