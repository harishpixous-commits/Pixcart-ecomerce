using SkiaSharp;

namespace BAL;

/// <summary>The shared GST document layout (reference: services/invoices.py _pdf): A4, 14/12&nbsp;mm margins,
/// a bold title, a grey-label header table, a boxed two-party block, the 12-column item table with the
/// <c>#E3EFF1</c> head, a totals block and a small-print note. Drawn with SkiaSharp (no reportlab in .NET).
/// Amounts are pre-formatted strings; only the Item column and the address blocks wrap.</summary>
public static class InvoicePdf
{
    private const float Mm = 72f / 25.4f;
    private const float PageW = 210 * Mm, PageH = 297 * Mm;
    private const float MarginX = 14 * Mm, MarginY = 12 * Mm;
    private static readonly SKColor Grey = new(0x80, 0x80, 0x80);
    private static readonly SKColor HeadBg = new(0xE3, 0xEF, 0xF1);

    private static readonly SKTypeface Regular =
        SKTypeface.FromFamilyName("Carlito") ?? SKTypeface.FromFamilyName("DejaVu Sans") ?? SKTypeface.Default;
    private static readonly SKTypeface Bold =
        SKTypeface.FromFamilyName("Carlito", SKFontStyle.Bold) ?? SKTypeface.FromFamilyName("DejaVu Sans", SKFontStyle.Bold) ?? Regular;

    private sealed class Pen(SKTypeface face, float size)
    {
        public readonly SKFont Font = new(face, size);
        public readonly SKPaint Paint = new() { Color = SKColors.Black, IsAntialias = true };
        public float Leading => size * 1.25f;
    }

