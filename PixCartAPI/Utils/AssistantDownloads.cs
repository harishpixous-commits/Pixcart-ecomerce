using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Utils;

/// <summary>Five local formats of saved assistant messages. Never calls or regenerates a model answer.</summary>
public static class AssistantDownloads
{
    public static readonly IReadOnlyDictionary<string, string> Formats = new Dictionary<string, string>
    {
        ["pdf"] = "application/pdf", ["xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ["csv"] = "text/csv; charset=utf-8", ["md"] = "text/markdown; charset=utf-8", ["json"] = "application/json",
    };
    private sealed record Table(string Name, IReadOnlyList<string> Columns, IReadOnlyList<IReadOnlyList<object?>> Rows);
    private static string Str(JsonNode? n) => n is null ? "" : n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n.ToJsonString();
    private static IEnumerable<JsonNode> Items(JsonNode? n) => (n as JsonArray ?? []).OfType<JsonNode>();
    private static object? Cell(JsonNode? n) => n is null ? null : n is JsonValue v && v.TryGetValue<string>(out var s) ? s : n.DeepClone();
    private static string Display(object? v) => v is null ? "" : v is JsonNode n ? Str(n) : Convert.ToString(v, CultureInfo.InvariantCulture) ?? "";
    private static string TextOf(object? v) => v is null ? "None" : v is JsonValue j && j.TryGetValue<bool>(out var b) ? b ? "True" : "False" : Display(v);
    private static string DefaultTitle(JsonNode b, string fallback) => Str(b["title"]) is { Length: > 0 } s ? s : fallback;
    private static IEnumerable<Table> Tables(IEnumerable<JsonNode> blocks)
    {
        foreach (var b in blocks)
        {
            switch (Str(b["type"]))
            {
                case "table":
                    yield return new(DefaultTitle(b, "Table"), Items(b["columns"]).Select(Str).ToList(), Items(b["rows"]).Select(r => (IReadOnlyList<object?>)(r as JsonArray ?? []).Select(Cell).ToList()).ToList()); break;
                case "metrics":
                    yield return new(DefaultTitle(b, "Figures"), ["Measure", "Value", "Note"], Items(b["items"]).Select(i => (IReadOnlyList<object?>)new object?[] { Cell(i["label"]), Cell(i["value"]), Cell(i["hint"]) ?? "" }).ToList()); break;
                case "chart":
                    var series = Items(b["series"]).ToList();
                    var columns = new[] { Str(b["title"]) is { Length: > 0 } t ? t : "Label" }.Concat(series.Select(s => Str(s["name"]))).ToList();
                    var rows = Items(b["labels"]).Select((l, i) => (IReadOnlyList<object?>)new object?[] { Cell(l) }.Concat(series.Select(s => s["values"] is JsonArray a && i < a.Count ? Cell(a[i]) : "")).ToList()).ToList();
                    yield return new(DefaultTitle(b, "Chart data"), columns, rows); break;
            }
        }
    }
    private static DateTime IstNow => TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata"));
    private static string Exported => IstNow.ToString("dd MMM yyyy, hh:mm tt", CultureInfo.InvariantCulture) + " IST";
    private static string EscapeMd(object? v) => TextOf(v).Replace("|", "\\|").Replace("\n", " ");
    public static string Markdown(IReadOnlyList<JsonObject> messages, string title)
    {
        var p = new List<string> { "# " + title, "_Exported " + Exported + "_", "" };
        foreach (var m in messages)
        {
            p.Add(Str(m["role"]) == "user" ? "## You" : "## Assistant");
            if (Str(m["role"]) == "user") p.Add(Str(m["text"]));
            foreach (var b in Items(m["blocks"]))
                switch (Str(b["type"]))
                {
                    case "text": p.Add(Str(b["text"])); break;
                    case "table": case "metrics": case "chart":
                        foreach (var t in Tables([b]))
                        {
                            p.Add("**" + t.Name + "**"); p.Add("");
                            p.Add("| " + string.Join(" | ", t.Columns.Select(c => EscapeMd(c))) + " |");
                            p.Add("|" + string.Concat(Enumerable.Repeat("---|", t.Columns.Count)));
                            p.AddRange(t.Rows.Select(r => "| " + string.Join(" | ", r.Select(EscapeMd)) + " |")); p.Add("");
                        }
                        break;
                    case "file": p.Add($"Download: {Str(b["title"])} ({Str(b["format"]).ToUpperInvariant()})"); break;
                    case "action": p.Add($"Action: {Str(b["summary"])} \u2014 {Str(b["status"])}"); break;
                    case "error": p.Add("> " + Str(b["text"])); break;
                }
            p.Add("");
        }
        return string.Join("\n", p);
    }
    public static byte[] Build(string format, IReadOnlyList<JsonObject> messages, string title, string brand)
    {
        if (!Formats.ContainsKey(format)) throw new ArgumentException("Unsupported download format", nameof(format));
        var blocks = messages.SelectMany(m => Items(m["blocks"])).ToList();
        if (format == "json") return Encoding.UTF8.GetBytes(new JsonObject { ["title"] = title, ["messages"] = new JsonArray(messages.Select(m => (JsonNode)m.DeepClone()).ToArray()) }.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        if (format == "md") return Encoding.UTF8.GetBytes(Markdown(messages, title));
        var tables = Tables(blocks).ToList();
        if (format == "csv")
        {
            var text = new StringBuilder();
            void Row(IEnumerable<object?> values, bool guard = false)
            {
                string Field(object? value)
                {
                    var s = value is null ? "" : TextOf(value);
                    if (guard && s.Length > 0 && ("=+@".Contains(s[0]) || s[0] == '-' && (s.Length < 2 || !char.IsDigit(s[1])))) s = "'" + s;
                    return s.IndexOfAny([',', '"', '\r', '\n']) >= 0 ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
                }
                text.Append(string.Join(",", values.Select(Field))).Append("\r\n");
            }
            if (tables.Count == 0) { Row(["Text"]); foreach (var b in blocks.Where(b => Str(b["type"]) == "text")) Row([Str(b["text"])]); }
            for (var i = 0; i < tables.Count; i++)
            {
                var t = tables[i]; if (i > 0) Row([]); if (tables.Count > 1) Row([t.Name]);
                Row(t.Columns); foreach (var r in t.Rows) Row(r, true);
            }
            return new byte[] { 0xef, 0xbb, 0xbf }.Concat(Encoding.UTF8.GetBytes(text.ToString())).ToArray();
        }
        if (format == "xlsx")
        {
            var sheets = tables.Select(t => new ReportWorkbook.Sheet(t.Name, t.Columns, t.Rows)).ToList();
            var texts = blocks.Where(b => Str(b["type"]) == "text").Select(b => (IReadOnlyList<object?>)new object?[] { Str(b["text"]) }).ToList();
            if (texts.Count > 0) sheets.Add(new("Answer", ["Text"], texts));
            return ReportWorkbook.Build(sheets, [("Title", title), ("Exported", IstNow.ToString("dd MMM yyyy HH:mm", CultureInfo.InvariantCulture) + " IST")], brand);
        }
        var pdf = new List<ReportPdf.Block>();
        foreach (var m in messages)
        {
            if (Str(m["role"]) == "user") { pdf.Add(new("heading", "Question")); pdf.Add(new("text", Str(m["text"]))); continue; }
            pdf.Add(new("heading", "Answer"));
            foreach (var b in Items(m["blocks"]))
            {
                var type = Str(b["type"]);
                if (type == "text") pdf.Add(new("text", Str(b["text"])));
                else if (type == "table")
                {
                    if (Str(b["title"]).Length > 0) pdf.Add(new("heading", Str(b["title"])));
                    var t = Tables([b]).Single();
                    pdf.Add(new("table", Columns: t.Columns, Rows: t.Rows.Select(r => (IReadOnlyList<string>)r.Select(Display).ToList()).ToList(), TotalRows: b["total_rows"]?.GetValue<int>()));
                }
                else if (type == "metrics")
                {
                    if (Str(b["title"]).Length > 0) pdf.Add(new("heading", Str(b["title"])));
                    pdf.Add(new("metrics", Metrics: Items(b["items"]).Select(i => (Str(i["label"]), Str(i["value"]))).ToList()));
                }
                else if (type == "chart")
                {
                    pdf.Add(new("heading", DefaultTitle(b, "Chart")));
                    double Number(JsonNode? n) => double.TryParse(Str(n), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0;
                    pdf.Add(new("chart", Labels: Items(b["labels"]).Select(Str).ToList(), ChartSeries: Items(b["series"]).Select(s => new ReportPdf.Series(Str(s["name"]), (s["values"] as JsonArray ?? []).Select(Number).ToList())).ToList(), ChartKind: Str(b["kind"])));
                }
                else if (type == "file") pdf.Add(new("note", $"Download offered: {Str(b["title"])} ({Str(b["format"]).ToUpperInvariant()}) \u2014 {Str(b["detail"])}"));
                else if (type == "action") pdf.Add(new("note", $"Action: {Str(b["summary"])} \u2014 {Str(b["status"])}"));
                else if (type == "error") pdf.Add(new("note", Str(b["text"])));
            }
        }
        return ReportPdf.Build(title, "Exported " + Exported, brand, pdf);
    }
}
