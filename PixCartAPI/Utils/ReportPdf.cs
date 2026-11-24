using System.Globalization;
using System.Text.RegularExpressions;
using SkiaSharp;

namespace Utils;

/// <summary>Saved report blocks rendered locally to PDF, with repeated table headers and visible row caps.</summary>
public static class ReportPdf
{
    public const int MaxRows = 2000, MaxColumns = 14;
    public sealed record Block(string Kind, string Text = "", IReadOnlyList<string>? Columns = null,
        IReadOnlyList<IReadOnlyList<string>>? Rows = null, int? TotalRows = null,
        IReadOnlyList<(string Label, string Value)>? Metrics = null,
        IReadOnlyList<string>? Labels = null, IReadOnlyList<Series>? ChartSeries = null, string ChartKind = "bar");
    public sealed record Series(string Name, IReadOnlyList<double> Values);
    private const float Mm = 72f / 25.4f;
    public static byte[] Build(string title, string subtitle, string brand, IReadOnlyList<Block> blocks)
    {
        var widest = blocks.Where(b => b.Kind == "table").Select(b => b.Columns?.Count ?? 0).DefaultIfEmpty(0).Max();
        var width = (widest > 9 ? 420 : widest > 5 ? 297 : 210) * Mm;
        var height = (widest > 9 ? 297 : widest > 5 ? 210 : 297) * Mm;
        const float margin = 12 * Mm;
        using var regular = SKTypeface.FromFile(Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts", "DejaVuSans.ttf"));
        using var bold = SKTypeface.FromFile(Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts", "DejaVuSans-Bold.ttf"));
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
            foreach (var hard in text.Split('\n'))
            {
                var line = "";
                foreach (var word in hard.Split(' '))
                {
                    var candidate = line.Length == 0 ? word : line + " " + word;
                    if (font.MeasureText(candidate.Replace("**", "")) <= maxWidth) { line = candidate; continue; }
                    if (line.Length > 0) { lines.Add(line); line = ""; }
                    var elements = StringInfo.GetTextElementEnumerator(word);
                    while (elements.MoveNext())
                    {
                        var element = elements.GetTextElement();
                        if (line.Length > 0 && font.MeasureText((line + element).Replace("**", "")) > maxWidth) { lines.Add(line); line = ""; }
                        line += element;
                    }
                }
                lines.Add(line);
            }
            var active = false;
            for (var i = 0; i < lines.Count; i++)
            {
                var original = lines[i]; var starts = active;
                if ((Regex.Matches(original, @"\*\*").Count & 1) != 0) active = !active;
                lines[i] = (starts ? "**" : "") + original + (active ? "**" : "");
            }
            return lines;
        }
        void Inline(string text, float x, float baseline, float size, bool baseBold)
        {
            font.Size = size; var emphasis = false;
            foreach (var run in Regex.Split(text, @"(\*\*)"))
            {
                if (run == "**") { emphasis = !emphasis; continue; }
                font.Typeface = baseBold || emphasis ? bold : regular;
                canvas.DrawText(run, x, baseline, SKTextAlign.Left, font, paint); x += font.MeasureText(run);
            }
        }
        void Text(string text, float size = 9.5f, bool isBold = false, SKColor? color = null)
        {
            font.Typeface = isBold ? bold : regular;
            var lines = Wrap(text, usable, size);
            foreach (var line in lines)
            {
                if (y + size * 1.4f > height - 16 * Mm) NewPage();
                font.Typeface = isBold ? bold : regular; font.Size = size; paint.Color = color ?? SKColors.Black;
                Inline(line, margin, y + size, size, isBold); y += size * 1.4f;
            }
            y += 3;
        }
        NewPage(); Text(title, 16, true);
        if (subtitle.Length > 0) Text(subtitle, 8.5f, color: new SKColor(0x55, 0x55, 0x55));
        y += 3;
        foreach (var block in blocks)
        {
            if (block.Kind == "metrics")
            {
                var metrics = block.Metrics ?? [];
                if (metrics.Count == 0) continue;
                for (var start = 0; start < metrics.Count; start += 4)
                {
                    var group = metrics.Skip(start).Take(4).ToList();
                    var labelLines = group.Select(m => Wrap(m.Label, usable / 4 - 10, 7)).ToList();
                    var valueLines = group.Select(m => Wrap(m.Value, usable / 4 - 10, 9.5f)).ToList();
                    var h = labelLines.Max(l => l.Count) * 9 + valueLines.Max(l => l.Count) * 13 + 12;
                    if (y + h > height - 16 * Mm) NewPage();
                    for (var i = 0; i < 4; i++)
                    {
                        var x = margin + i * usable / 4;
                        paint.Color = new SKColor(0xf6, 0xf8, 0xf9); canvas.DrawRect(x, y, usable / 4, h, paint);
                        paint.Style = SKPaintStyle.Stroke; paint.StrokeWidth = 0.4f; paint.Color = new SKColor(0xd0, 0xd7, 0xda);
                        canvas.DrawRect(x, y, usable / 4, h, paint); paint.Style = SKPaintStyle.Fill;
                        if (i >= group.Count) continue;
                        font.Typeface = regular; font.Size = 7; paint.Color = new SKColor(0x66, 0x66, 0x66);
                        for (var j = 0; j < labelLines[i].Count; j++) canvas.DrawText(labelLines[i][j], x + 5, y + 12 + j * 9, font, paint);
                        font.Typeface = bold; font.Size = 9.5f; paint.Color = SKColors.Black;
                        for (var j = 0; j < valueLines[i].Count; j++) canvas.DrawText(valueLines[i][j], x + 5, y + 12 + labelLines.Max(l => l.Count) * 9 + j * 13, font, paint);
                    }
                    y += h;
                }
                y += 6; continue;
            }
            if (block.Kind == "chart")
            {
                if (y + 206 > height - 16 * Mm) NewPage();
                var labels = block.Labels ?? []; var series = block.ChartSeries ?? [];
                var chartWidth = Math.Min(usable, 520); var left = margin + 45; var top = y + 20;
                var plotWidth = chartWidth - 60; const float plotHeight = 140;
                var all = series.SelectMany(s => s.Values).Where(double.IsFinite).ToList();
                var lo = Math.Min(0, all.DefaultIfEmpty(0).Min()); var hi = Math.Max(1, all.DefaultIfEmpty(1).Max()) * 1.1;
                float Y(double n) => top + plotHeight - (float)((double.IsFinite(n) ? n - lo : -lo) / (hi - lo)) * plotHeight;
                var palette = new[] { "#0B5563", "#E07A1F", "#5B7F2B", "#7A4E9C", "#B23A48", "#2E6DB4" }.Select(SKColor.Parse).ToArray();
                font.Typeface = regular; font.Size = 7; paint.Color = SKColors.Gray; paint.StrokeWidth = 0.5f;
                canvas.DrawLine(left, top, left, top + plotHeight, paint); canvas.DrawLine(left, Y(0), left + plotWidth, Y(0), paint);
                for (var tick = 0; tick <= 4; tick++)
                {
                    var n = lo + (hi - lo) * tick / 4;
                    canvas.DrawText(n.ToString("0.##", CultureInfo.InvariantCulture), left - 5, Y(n) + 2, SKTextAlign.Right, font, paint);
                }
                var slots = Math.Max(1, labels.Count); var step = plotWidth / slots;
                for (var n = 0; n < series.Count; n++)
                {
                    paint.Color = palette[n % palette.Length]; paint.StrokeWidth = 1.5f;
                    var values = series[n].Values;
                    for (var i = 0; i < Math.Min(labels.Count, values.Count); i++)
                    {
                        var x = left + step * (i + 0.5f);
                        if (block.ChartKind == "line")
                        {
                            if (i > 0) canvas.DrawLine(x - step, Y(values[i - 1]), x, Y(values[i]), paint);
                        }
                        else
                        {
                            var barWidth = step * 0.75f / Math.Max(1, series.Count);
                            var x0 = left + step * i + step * 0.125f + n * barWidth;
                            canvas.DrawRect(x0, Math.Min(Y(0), Y(values[i])), barWidth, Math.Abs(Y(0) - Y(values[i])), paint);
                        }
                    }
                    if (series.Count > 1)
                    {
                        font.Size = 7;
                        canvas.DrawText(series[n].Name, margin + 50 + n * (chartWidth - 50) / series.Count, y + 9, font, paint);
                    }
                }
                paint.Color = SKColors.Black; font.Size = 6;
                for (var i = 0; i < labels.Count; i++)
                {
                    var label = labels[i][..Math.Min(14, labels[i].Length)]; var x = left + step * (i + 0.5f);
                    canvas.Save(); canvas.Translate(x, top + plotHeight + 10);
                    if (labels.Count > 8) canvas.RotateDegrees(30);
                    canvas.DrawText(label, 0, 0, SKTextAlign.Center, font, paint); canvas.Restore();
                }
                y += 206; continue;
            }
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
                            Inline(cells[i][offset + j], margin + i * cellWidth + 3, y + 9 + j * 8.5f, 7, header);
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
