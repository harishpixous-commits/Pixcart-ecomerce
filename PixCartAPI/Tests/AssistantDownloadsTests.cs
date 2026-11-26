using System.Text;
using System.Text.Json.Nodes;
using ClosedXML.Excel;
using Utils;
namespace Tests;
public class AssistantDownloadsTests
{
    private static List<JsonObject> Messages() => [JsonNode.Parse("""
        {"role":"user","text":"Saved question","blocks":[]}
        """)!.AsObject(), JsonNode.Parse("""
        {"role":"assistant","text":"ignored raw answer","blocks":[
          {"type":"text","text":"Saved **bold** answer ₹123.45"},
          {"type":"table","title":"Sales","columns":["Name","Amount"],"rows":[["=BAD",123.45],["-7",null],["-cmd","line\nbreak"]]},
          {"type":"metrics","title":"Summary","items":[{"label":"Revenue","value":"₹123.45","hint":"Saved only"},{"label":"Orders","value":"2"}]},
          {"type":"chart","title":"Trend","kind":"bar","labels":["Mon","Tue","Wed"],"series":[{"name":"Current","values":[4,-2,9]},{"name":"Previous","values":[2,3]}]},
          {"type":"action","summary":"Saved action","status":"pending"},
          {"type":"file","title":"Saved file","format":"csv","detail":"Details"},
          {"type":"error","text":"Saved warning"}
        ]}
        """)!.AsObject()];
    [Fact]
    public void Json_and_markdown_preserve_saved_roles_blocks_and_action_status()
    {
        var messages = Messages(); var json = JsonNode.Parse(AssistantDownloads.Build("json", messages, "Synthetic", "Brand"))!;
        Assert.Equal("Saved question", json["messages"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("pending", json["messages"]![1]!["blocks"]![4]!["status"]!.GetValue<string>());
        var md = Encoding.UTF8.GetString(AssistantDownloads.Build("md", messages, "Synthetic", "Brand"));
        Assert.Contains("## You\nSaved question", md); Assert.Contains("Saved **bold** answer ₹123.45", md);
        Assert.Contains("| Measure | Value | Note |", md); Assert.Contains("| Wed | 9 |  |", md);
        Assert.Contains("None", md); Assert.Contains("line break", md); Assert.Contains("pending", md);
        Assert.DoesNotContain("ignored raw answer", md);
    }
    [Fact]
    public void Csv_has_bom_multiple_tables_rfc_quoting_and_formula_guard()
    {
        var bytes = AssistantDownloads.Build("csv", Messages(), "Synthetic", "Brand");
        Assert.Equal(new byte[] { 0xef, 0xbb, 0xbf }, bytes.Take(3));
        var csv = Encoding.UTF8.GetString(bytes.Skip(3).ToArray());
        Assert.Contains("Sales\r\nName,Amount\r\n'=BAD,123.45\r\n-7,\r\n'-cmd,\"line\nbreak\"\r\n", csv);
        Assert.Contains("\r\n\r\nSummary\r\nMeasure,Value,Note", csv);
        Assert.Contains("Wed,9,\r\n", csv);
        var noTable = Encoding.UTF8.GetString(AssistantDownloads.Build("csv", [new() { ["role"] = "assistant", ["blocks"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "=source leaves text unguarded" }) }], "", ""));
        Assert.Contains("Text\r\n=source leaves text unguarded\r\n", noTable);
    }
    [Fact]
    public void Workbook_flattens_metrics_charts_and_saved_answer_without_formula_execution()
    {
        using var book = new XLWorkbook(new MemoryStream(AssistantDownloads.Build("xlsx", Messages(), "Synthetic", "Brand")));
        Assert.Equal(new[] { "Sales", "Summary", "Trend", "Answer", "About" }, book.Worksheets.Select(w => w.Name));
        Assert.False(book.Worksheet("Sales").Cell(2, 1).HasFormula);
        Assert.Equal("=BAD", book.Worksheet("Sales").Cell(2, 1).GetString());
        Assert.Equal(123.45, book.Worksheet("Sales").Cell(2, 2).GetDouble());
        Assert.Equal("Saved only", book.Worksheet("Summary").Cell(2, 3).GetString());
        Assert.Equal(9, book.Worksheet("Trend").Cell(4, 2).GetDouble());
        Assert.Equal("Saved **bold** answer ₹123.45", book.Worksheet("Answer").Cell(2, 1).GetString());
    }
    [Theory]
    [InlineData("bar")]
    [InlineData("line")]
    public void Pdf_renders_saved_questions_metrics_charts_and_table(string kind)
    {
        var messages = Messages(); messages[1]["blocks"]![3]!["kind"] = kind;
        var bytes = AssistantDownloads.Build("pdf", messages, "Synthetic saved assistant", "Synthetic brand");
        Assert.StartsWith("%PDF-", Encoding.ASCII.GetString(bytes.Take(8).ToArray()));
        if (Environment.GetEnvironmentVariable("PIXCART_PDF_DIAGNOSTICS") == "1") File.WriteAllBytes("/tmp/pixcart-assistant81-" + kind + ".pdf", bytes);
    }
}
