using ClosedXML.Excel;
using Utils;
namespace Tests;

public class ReportWorkbookTests
{
    [Fact]
    public void Workbook_keeps_long_identifiers_and_formulas_as_text_and_numbers_typed()
    {
        var bytes = ReportWorkbook.Build([
            new("Unsafe/name", ["Amount", "Count", "Phone", "Formula", "Boolean", "Decimal"],
                new[] { new object?[] { "123.45", "9", "9876543210123456", "=SUM(A1)", true, "0.1234" } }),
            new("Unsafe/name", ["Escaped", "Leading zero", "Control"],
                new[] { new object?[] { "'+FORMULA", "01234567890", "clean\u0001text" } }),
        ], [("Filter", "Synthetic")], "Synthetic workbook");
        using var workbook = new XLWorkbook(new MemoryStream(bytes));
        Assert.Equal(new[] { "Unsafe name", "Unsafe name 2", "About" }, workbook.Worksheets.Select(w => w.Name));
        var sheet = workbook.Worksheet(1);
        Assert.Equal(XLDataType.Number, sheet.Cell(2, 1).DataType);
        Assert.Equal(123.45, sheet.Cell(2, 1).GetDouble());
        Assert.Equal("#,##0.00", sheet.Cell(2, 1).Style.NumberFormat.Format);
        Assert.Equal(9, sheet.Cell(2, 2).GetDouble());
        Assert.Equal(XLDataType.Text, sheet.Cell(2, 3).DataType);
        Assert.Equal("9876543210123456", sheet.Cell(2, 3).GetString());
        Assert.False(sheet.Cell(2, 4).HasFormula);
        Assert.Equal("=SUM(A1)", sheet.Cell(2, 4).GetString());
        Assert.Equal("yes", sheet.Cell(2, 5).GetString());
        Assert.Equal(0.1234, sheet.Cell(2, 6).GetDouble());
        Assert.Equal(1, sheet.SheetView.SplitRow);
        Assert.True(sheet.AutoFilter.IsEnabled);
        Assert.True(sheet.Cell(1, 1).Style.Font.Bold);
        Assert.Equal("+FORMULA", workbook.Worksheet(2).Cell(2, 1).GetString());
        Assert.False(workbook.Worksheet(2).Cell(2, 1).HasFormula);
        Assert.Equal("01234567890", workbook.Worksheet(2).Cell(2, 2).GetString());
        Assert.Equal("cleantext", workbook.Worksheet(2).Cell(2, 3).GetString());
        Assert.Equal("Synthetic workbook", workbook.Worksheet("About").Cell(1, 1).GetString());
    }

    [Fact]
    public void Empty_workbook_has_reference_note_and_filterable_header()
    {
        using var workbook = new XLWorkbook(new MemoryStream(ReportWorkbook.Build([])));
        Assert.Equal("Data", workbook.Worksheet(1).Name);
        Assert.Equal("Note", workbook.Worksheet(1).Cell(1, 1).GetString());
        Assert.Equal("No table in this message", workbook.Worksheet(1).Cell(2, 1).GetString());
        Assert.True(workbook.Worksheet(1).AutoFilter.IsEnabled);
    }
}
