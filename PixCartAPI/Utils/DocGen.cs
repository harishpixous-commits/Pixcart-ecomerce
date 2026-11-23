using System.Globalization;
using System.Reflection;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using MigraDoc.DocumentObjectModel;
using MigraDoc.DocumentObjectModel.Shapes.Charts;
using MigraDoc.DocumentObjectModel.Tables;
using MigraDoc.Rendering;
using PdfSharp.Fonts;

namespace Utils;

/// <summary>
/// Spreadsheet and PDF writers shared by exports and the AI assistant's downloads (the reference version's docgen).
/// <list type="bullet">
/// <item>Excel (ClosedXML): numbers stay numbers (money with two decimals, counts as integers); long digit strings such as
/// phone, AWB and account numbers stay text; text that looks like a formula is written as text. Header row bold, frozen
/// and filterable.</item>
/// <item>PDF (PDFsharp-MigraDoc): DejaVu Sans (embedded, covers ₹); tables repeat their header on every page; long tables
/// are capped with a note pointing to Excel/CSV.</item>
/// </list>
/// </summary>
public static class DocGen
{
    public const int PdfMaxRows = 2000;
    public const int PdfMaxColumns = 14;

    private static readonly Regex Money = new(@"^-?\d{1,13}\.\d{2}$");
    private static readonly Regex Int = new(@"^-?(0|[1-9]\d{0,8})$");
    private static readonly Regex Dec = new(@"^-?\d{1,9}\.\d{1,4}$");
    private static readonly Regex Illegal = new(@"[\x00-\x08\x0b\x0c\x0e-\x1f]");

    /// <summary>(value, number format). Converts numeric text to numbers; everything else stays text.</summary>
    public static (object Value, string? Format) ExcelValue(object? value)
    {
        switch (value)
        {
            case null: return ("", null);
            case bool b: return (b ? "yes" : "no", null);
            case int or long or short: return (Convert.ToInt64(value), "#,##0");
            case double or float or decimal: return (Convert.ToDouble(value, CultureInfo.InvariantCulture), "#,##0.00");
        }
        var v = Illegal.Replace(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "", "");
        if (v.StartsWith('\'') && v.Length > 1 && "=+-@".Contains(v[1])) v = v[1..];
        if (Money.IsMatch(v)) return (double.Parse(v, CultureInfo.InvariantCulture), "#,##0.00");
        if (Int.IsMatch(v)) return (long.Parse(v, CultureInfo.InvariantCulture), "0");
        if (Dec.IsMatch(v)) return (double.Parse(v, CultureInfo.InvariantCulture), "0.####");
        return (v, null);
    }

    private static string SheetName(string title)
    {
        var s = Regex.Replace(title, @"[\[\]:*?/\\]", " ");
        s = s.Length > 31 ? s[..31] : s;
        return string.IsNullOrEmpty(s) ? "Sheet" : s;
    }

