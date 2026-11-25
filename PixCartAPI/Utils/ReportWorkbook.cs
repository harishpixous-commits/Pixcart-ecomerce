using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ClosedXML.Excel;

namespace Utils;

/// <summary>Typed, formula-safe workbooks shared by saved assistant downloads and data exports.</summary>
public static class ReportWorkbook
{
    public sealed record Sheet(string Title, IReadOnlyList<string> Columns, IEnumerable<IReadOnlyList<object?>> Rows);
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static byte[] Build(IReadOnlyList<Sheet> sheets, IReadOnlyList<(string Key, string Value)>? about = null, string title = "")
    {
        using var book = new XLWorkbook();
        var actual = sheets.Count == 0 ? new[] { new Sheet("Data", ["Note"], new[] { new object?[] { "No table in this message" } }) } : sheets;
        foreach (var sheet in actual)
        {
            var name = Regex.Replace(sheet.Title, @"[\[\]:*?/\\]", " ");
            name = name[..Math.Min(31, name.Length)];
            if (name.Length == 0) name = "Sheet";
            var stem = name;
            for (var n = 2; book.Worksheets.Any(w => w.Name.Equals(name, StringComparison.OrdinalIgnoreCase)); n++)
                name = stem[..Math.Min(28, stem.Length)] + " " + n;
            var ws = book.AddWorksheet(name);
            ws.SheetView.FreezeRows(1);
            for (var c = 0; c < sheet.Columns.Count; c++)
            {
                ws.Cell(1, c + 1).Value = sheet.Columns[c];
                ws.Cell(1, c + 1).Style.Font.Bold = true;
                ws.Cell(1, c + 1).Style.Fill.BackgroundColor = XLColor.FromHtml("#E8EEF0");
                ws.Column(c + 1).Width = Math.Clamp(sheet.Columns[c].Length + 2, 10, 40);
            }
            var row = 2;
            foreach (var values in sheet.Rows)
            {
                for (var c = 0; c < values.Count; c++) Write(ws.Cell(row, c + 1), values[c]);
                row++;
            }
            ws.Range(1, 1, Math.Max(1, row - 1), Math.Max(1, sheet.Columns.Count)).SetAutoFilter();
        }
        if (about is { Count: > 0 })
        {
            var ws = book.AddWorksheet("About");
            ws.Cell(1, 1).Value = title;
            for (var i = 0; i < about.Count; i++) { ws.Cell(i + 2, 1).Value = about[i].Key; ws.Cell(i + 2, 2).Value = about[i].Value; }
        }
        using var output = new MemoryStream();
        book.SaveAs(output);
        return output.ToArray();
    }

    private static void Write(IXLCell cell, object? value)
    {
        if (value is JsonValue json)
        {
            if (json.TryGetValue<string>(out var text)) value = text;
            else if (json.TryGetValue<bool>(out var flag)) value = flag;
            else if (json.TryGetValue<long>(out var integer)) value = integer;
            else if (json.TryGetValue<double>(out var number)) value = number;
        }
        if (value is null) { cell.Value = ""; return; }
        if (value is bool boolean) { cell.Value = boolean ? "yes" : "no"; return; }
        if (value is int or long or short) { cell.Value = Convert.ToDouble(value, Inv); cell.Style.NumberFormat.Format = "#,##0"; return; }
        if (value is float or double or decimal) { cell.Value = Convert.ToDouble(value, Inv); cell.Style.NumberFormat.Format = "#,##0.00"; return; }
        var s = Regex.Replace(Convert.ToString(value, Inv) ?? "", @"[\x00-\x08\x0b\x0c\x0e-\x1f]", "");
        if (s.Length > 1 && s[0] == '\'' && "=+-@".Contains(s[1])) s = s[1..];
        var format = Regex.IsMatch(s, @"^-?\d{1,13}\.\d{2}$") ? "#,##0.00"
            : Regex.IsMatch(s, @"^-?(0|[1-9]\d{0,8})$") ? "0"
            : Regex.IsMatch(s, @"^-?\d{1,9}\.\d{1,4}$") ? "0.####" : null;
        if (format is not null && double.TryParse(s, NumberStyles.Float, Inv, out var n)) { cell.Value = n; cell.Style.NumberFormat.Format = format; }
        else cell.Value = s; // Value is text, never FormulaA1, including leading '=' strings.
    }
}
