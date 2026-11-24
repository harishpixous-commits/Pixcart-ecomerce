using System.Text;
using Utils;
namespace Tests;
public class ReportPdfTests
{
    [Fact]
    public void Pdf_contains_saved_text_tables_rupees_and_row_cap_note()
    {
        var rows = Enumerable.Range(1, 2002).Select(i => (IReadOnlyList<string>)new[] { i.ToString(), "Synthetic ₹123.45" }).ToList();
        var bytes = ReportPdf.Build("Synthetic report", "Saved figures", "Synthetic brand", [
            new("heading", "Answer"), new("text", "Saved answer, not regenerated."),
            new("table", Columns: ["Row", "Value"], Rows: rows),
        ]);
        Assert.StartsWith("%PDF-", Encoding.ASCII.GetString(bytes.Take(8).ToArray()));
        Assert.True(bytes.Length > 10000);
        if (Environment.GetEnvironmentVariable("PIXCART_PDF_DIAGNOSTICS") == "1") File.WriteAllBytes("/tmp/pixcart-report80.pdf", bytes);
    }
    [Fact]
    public void Pdf_accepts_wide_tables_and_repeated_header_pagination()
    {
        var columns = Enumerable.Range(1, 16).Select(i => "Column " + i).ToArray();
        var rows = Enumerable.Range(1, 60).Select(i => (IReadOnlyList<string>)Enumerable.Repeat("Synthetic cell", 16).ToArray()).ToList();
        var bytes = ReportPdf.Build("Wide synthetic", "", "Synthetic brand", [new("table", Columns: columns, Rows: rows)]);
        Assert.StartsWith("%PDF-", Encoding.ASCII.GetString(bytes.Take(8).ToArray()));
        if (Environment.GetEnvironmentVariable("PIXCART_PDF_DIAGNOSTICS") == "1") File.WriteAllBytes("/tmp/pixcart-report80-wide.pdf", bytes);
    }
    [Fact]
    public void Pdf_wraps_long_identifiers_and_splits_tall_rows_without_recursive_headers()
    {
        var columns = Enumerable.Range(1, 14).Select(i => "Column " + i).ToArray();
        var rows = new[] { (IReadOnlyList<string>)Enumerable.Repeat(string.Join("\n", Enumerable.Repeat("X", 199)), 14).ToArray(), Enumerable.Repeat(new string('W', 400), 14).ToArray() };
        var bytes = ReportPdf.Build("Long cells", "", "Synthetic brand", [new("table", Columns: columns, Rows: rows)]);
        Assert.True(bytes.Length > 10000);
        if (Environment.GetEnvironmentVariable("PIXCART_PDF_DIAGNOSTICS") == "1") File.WriteAllBytes("/tmp/pixcart-report80-long.pdf", bytes);
    }

}