    /// <summary>A small workbook: one sheet per (title, columns, rows), plus an optional "About" sheet.</summary>
    public static byte[] XlsxBytes(IList<(string Title, IList<string> Columns, IList<IList<object?>> Rows)> sheets,
        IList<(string Key, string Value)>? about = null, string aboutTitle = "")
    {
        if (sheets.Count == 0) sheets = [("Data", ["Note"], [["No table in this message"]])];
        using var wb = new XLWorkbook();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (title, cols, rows) in sheets)
        {
            var name = SheetName(title);
            var n = 2;
            while (used.Contains(name)) name = $"{(SheetName(title).Length > 28 ? SheetName(title)[..28] : SheetName(title))} {n++}";
            used.Add(name);
            var ws = wb.Worksheets.Add(name);
            var widths = cols.Select(c => Math.Min(Math.Max(c.Length + 2, 10), 40)).ToArray();
            for (var c = 0; c < cols.Count; c++)
            {
                var cell = ws.Cell(1, c + 1);
                cell.SetValue(cols[c]);
                cell.Style.Font.Bold = true;
                cell.Style.Fill.BackgroundColor = XLColor.FromHtml("#E8EEF0");
                cell.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;
            }
            for (var r = 0; r < rows.Count; r++)
            {
                var row = rows[r];
                for (var c = 0; c < row.Count; c++)
                {
                    var (v, fmt) = ExcelValue(row[c]);
                    var cell = ws.Cell(r + 2, c + 1);
                    switch (v)
                    {
                        case long l: cell.SetValue(l); break;
                        case double d: cell.SetValue(d); break;
                        default: cell.SetValue(Convert.ToString(v, CultureInfo.InvariantCulture) ?? ""); cell.Style.NumberFormat.Format = "@"; break;
                    }
                    if (fmt != null) cell.Style.NumberFormat.Format = fmt;
                    if (c < widths.Length && r < 200) widths[c] = Math.Min(Math.Max(widths[c], (Convert.ToString(row[c], CultureInfo.InvariantCulture) ?? "").Length + 2), 60);
                }
            }
            for (var c = 0; c < widths.Length; c++) ws.Column(c + 1).Width = widths[c];
            ws.SheetView.FreezeRows(1);
            ws.Range(1, 1, rows.Count + 1, Math.Max(1, cols.Count)).SetAutoFilter();
        }
        if (about != null)
        {
            var ws = wb.Worksheets.Add("About");
            ws.Cell(1, 1).SetValue(aboutTitle);
            for (var i = 0; i < about.Count; i++)
            {
                ws.Cell(i + 2, 1).SetValue(about[i].Key);
                ws.Cell(i + 2, 2).SetValue(about[i].Value);
            }
        }
        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return ms.ToArray();
    }

    // ---------------------------------------------------------------- PDF

    /// <summary>A PDF built from blocks: headings, text (with **bold**), notes, metric tiles, tables and charts.</summary>
    public sealed class PdfDoc(string title, string subtitle = "")
    {
        public string Title { get; } = title;
        public string Subtitle { get; } = subtitle;
        internal readonly List<(string Kind, object Payload)> Blocks = [];

        public PdfDoc Heading(string text) { Blocks.Add(("heading", text)); return this; }
        public PdfDoc Text(string text) { Blocks.Add(("text", text)); return this; }
        public PdfDoc Note(string text) { Blocks.Add(("note", text)); return this; }
        public PdfDoc Metrics(IList<(string Label, string Value)> items) { Blocks.Add(("metrics", items)); return this; }

        public PdfDoc Table(IList<string> columns, IList<IList<object?>> rows, int? totalRows = null)
        {
            Blocks.Add(("table", (columns, rows, totalRows)));
            return this;
        }

        public PdfDoc Chart(string kind, IList<string> labels, IList<(string Name, IList<double> Values)> series)
        {
            Blocks.Add(("chart", (kind, labels, series)));
            return this;
        }
    }

    private static readonly object FontGate = new();

    private static void EnsureFonts()
    {
        lock (FontGate)
        {
            if (GlobalFontSettings.FontResolver is DejaVuResolver) return;
            GlobalFontSettings.FontResolver = new DejaVuResolver();
        }
    }

    /// <summary>DejaVu Sans from the embedded fonts (covers ₹ and most Latin text) for every family the document asks for.</summary>
    private sealed class DejaVuResolver : IFontResolver
    {
        private static readonly Dictionary<string, byte[]> Faces = Load();

        private static Dictionary<string, byte[]> Load()
        {
            var asm = Assembly.GetExecutingAssembly();
            var outp = new Dictionary<string, byte[]>();
            foreach (var (face, file) in new[] { ("DejaVu", "DejaVuSans.ttf"), ("DejaVu-Bold", "DejaVuSans-Bold.ttf") })
            {
                var name = asm.GetManifestResourceNames().First(n => n.EndsWith(file, StringComparison.Ordinal));
                using var s = asm.GetManifestResourceStream(name)!;
                using var ms = new MemoryStream();
                s.CopyTo(ms);
                outp[face] = ms.ToArray();
            }
            return outp;
        }

        public FontResolverInfo ResolveTypeface(string familyName, bool bold, bool italic) =>
            new(bold ? "DejaVu-Bold" : "DejaVu", false, italic);

        public byte[] GetFont(string faceName) => Faces.TryGetValue(faceName, out var b) ? b : Faces["DejaVu"];
    }

    private static readonly string[] Palette = ["#0B5563", "#E07A1F", "#5B7F2B", "#7A4E9C", "#B23A48", "#2E6DB4"];

    /// <summary>Adds text with **bold** runs to a paragraph.</summary>
    private static void AddInline(Paragraph p, string text)
    {
        var parts = Regex.Split(text, @"\*\*(.+?)\*\*");
        for (var i = 0; i < parts.Length; i++)
        {
            if (parts[i].Length == 0) continue;
            if (i % 2 == 1) p.AddFormattedText(parts[i], TextFormat.Bold);
            else p.AddText(parts[i]);
        }
    }

    public static byte[] PdfBytes(PdfDoc doc, string brand = "")
    {
        EnsureFonts();
        var widest = doc.Blocks.Where(b => b.Kind == "table").Select(b => ((ValueTuple<IList<string>, IList<IList<object?>>, int?>)b.Payload).Item1.Count).DefaultIfEmpty(0).Max();
        var document = new Document();
        document.Info.Title = doc.Title;
        document.Info.Author = brand;
        var normal = document.Styles[StyleNames.Normal]!;
        normal.Font.Name = "DejaVu";
        normal.Font.Size = 9.5;
        var section = document.AddSection();
        var ps = section.PageSetup;
        ps.PageFormat = widest > 9 ? PageFormat.A3 : PageFormat.A4;
        ps.Orientation = widest > 5 ? Orientation.Landscape : Orientation.Portrait;
        ps.LeftMargin = ps.RightMargin = ps.TopMargin = Unit.FromMillimeter(12);
        ps.BottomMargin = Unit.FromMillimeter(14);
        var pageWidth = (widest > 9 ? 297.0 : 210.0);
        var pageHeight = (widest > 9 ? 420.0 : 297.0);
        var usableMm = (ps.Orientation == Orientation.Landscape ? pageHeight : pageWidth) - 24;
        var generated = DateTime.Now.ToString("dd MMM yyyy, hh:mm tt", CultureInfo.InvariantCulture);

        var footer = section.Footers.Primary.AddParagraph();
        footer.Format.Font.Size = 7;
        footer.Format.Font.Color = Colors.Gray;
        footer.AddText(string.Join(" · ", new[] { brand, doc.Title, "generated " + generated }.Where(x => !string.IsNullOrEmpty(x))));
        footer.AddTab();
        footer.AddText("Page ");
        footer.AddPageField();
        footer.Format.AddTabStop(Unit.FromMillimeter(usableMm), TabAlignment.Right);

        var title = section.AddParagraph();
        title.Format.Font.Size = 16;
        title.Format.Font.Bold = true;
        title.Format.SpaceAfter = 2;
        AddInline(title, doc.Title);
        if (!string.IsNullOrEmpty(doc.Subtitle))
        {
            var sub = section.AddParagraph();
            sub.Format.Font.Size = 8.5;
            sub.Format.Font.Color = Color.Parse("#555555");
            AddInline(sub, doc.Subtitle);
        }
        section.AddParagraph().Format.SpaceAfter = 6;

        foreach (var (kind, payload) in doc.Blocks)
        {
            switch (kind)
            {
                case "heading":
                {
                    var h = section.AddParagraph();
                    h.Format.Font.Size = 11.5;
                    h.Format.Font.Bold = true;
                    h.Format.SpaceBefore = 8;
                    h.Format.SpaceAfter = 4;
                    AddInline(h, (string)payload);
                    break;
                }
                case "text":
                case "note":
                    foreach (var para in ((string)payload).Split("\n\n"))
                    {
                        var p = section.AddParagraph();
                        p.Format.SpaceAfter = 3;
                        if (kind == "note")
                        {
                            p.Format.Font.Size = 8;
                            p.Format.Font.Color = Color.Parse("#6b4e00");
                        }
                        var lines = para.Split('\n');
                        for (var i = 0; i < lines.Length; i++)
                        {
                            if (i > 0) p.AddLineBreak();
                            var ln = lines[i];
                            if (ln.StartsWith("- ") || ln.StartsWith("* ")) AddInline(p, "• " + ln[2..]);
                            else AddInline(p, ln);
                        }
                    }
                    break;
                case "metrics":
                {
                    var items = (IList<(string Label, string Value)>)payload;
                    var t = section.AddTable();
                    t.Borders.Color = Color.Parse("#d0d7da");
                    t.Borders.Width = 0.4;
                    t.Shading.Color = Color.Parse("#f6f8f9");
                    for (var c = 0; c < 4; c++) t.AddColumn(Unit.FromMillimeter(usableMm / 4));
                    for (var i = 0; i < items.Count; i += 4)
                    {
                        var row = t.AddRow();
                        row.TopPadding = row.BottomPadding = 5;
                        for (var j = 0; j < 4 && i + j < items.Count; j++)
                        {
                            var p = row.Cells[j].AddParagraph();
                            p.AddFormattedText(items[i + j].Label, new Font { Size = 7, Color = Color.Parse("#666666") });
                            p.AddLineBreak();
                            p.AddFormattedText(items[i + j].Value, TextFormat.Bold);
                        }
                    }
                    section.AddParagraph().Format.SpaceAfter = 6;
                    break;
                }
                case "chart":
                {
                    var (ck, labels, series) = ((string, IList<string>, IList<(string Name, IList<double> Values)>))payload;
                    var chart = section.AddChart(ck == "line" ? ChartType.Line : ChartType.Column2D);
                    chart.Width = Unit.FromMillimeter(Math.Min(usableMm, 180));
                    chart.Height = Unit.FromMillimeter(70);
                    chart.Format.Font.Size = 6;
                    var i = 0;
                    foreach (var (name, values) in series.Count > 0 ? series : [("", (IList<double>)[0])])
                    {
                        var s = chart.SeriesCollection.AddSeries();
                        s.Name = name;
                        s.Add(values.ToArray());
                        var color = Color.Parse(Palette[i++ % Palette.Length]);
                        if (ck == "line") { s.LineFormat.Color = color; s.LineFormat.Width = 1.5; s.MarkerStyle = MarkerStyle.None; }
                        else s.FillFormat.Color = color;
                    }
                    var xs = chart.XValues.AddXSeries();
                    xs.Add(labels.Select(l => l.Length > 14 ? l[..14] : l).DefaultIfEmpty("").ToArray());
                    chart.XAxis.MajorTickMark = TickMarkType.Outside;
                    chart.YAxis.MajorTickMark = TickMarkType.Outside;
                    chart.YAxis.HasMajorGridlines = true;
                    if (series.Count > 1) chart.RightArea.AddLegend();
                    section.AddParagraph().Format.SpaceAfter = 6;
                    break;
                }
                case "table":
                {
                    var (columnsAll, rows, total) = ((IList<string>, IList<IList<object?>>, int?))payload;
                    var columns = columnsAll.Take(PdfMaxColumns).ToList();
                    var shown = rows.Take(PdfMaxRows).ToList();
                    var t = section.AddTable();
                    t.Format.Font.Size = 7;
                    t.Borders.Visible = false;
                    t.TopPadding = t.BottomPadding = 2;
                    var w = usableMm / Math.Max(1, columns.Count);
                    foreach (var _ in columns) t.AddColumn(Unit.FromMillimeter(w));
                    var head = t.AddRow();
                    head.HeadingFormat = true;
                    head.Shading.Color = Color.Parse("#E8EEF0");
                    head.Borders.Bottom.Width = 0.6;
                    head.Borders.Bottom.Color = Color.Parse("#9aa9ae");
                    for (var c = 0; c < columns.Count; c++)
                    {
                        var p = head.Cells[c].AddParagraph();
                        p.Format.Font.Bold = true;
                        AddInline(p, columns[c]);
                    }
                    for (var r = 0; r < shown.Count; r++)
                    {
                        var row = t.AddRow();
                        row.VerticalAlignment = VerticalAlignment.Top;
                        if (r % 2 == 1) row.Shading.Color = Color.Parse("#f7f9fa");
                        var cells = shown[r];
                        for (var c = 0; c < columns.Count && c < cells.Count; c++)
                        {
                            var txt = Convert.ToString(cells[c], CultureInfo.InvariantCulture) ?? "";
                            AddInline(row.Cells[c].AddParagraph(), txt.Length > 400 ? txt[..400] : txt);
                        }
                    }
                    var hidden = (total ?? rows.Count) - shown.Count;
                    if (hidden > 0)
                    {
                        var p = section.AddParagraph($"{hidden:N0} more rows are not shown in the PDF. Download Excel or CSV for every row.");
                        p.Format.Font.Size = 8;
                        p.Format.Font.Color = Color.Parse("#6b4e00");
                    }
                    section.AddParagraph().Format.SpaceAfter = 6;
                    break;
                }
            }
        }
        var renderer = new PdfDocumentRenderer { Document = document };
        renderer.RenderDocument();
        using var ms = new MemoryStream();
        renderer.PdfDocument.Save(ms, false);
        return ms.ToArray();
    }
}