    private static float Wrap(SKFont font, string text, float width, List<string> lines)
    {
        // Paragraph-style word wrap (reference: reportlab Paragraph in the Item column and address blocks).
        foreach (var hard in text.Split('\n'))
        {
            var words = hard.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0)
            {
                lines.Add("");
                continue;
            }
            var line = words[0];
            foreach (var w in words.Skip(1))
            {
                if (font.MeasureText(line + " " + w) <= width) line += " " + w;
                else
                {
                    lines.Add(line);
                    line = w;
                }
            }
            lines.Add(line);
        }
        return lines.Count;
    }

    private sealed class Writer(SKCanvas canvas)
    {
        public float Y = MarginY;

        public void Ensure(float height, Action newPage)
        {
            if (Y + height > PageH - MarginY) newPage();
        }

        public void Text(string s, float x, Pen pen, float? width = null, bool right = false)
        {
            var dx = right && width is not null ? width.Value - pen.Font.MeasureText(s) : 0;
            canvas.DrawText(s, x + dx, Y + pen.Font.Size, SKTextAlign.Left, pen.Font, pen.Paint);
        }
    }

    /// <summary>One cell of the party block: label line bold, address lines regular (reference: _addr).</summary>
    public sealed record PartyCell(string Label, string[] Lines);

    /// <summary>Builds the document and returns the PDF bytes (reference: _pdf).</summary>
    public static byte[] Build(string title, (string Label, string Value)[] header, PartyCell[] parties,
        IReadOnlyList<string[]> rows, (string Label, string Value)[] totals, string note)
    {
        using var stream = new MemoryStream();
        using (var doc = SKDocument.CreatePdf(stream, new SKDocumentPdfMetadata { Title = title }))
        {
            var canvas = doc.BeginPage(PageW, PageH);
            var w = new Writer(canvas);
            void NewPage()
            {
                doc.EndPage();
                canvas = doc.BeginPage(PageW, PageH);
                w = new Writer(canvas);
            }

            // Title (reference: Paragraph style t, fontSize 16, left aligned).
            var titlePen = new Pen(Bold, 16);
            w.Ensure(titlePen.Leading, NewPage);
            w.Text(title, MarginX, titlePen);
            w.Y += titlePen.Leading + 4;

            // Header table: 38mm grey labels, 140mm values, fontSize 8.5.
            var headPen = new Pen(Regular, 8.5f);
            var labelPaint = new SKPaint { Color = Grey, IsAntialias = true };
            foreach (var (label, value) in header)
            {
                w.Ensure(headPen.Leading, NewPage);
                canvas.DrawText(label, MarginX, w.Y + headPen.Font.Size, SKTextAlign.Left, headPen.Font, labelPaint);
                w.Text(value, MarginX + 38 * Mm, headPen);
                w.Y += headPen.Leading;
            }
            w.Y += 6;

            // Parties: two 89mm boxed columns, small style (8/10), first line bold.
            var small = new Pen(Regular, 8);
            var smallBold = new Pen(Bold, 8);
            var colW = 89 * Mm;
            var partyLines = parties.Select(p =>
            {
                var lines = new List<(string Text, bool Bold)> { (p.Label, true) };
                lines.AddRange(p.Lines.Where(l => l.Length > 0).Select(l => (l, false)));
                var wrapped = new List<(string Text, bool Bold)>();
                foreach (var (text, bold) in lines)
                {
                    var tmp = new List<string>();
                    Wrap(bold ? smallBold.Font : small.Font, text, colW - 4, tmp);
                    wrapped.AddRange(tmp.Select(t => (t, bold)));
                }
                return wrapped;
            }).ToList();
            var partyH = partyLines.Max(l => l.Count) * small.Leading + 4;
            w.Ensure(partyH, NewPage);
            for (var c = 0; c < parties.Length; c++)
            {
                var x = MarginX + c * colW;
                canvas.DrawRect(x, w.Y, colW, partyH, new SKPaint { Style = SKPaintStyle.Stroke, Color = Grey, StrokeWidth = 0.5f });
                var ly = w.Y + 2;
                foreach (var (text, bold) in partyLines[c])
                {
                    canvas.DrawText(text, x + 2, ly + small.Font.Size, SKTextAlign.Left, bold ? smallBold.Font : small.Font, small.Paint);
                    ly += small.Leading;
                }
            }
            w.Y += partyH + 6;

            // Items: 12 columns (reference widths in mm), 7.5pt, boxed grid, numeric right-aligned, head #E3EFF1.
            var itemPen = new Pen(Regular, 7.5f);
            var itemHead = new Pen(Bold, 7.5f);
            float[] mmW = [6, 52, 12, 8, 15, 12, 17, 10, 13, 13, 13, 17];
            var totalMm = mmW.Sum();
            var widths = mmW.Select(m => m * Mm * (182f / totalMm)).ToArray(); // reference overflows to 188mm; fit the 182mm content width
            var heads = new[] { "#", "Item", "HSN", "Qty", "Rate", "Disc.", "Taxable", "GST %", "CGST", "SGST", "IGST", "Total" };

            float RowHeight(string[] cells)
            {
                var lines = new List<string>();
                Wrap(itemPen.Font, cells[1], widths[1] - 3, lines);
                return Math.Max(1, lines.Count) * itemPen.Leading + 3;
            }
            void GridRow(string[] cells, bool head)
            {
                var h = head ? itemPen.Leading + 3 : RowHeight(cells);
                if (w.Y + h > PageH - MarginY)
                {
                    NewPage();
                    if (!head) GridRow(heads, true); // repeatRows=1
                }
                if (head) canvas.DrawRect(MarginX, w.Y, widths.Sum(), h, new SKPaint { Color = HeadBg });
                var x = MarginX;
                for (var c = 0; c < widths.Length; c++)
                {
                    canvas.DrawRect(x, w.Y, widths[c], h, new SKPaint { Style = SKPaintStyle.Stroke, Color = Grey, StrokeWidth = 0.4f });
                    var pen = head ? itemHead : itemPen;
                    if (c >= 3 && !head) w.Text(cells[c], x, pen, widths[c] - 2, right: true);
                    else if (c == 1 && !head)
                    {
                        var lines = new List<string>();
                        Wrap(pen.Font, cells[c], widths[c] - 3, lines);
                        var ly = w.Y + 1.5f;
                        foreach (var line in lines)
                        {
                            canvas.DrawText(line, x + 1.5f, ly + pen.Font.Size, SKTextAlign.Left, pen.Font, pen.Paint);
                            ly += pen.Leading;
                        }
                    }
                    else w.Text(cells[c], x + 1.5f, pen);
                    x += widths[c];
                }
                w.Y += h;
            }
            GridRow(heads, true);
            foreach (var r in rows) GridRow(r, false);
            w.Y += 6;

            // Totals: 140mm label, 38mm right-aligned value, last row(s) bold (reference: FONTNAME last row bold).
            var totPen = new Pen(Regular, 8.5f);
            var totBold = new Pen(Bold, 8.5f);
            for (var i = 0; i < totals.Length; i++)
            {
                var pen = i == totals.Length - 1 || totals[i].Label.StartsWith("Rupees") ? totBold : totPen;
                var lines = new List<string>();
                Wrap(pen.Font, totals[i].Label, 140 * Mm, lines);
                var h = Math.Max(1, lines.Count) * pen.Leading;
                w.Ensure(h, NewPage);
                var ly = w.Y;
                foreach (var line in lines)
                {
                    canvas.DrawText(line, MarginX, ly + pen.Font.Size, SKTextAlign.Left, pen.Font, pen.Paint);
                    ly += pen.Leading;
                }
                if (totals[i].Value.Length > 0) w.Text(totals[i].Value, MarginX + 140 * Mm, pen, 38 * Mm, right: true);
                w.Y += h;
            }
            w.Y += 8;

            // Note (small print).
            var noteLines = new List<string>();
            Wrap(small.Font, note, 178 * Mm, noteLines);
            foreach (var line in noteLines)
            {
                w.Ensure(small.Leading, NewPage);
                w.Text(line, MarginX, small);
                w.Y += small.Leading;
            }
            doc.EndPage();
        }
        return stream.ToArray();
    }
}
