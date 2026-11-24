using System.Globalization;
using SkiaSharp;

namespace Utils;

/// <summary>Saved report blocks rendered locally to PDF, with repeated table headers and visible row caps.</summary>
public static class ReportPdf
{
    public const int MaxRows = 2000, MaxColumns = 14;
    public sealed record Block(string Kind, string Text = "", IReadOnlyList<string>? Columns = null,
        IReadOnlyList<IReadOnlyList<string>>? Rows = null, int? TotalRows = null);
    private const float Mm = 72f / 25.4f;
    public static byte[] Build(string title, string subtitle, string brand, IReadOnlyList<Block> blocks)
    {
        var widest = blocks.Where(b => b.Kind == "table").Select(b => b.Columns?.Count ?? 0).DefaultIfEmpty(0).Max();
        var width = (widest > 9 ? 420 : widest > 5 ? 297 : 210) * Mm;
        var height = (widest > 9 ? 297 : widest > 5 ? 210 : 297) * Mm;
        const float margin = 12 * Mm;
        using var regular = SKTypeface.FromFamilyName("DejaVu Sans");
        using var bold = SKTypeface.FromFamilyName("DejaVu Sans", SKFontStyle.Bold);
        using var font = new SKFont(regular, 9.5f);
        using var paint = new SKPaint { Color = SKColors.Black, IsAntialias = true };
        using var output = new MemoryStream();
        using var document = SKDocument.CreatePdf(output, new SKDocumentPdfMetadata { Title = title, Author = brand, Creator = brand });
        SKCanvas canvas = null!;
        var page = 0; var y = margin; var usable = width - margin * 2;
        void NewPage()
        {
            if (page > 0) document.EndPage();
            canvas = document.BeginPage(width, height); page++; y = margin;
            font.Typeface = regular; font.Size = 7; paint.Color = SKColors.Gray;
            var footer = $"{brand} · {title} · generated {DateTime.Now:dd MMM yyyy, hh:mm tt}";
            canvas.DrawText(footer, margin, height - 8 * Mm, SKTextAlign.Left, font, paint);
            canvas.DrawText($"Page {page}", width - margin, height - 8 * Mm, SKTextAlign.Right, font, paint);
            paint.Color = SKColors.Black;
        }
        List<string> Wrap(string text, float maxWidth, float size)
        {
            font.Size = size;
            var lines = new List<string>();
            foreach (var hard in text.Replace("**", "").Split('\n'))
            {
                var line = "";
                foreach (var word in hard.Split(' '))
                {
                    var candidate = line.Length == 0 ? word : line + " " + word;
                    if (font.MeasureText(candidate) <= maxWidth) { line = candidate; continue; }
                    if (line.Length > 0) { lines.Add(line); line = ""; }
                    var elements = StringInfo.GetTextElementEnumerator(word);
                    while (elements.MoveNext())
                    {
                        var element = elements.GetTextElement();
                        if (line.Length > 0 && font.MeasureText(line + element) > maxWidth) { lines.Add(line); line = ""; }
                        line += element;
                    }
                }
                lines.Add(line);
            }
            return lines;
        }
        void Text(string text, float size = 9.5f, bool isBold = false, SKColor? color = null)
        {
            font.Typeface = isBold ? bold : regular;
            var lines = Wrap(text, usable, size);
            foreach (var line in lines)
            {
                if (y + size * 1.4f > height - 16 * Mm) NewPage();
                font.Typeface = isBold ? bold : regular; font.Size = size; paint.Color = color ?? SKColors.Black;
                canvas.DrawText(line, margin, y + size, SKTextAlign.Left, font, paint); y += size * 1.4f;
            }
            y += 3;
        }
        NewPage(); Text(title, 16, true);
        if (subtitle.Length > 0) Text(subtitle, 8.5f, color: new SKColor(0x55, 0x55, 0x55));
        y += 3;
        foreach (var block in blocks)
        {
            if (block.Kind != "table")
            {
                Text(block.Text, block.Kind == "heading" ? 11.5f : block.Kind == "note" ? 8 : 9.5f,
                    block.Kind == "heading", block.Kind == "note" ? new SKColor(0x6b, 0x4e, 0) : null);
                continue;
            }
            var columns = (block.Columns ?? []).Take(MaxColumns).ToList();
            if (columns.Count == 0) continue;
            var cellWidth = usable / columns.Count;
            var rowIndex = 0;
            void Row(IReadOnlyList<string> values, bool header)
            {
                font.Typeface = header ? bold : regular;
                var cells = Enumerable.Range(0, columns.Count).Select(i => Wrap(i < values.Count ? values[i][..Math.Min(400, values[i].Length)] : "", cellWidth - 6, 7)).ToList();
                var offset = 0;
                var count = cells.Max(c => c.Count);
                while (offset < count)
                {
                    var available = (int)Math.Floor((height - 16 * Mm - y - 5) / 8.5f);
                    if (available < 1 || (offset == 0 && available < count && count * 8.5f + 5 <= height - 16 * Mm - margin - 20 && y > margin + 30))
                    {
                        NewPage();
                        if (!header) Row(columns, true);
                        available = Math.Max(1, (int)Math.Floor((height - 16 * Mm - y - 5) / 8.5f));
                    }
                    var take = Math.Min(count - offset, available);
                    var rowHeight = take * 8.5f + 5;
                    paint.Color = header ? new SKColor(0xe8, 0xee, 0xf0) : rowIndex % 2 == 0 ? SKColors.White : new SKColor(0xf7, 0xf9, 0xfa);
                    canvas.DrawRect(margin, y, usable, rowHeight, paint);
                    paint.Color = SKColors.Black; font.Size = 7; font.Typeface = header ? bold : regular;
                    for (var i = 0; i < cells.Count; i++)
                        for (var j = 0; j < take && offset + j < cells[i].Count; j++)
                            canvas.DrawText(cells[i][offset + j], margin + i * cellWidth + 3, y + 9 + j * 8.5f, SKTextAlign.Left, font, paint);
                    y += rowHeight; offset += take;
                }
            }
            Row(columns, true);
            foreach (var row in (block.Rows ?? []).Take(MaxRows)) { Row(row, false); rowIndex++; }
            y += 4;
            var hidden = (block.TotalRows ?? block.Rows?.Count ?? 0) - Math.Min(MaxRows, block.Rows?.Count ?? 0);
            if (hidden > 0) Text($"{hidden.ToString("N0", CultureInfo.InvariantCulture)} more rows are not shown in the PDF. Download Excel or CSV for every row.", 8, color: new SKColor(0x6b, 0x4e, 0));
        }
        document.EndPage(); document.Close();
        return output.ToArray();
    }
}
