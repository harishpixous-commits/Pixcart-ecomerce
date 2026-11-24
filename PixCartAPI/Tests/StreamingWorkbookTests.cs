using System.IO.Compression;
using System.Xml.Linq;
using ClosedXML.Excel;
using Utils;
namespace Tests;
public class StreamingWorkbookTests
{
    [Fact]
    public async Task Streaming_workbook_preserves_typed_cells_styles_freeze_filter_and_about()
    {
        static async IAsyncEnumerable<IReadOnlyList<object?>> Rows(){yield return new object?[]{"123.45","9","9876543210123456","=SUM(A1)",true,"0.1234","line\ntext"};await Task.Yield();yield return new object?[]{"'+FORMULA","01234567890",null,-2,1.5,"clean\u0001text","  spaces  "};}
        await using var file=await StreamingWorkbook.BuildAsync("Unsafe/name",["Amount","Count","Phone","Formula","Boolean","Decimal","Text"],Rows(),"Synthetic streaming",[("Filter","Synthetic")]);
        var path=file.Name;Assert.True(File.Exists(path));
        using(var book=new XLWorkbook(file))
        {
            var s=book.Worksheet(1);Assert.Equal("Unsafe name",s.Name);Assert.Equal(123.45,s.Cell(2,1).GetDouble());Assert.Equal(9,s.Cell(2,2).GetDouble());Assert.Equal("9876543210123456",s.Cell(2,3).GetString());Assert.Equal(XLDataType.Text,s.Cell(2,3).DataType);Assert.False(s.Cell(2,4).HasFormula);Assert.Equal("=SUM(A1)",s.Cell(2,4).GetString());Assert.Equal("yes",s.Cell(2,5).GetString());Assert.Equal(0.1234,s.Cell(2,6).GetDouble());Assert.Equal("+FORMULA",s.Cell(3,1).GetString());Assert.Equal("01234567890",s.Cell(3,2).GetString());Assert.Equal(-2,s.Cell(3,4).GetDouble());Assert.Equal("cleantext",s.Cell(3,6).GetString());Assert.Equal("  spaces  ",s.Cell(3,7).GetString());Assert.Equal(1,s.SheetView.SplitRow);Assert.True(s.AutoFilter.IsEnabled);Assert.True(s.Cell(1,1).Style.Font.Bold);Assert.Equal(4,s.Cell(2,1).Style.NumberFormat.NumberFormatId);Assert.Equal("2",book.Worksheet("About").Cell(3,2).GetString());
        }
        if(Environment.GetEnvironmentVariable("PIXCART_XLSX_DIAGNOSTICS")=="1"){file.Position=0;await using var target=File.Create("/tmp/pixcart-streaming84.xlsx");await file.CopyToAsync(target);}
        await file.DisposeAsync();Assert.False(File.Exists(path));
    }
    [Fact]
    public async Task Streaming_workbook_consumes_100001_rows_once_without_shared_string_accumulation()
    {
        var consumed=0;async IAsyncEnumerable<IReadOnlyList<object?>> Rows(){for(var i=0;i<100001;i++){consumed++;yield return new object?[]{i,"Synthetic unique "+i,"=NOT_A_FORMULA"};if(i%1000==0)await Task.Yield();}}
        await using var file=await StreamingWorkbook.BuildAsync("Rows",["Count","Text","Formula"],Rows(),"Synthetic large",[]);Assert.Equal(100001,consumed);Assert.True(file.Length>100000);
        using var zip=new ZipArchive(file,ZipArchiveMode.Read,leaveOpen:true);Assert.Null(zip.GetEntry("xl/sharedStrings.xml"));
        using var input=zip.GetEntry("xl/worksheets/sheet1.xml")!.Open();using var reader=System.Xml.XmlReader.Create(input);var count=0;string? filter=null;while(reader.Read()){if(reader.NodeType==System.Xml.XmlNodeType.Element&&reader.LocalName=="row")count++;if(reader.LocalName=="autoFilter")filter=reader.GetAttribute("ref");}Assert.Equal(100002,count);Assert.Equal("A1:C100002",filter);
    }
    [Fact]
    public async Task Empty_and_cancelled_streams_have_header_or_cleanup()
    {
        static async IAsyncEnumerable<IReadOnlyList<object?>> Empty(){await Task.Yield();yield break;}
        await using(var file=await StreamingWorkbook.BuildAsync("Empty",["Header"],Empty(),"Synthetic",[])){using var book=new XLWorkbook(file);Assert.Equal("Header",book.Worksheet(1).Cell(1,1).GetString());Assert.Equal("0",book.Worksheet("About").Cell(2,2).GetString());}
        using var cts=new CancellationTokenSource();cts.Cancel();await Assert.ThrowsAnyAsync<OperationCanceledException>(()=>StreamingWorkbook.BuildAsync("Cancel",["Header"],Empty(),"Synthetic",[],cts.Token));
    }
}
