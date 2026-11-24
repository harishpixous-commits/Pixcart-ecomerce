using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.AI;
using ClosedXML.Excel;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.Assistant;

/// <summary>A file that cannot be read; the message is shown to the person.</summary>
public sealed class UploadException(string message) : Exception(message);

/// <summary>
/// Files given to the assistant: parsed once, profiled, queried and compared with live data. Accepted: CSV/TSV, Excel
/// (.xlsx, first sheet, formulas read as their saved values and never evaluated), plain text, Markdown and JSON — at
/// most 5 MB, 50,000 rows and 100 columns. Files belong to the person who uploaded them and are deleted after 7 days.
/// All arithmetic on uploaded data is done here with exact decimals.
/// </summary>
public static class Uploads
{
    public const int MaxBytes = 5 * 1024 * 1024;
    public const int MaxRows = 50_000;
    public const int MaxCols = 100;
    public const int TextLimit = 200_000;
    public const int KeepDays = 7;
    public static readonly string[] Extensions = [".csv", ".tsv", ".xlsx", ".txt", ".md", ".json"];
    public static readonly string[] Ops = ["equals", "not_equals", "contains", "greater_than", "less_than", "is_empty", "not_empty"];
    public static readonly string[] Metrics = ["count", "sum", "average", "min", "max"];
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public sealed record Parsed(List<string> Columns, List<List<JsonNode?>> Rows, bool Truncated, string Text);

    private static JsonNode? Cell(object? v) => v switch
    {
        null => JsonValue.Create(""),
        double d when d == Math.Floor(d) && Math.Abs(d) < 1e15 => JsonValue.Create((long)d),
        double d => JsonValue.Create(d),
        long l => JsonValue.Create(l),
        int i => JsonValue.Create(i),
        DateTime dt => JsonValue.Create(dt.ToString(dt.TimeOfDay == TimeSpan.Zero ? "yyyy-MM-ddTHH:mm:ss" : "yyyy-MM-ddTHH:mm:ss", Inv)),
        bool b => JsonValue.Create(b ? "True" : "False"),
        _ => JsonValue.Create((Convert.ToString(v, Inv) ?? "").Trim()),
    };

    private static List<string> Dedupe(List<string> headers)
    {
        var outp = new List<string>();
        var seen = new Dictionary<string, int>();
        for (var i = 0; i < headers.Count; i++)
        {
            var name = J.Cut(Regex.Replace(headers[i] ?? "", @"\s+", " ").Trim(), 80);
            if (name.Length == 0) name = $"Column {i + 1}";
            seen[name] = seen.GetValueOrDefault(name) + 1;
            outp.Add(seen[name] == 1 ? name : $"{name} ({seen[name]})");
        }
        return outp;
    }

    private static Parsed Table(List<string> header, List<List<JsonNode?>> rows, bool truncated)
    {
        var width = new[] { header.Count }.Concat(rows.Take(1000).Select(r => r.Count)).Max();
        var cols = Dedupe(header.Concat(Enumerable.Repeat("", width - header.Count)).ToList());
        foreach (var r in rows) while (r.Count < width) r.Add(JsonValue.Create(""));
        if (cols.Count == 0) throw new UploadException("The file has no header row.");
        return new Parsed(cols, rows, truncated, "");
    }

    /// <summary>A CSV reader with quotes ("a, b"), doubled quotes and line breaks inside quotes.</summary>
    private static IEnumerable<List<string>> Csv(string text, char delim)
    {
        var row = new List<string>();
        var cell = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"') { cell.Append('"'); i++; }
                    else quoted = false;
                }
                else cell.Append(c);
                continue;
            }
            if (c == '"') quoted = true;
            else if (c == delim) { row.Add(cell.ToString()); cell.Clear(); }
            else if (c == '\r' || c == '\n')
            {
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                row.Add(cell.ToString());
                cell.Clear();
                yield return row;
                row = [];
            }
            else cell.Append(c);
        }
        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString());
            yield return row;
        }
    }

    public static Parsed Parse(string filename, byte[] data)
    {
        var name = filename.ToLowerInvariant();
        if (data.Length > MaxBytes) throw new UploadException("The file is larger than 5 MB. Export fewer rows or split it.");
        if (!Extensions.Any(name.EndsWith)) throw new UploadException("Upload a CSV, Excel (.xlsx), text or JSON file.");
        if (name.EndsWith(".xlsx"))
        {
            if (data.Length < 2 || data[0] != (byte)'P' || data[1] != (byte)'K') throw new UploadException("This is not a valid Excel file.");
            try
            {
                using var wb = new XLWorkbook(new MemoryStream(data));
                var ws = wb.Worksheets.First();
                var used = ws.RangeUsed();
                if (used is null) return Table([], [], false);
                var lastCol = Math.Min(used.LastColumn().ColumnNumber(), MaxCols);
                var lastRow = used.LastRow().RowNumber();
                object? Val(IXLCell c)
                {
                    var v = c.HasFormula ? c.CachedValue : c.Value; // formulas: the last saved value, never evaluated
                    return v.Type switch
                    {
                        XLDataType.Blank => null, XLDataType.Number => v.GetNumber(), XLDataType.Boolean => v.GetBoolean(), XLDataType.DateTime => v.GetDateTime(),
                        XLDataType.TimeSpan => v.GetTimeSpan().ToString(), XLDataType.Error => v.GetError().ToString(), _ => v.GetText(),
                    };
                }
                var header = Enumerable.Range(1, lastCol).Select(c => Convert.ToString(Val(ws.Cell(1, c)), Inv) ?? "").ToList();
                var rows = new List<List<JsonNode?>>();
                var truncated = false;
                for (var r = 2; r <= lastRow; r++)
                {
                    if (rows.Count >= MaxRows) { truncated = true; break; }
                    var vals = Enumerable.Range(1, lastCol).Select(c => Cell(Val(ws.Cell(r, c)))).ToList();
                    if (vals.Any(v => J.S(v) != "")) rows.Add(vals);
                }
                while (header.Count > 0 && header[^1] == "" && rows.All(r => J.S(r[header.Count - 1]) == ""))
                {
                    header.RemoveAt(header.Count - 1);
                    foreach (var row in rows) row.RemoveAt(row.Count - 1);
                }
                return Table(header, rows, truncated);
            }
            catch (UploadException) { throw; }
            catch (Exception)
            {
                throw new UploadException("This Excel file could not be read. Save it again as .xlsx (no password).");
            }
        }
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(data);
            if (text.StartsWith('﻿')) text = text[1..];
        }
        catch (DecoderFallbackException)
        {
            text = Encoding.Latin1.GetString(data);
        }
        if (name.EndsWith(".csv") || name.EndsWith(".tsv"))
        {
            var sample = J.Cut(text, 5000);
            var delim = name.EndsWith(".tsv") || sample.Count(c => c == '\t') > sample.Count(c => c == ',') ? '\t' : ',';
            var all = Csv(text, delim).GetEnumerator();
            var header = all.MoveNext() ? all.Current : [];
            var rows = new List<List<JsonNode?>>();
            var truncated = false;
            while (all.MoveNext())
            {
                if (rows.Count >= MaxRows) { truncated = true; break; }
                var vals = all.Current.Take(MaxCols).Select(v => (JsonNode?)JsonValue.Create(v.Trim())).ToList();
                if (vals.Any(v => J.S(v).Length > 0)) rows.Add(vals);
            }
            return Table(header.Take(MaxCols).ToList(), rows, truncated);
        }
        if (name.EndsWith(".json"))
        {
            JsonNode? obj;
            try { obj = JsonNode.Parse(text); }
            catch (JsonException) { throw new UploadException("This JSON file is not valid."); }
            if (obj is JsonArray arr && arr.Count > 0 && arr.Take(50).All(x => x is JsonObject))
            {
                var keys = new List<string>();
                foreach (var x in arr.Take(500).OfType<JsonObject>())
                    foreach (var (k, _) in x)
                        if (!keys.Contains(k) && keys.Count < MaxCols) keys.Add(k);
                var rows = arr.Take(MaxRows).OfType<JsonObject>().Select(x => keys.Select(k => x[k] is JsonObject or JsonArray
                    ? (JsonNode?)JsonValue.Create(J.Cut(x[k]!.ToJsonString(), 500)) : x[k] is null ? JsonValue.Create("") : x[k] is JsonValue jv && jv.GetValueKind() == JsonValueKind.String ? JsonValue.Create(J.S(jv).Trim()) : x[k]!.DeepClone()).ToList()).ToList();
                return Table(keys, rows, arr.Count > MaxRows);
            }
            var pretty = obj?.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = J.Relaxed.Encoder }) ?? "null";
            return new Parsed([], [], text.Length > TextLimit, J.Cut(pretty, TextLimit));
        }
        return new Parsed([], [], text.Length > TextLimit, J.Cut(text, TextLimit));
    }

    public static AssistantUploadModel Build(Guid userId, string filename, string contentType, byte[] data)
    {
        var parsed = Parse(filename, data);
        var now = DateTimeFunctions.UtcNow();
        return new AssistantUploadModel
        {
            Id = Guid.NewGuid(), UserId = userId, Filename = J.Cut(Regex.Replace(filename, @"[^\w.\- ()]+", "_"), 200), ContentType = J.Cut(contentType ?? "", 100),
            Size = data.Length, Sha256 = Convert.ToHexStringLower(SHA256.HashData(data)), Columns = J.Dumps(J.Strings(parsed.Columns)),
            Rows = J.Dumps(new JsonArray(parsed.Rows.Select(r => (JsonNode?)new JsonArray(r.Select(c => c?.DeepClone()).ToArray())).ToArray())),
            RowCount = parsed.Rows.Count, Truncated = parsed.Truncated, Text = parsed.Text, CreatedAt = now, ExpiresAt = now.AddDays(KeepDays),
        };
    }

    /// <summary>An upload's columns and rows in memory.</summary>
    public sealed class Sheet(AssistantUploadModel up)
    {
        public AssistantUploadModel Upload { get; } = up;
        public List<string> Columns { get; } = J.Arr(up.Columns).Select(J.S).ToList();
        public List<List<JsonNode?>> Rows { get; } = J.Arr(up.Rows).OfType<JsonArray>().Select(r => r.Select(c => c?.DeepClone()).ToList()).ToList();

        public int Col(string name)
        {
            for (var i = 0; i < Columns.Count; i++)
                if (string.Equals(Columns[i], name?.Trim(), StringComparison.OrdinalIgnoreCase)) return i;
            throw new ArgumentException($"No column named '{name}'. Columns are: {string.Join(", ", Columns.Take(40))}");
        }

        public string Get(List<JsonNode?> r, int i) => i < r.Count ? J.S(r[i]) : "";
    }

    private static readonly Regex NumClean = new(@"[₹,\s]|^rs\.?|inr", RegexOptions.IgnoreCase);

    public static decimal? ToDecimal(JsonNode? v)
    {
        if (v is JsonValue jv && jv.GetValueKind() is JsonValueKind.True or JsonValueKind.False) return null;
        if (v is JsonValue nv && nv.GetValueKind() == JsonValueKind.Number) return decimal.Parse(nv.ToJsonString(), NumberStyles.Float, Inv);
        var s = NumClean.Replace(J.S(v), "").Trim();
        if (s.StartsWith('(') && s.EndsWith(')')) s = "-" + s[1..^1];
        if (s.Length == 0 || !Regex.IsMatch(s, @"^-?\d+(\.\d+)?$")) return null;
        return decimal.TryParse(s, NumberStyles.Number, Inv, out var d) ? d : null;
    }

    public static string Dec(decimal d) => d.ToString(Inv);

    public static JsonObject Profile(AssistantUploadModel up)
    {
        var sheet = new Sheet(up);
        if (sheet.Columns.Count == 0)
            return J.O(("id", up.Id.ToString()), ("filename", up.Filename), ("kind", "text"), ("characters", up.Text.Length), ("truncated", up.Truncated), ("preview", J.Cut(up.Text, 3000)));
        var cols = new JsonArray();
        for (var i = 0; i < sheet.Columns.Count; i++)
        {
            var values = sheet.Rows.Where(r => i < r.Count && J.S(r[i]) != "").Select(r => r[i]).ToList();
            var nums = values.Select(ToDecimal).Where(d => d.HasValue).Select(d => d!.Value).ToList();
            var isDate = values.Count > 0 && values.Take(50).All(v => Regex.IsMatch(J.S(v), @"^\d{4}-\d{2}-\d{2}") || Regex.IsMatch(J.S(v), @"^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}"));
            var kind = values.Count > 0 && nums.Count >= 0.9 * values.Count ? "number" : isDate ? "date" : "text";
            var info = J.O(("name", sheet.Columns[i]), ("type", kind), ("filled", values.Count), ("empty", up.RowCount - values.Count), ("distinct", values.Select(J.S).Distinct().Count()));
            if (kind == "number" && nums.Count > 0)
            {
                var total = nums.Sum();
                info["sum"] = Dec(total);
                info["min"] = Dec(nums.Min());
                info["max"] = Dec(nums.Max());
                info["average"] = (total / nums.Count).ToString("0.00", Inv);
            }
            else
            {
                info["examples"] = J.Strings(values.Select(J.S).GroupBy(x => x).OrderByDescending(g => g.Count()).Take(3).Select(g => J.Cut(g.Key, 40)));
            }
            cols.Add(info);
        }
        var first = new JsonArray();
        foreach (var r in sheet.Rows.Take(5))
        {
            var o = new JsonObject();
            for (var i = 0; i < Math.Min(sheet.Columns.Count, r.Count); i++) o[sheet.Columns[i]] = r[i]?.DeepClone();
            first.Add(o);
        }
        return J.O(("id", up.Id.ToString()), ("filename", up.Filename), ("kind", "table"), ("rows", up.RowCount), ("truncated", up.Truncated), ("columns", cols), ("first_rows", first));
    }

    private static bool Match(JsonNode? v, string op, JsonNode? want)
    {
        var s = J.S(v).Trim();
        if (op == "is_empty") return s == "";
        if (op == "not_empty") return s != "";
        if (op is "greater_than" or "less_than")
        {
            var (a, b) = (ToDecimal(v), ToDecimal(want));
            if (a is null || b is null) return false;
            return op == "greater_than" ? a > b : a < b;
        }
        var w = J.S(want).Trim().ToLowerInvariant();
        if (op == "contains") return s.ToLowerInvariant().Contains(w);
        var (da, db) = (ToDecimal(v), ToDecimal(want));
        var eq = da.HasValue && db.HasValue ? da == db : s.ToLowerInvariant() == w;
        return op == "equals" ? eq : !eq;
    }

    public static JsonObject Query(AssistantUploadModel up, JsonArray? filters, string? groupBy, string metric, string? valueColumn, string sort, int limit)
    {
        var sheet = new Sheet(up);
        if (sheet.Columns.Count == 0) throw new ArgumentException("This file is plain text, not a table");
        if (!Metrics.Contains(metric)) throw new ArgumentException($"metric is one of {string.Join(", ", Metrics)}");
        var rows = sheet.Rows;
        foreach (var f in (filters ?? []).OfType<JsonObject>())
        {
            var op = J.S(f["op"]) is { Length: > 0 } o ? o : "equals";
            if (!Ops.Contains(op)) throw new ArgumentException($"op is one of {string.Join(", ", Ops)}");
            var i = sheet.Col(J.S(f["column"]));
            rows = rows.Where(r => Match(i < r.Count ? r[i] : JsonValue.Create(""), op, f["value"])).ToList();
        }
        int? vi = string.IsNullOrEmpty(valueColumn) ? null : sheet.Col(valueColumn);
        if (metric != "count" && vi is null) throw new ArgumentException("Say which column to add up (value_column)");
        string Agg(List<List<JsonNode?>> rs)
        {
            if (metric == "count") return rs.Count.ToString(Inv);
            var nums = rs.Select(r => ToDecimal(vi!.Value < r.Count ? r[vi.Value] : null)).Where(d => d.HasValue).Select(d => d!.Value).ToList();
            if (nums.Count == 0) return "0";
            return metric switch
            {
                "sum" => Dec(nums.Sum()), "average" => (nums.Sum() / nums.Count).ToString("0.00", Inv), "min" => Dec(nums.Min()), _ => Dec(nums.Max()),
            };
        }
        limit = Math.Clamp(limit, 1, 500);
        if (!string.IsNullOrEmpty(groupBy))
        {
            var gi = sheet.Col(groupBy);
            var groups = rows.GroupBy(r => gi < r.Count ? J.S(r[gi]) : "").Select(g => (Group: g.Key.Length > 0 ? g.Key : "(blank)", Value: Agg(g.ToList()), Rows: g.Count())).ToList();
            groups = (sort != "asc" ? groups.OrderByDescending(x => decimal.Parse(x.Value, Inv)) : groups.OrderBy(x => decimal.Parse(x.Value, Inv))).ToList();
            return J.O(("matched_rows", rows.Count), ("groups", groups.Count), ("metric", metric), ("value_column", valueColumn),
                ("items", J.A(groups.Take(limit).Select(x => (object?)J.O(("group", x.Group), ("value", x.Value), ("rows", x.Rows))))));
        }
        var sample = new JsonArray();
        foreach (var r in rows.Take(Math.Min(limit, 20)))
        {
            var o = new JsonObject();
            for (var i = 0; i < Math.Min(sheet.Columns.Count, r.Count); i++) o[sheet.Columns[i]] = r[i]?.DeepClone();
            sample.Add(o);
        }
        return J.O(("matched_rows", rows.Count), ("metric", metric), ("value_column", valueColumn), ("value", Agg(rows)), ("sample", sample));
    }

    // ---------------------------------------------------------------- compare with live data

    public static JsonObject Entities => RefData.Obj("upload_entities");
    private static readonly HashSet<string> MoneyFields = ["total", "price", "mrp", "amount"];

    private static string? Guess(Sheet s, IEnumerable<string> names)
    {
        var list = names.ToList();
        var lower = s.Columns.GroupBy(c => c.ToLowerInvariant().Trim()).ToDictionary(g => g.Key, g => g.First());
        foreach (var n in list) if (lower.TryGetValue(n, out var c)) return c;
        foreach (var c in s.Columns) if (list.Any(n => c.ToLowerInvariant().Contains(n))) return c;
        return null;
    }

    private static string NormKey(string entity, string v)
    {
        var s = v.Trim();
        if (entity == "customers")
        {
            if (s.Contains('@')) return s.ToLowerInvariant();
            var digits = new string(s.Where(char.IsDigit).ToArray());
            return digits.Length > 10 ? digits[^10..] : digits;
        }
        return s.ToUpperInvariant();
    }

    private static async Task<Dictionary<string, Dictionary<string, object?>>> LiveAsync(AssistantDAL dal, string entity, List<string> keys)
    {
        var outp = new Dictionary<string, Dictionary<string, object?>>();
        for (var i = 0; i < keys.Count; i += 1000)
        {
            var chunk = keys.Skip(i).Take(1000).ToList();
            var up = chunk.Select(k => k.ToUpperInvariant()).ToList();
            switch (entity)
            {
                case "orders":
                    foreach (var r in await dal.LiveOrdersAsync(up)) outp[r.S("k").ToUpperInvariant()] = new() { ["total"] = r.L("total"), ["status"] = r.S("status"), ["payment"] = r.S("payment") };
                    break;
                case "packages":
                    foreach (var r in await dal.LivePackagesAsync(up)) outp[r.S("k").ToUpperInvariant()] = new() { ["total"] = r.L("total"), ["status"] = r.S("status"), ["awb"] = r.S("awb") };
                    break;
                case "products":
                    foreach (var r in await dal.LiveProductsAsync(up))
                        outp[r.S("k").ToUpperInvariant()] = new() { ["price"] = r.L("price"), ["mrp"] = r.L("mrp"), ["stock"] = r.L("stock"), ["status"] = r.S("status") };
                    break;
                case "payouts":
                    foreach (var r in await dal.LivePayoutsAsync(up))
                    {
                        var rec = new Dictionary<string, object?> { ["amount"] = r.L("amount"), ["status"] = r.S("status"), ["utr"] = r.S("utr") };
                        outp[r.S("number").ToUpperInvariant()] = rec;
                        if (r.S("utr").Length > 0) outp[r.S("utr").ToUpperInvariant()] = rec;
                    }
                    break;
                case "customers":
                {
                    var phones = chunk.Select(k => new string(k.Where(char.IsDigit).ToArray())).Select(d => d.Length > 10 ? d[^10..] : d).ToList();
                    var emails = chunk.Where(k => k.Contains('@')).Select(k => k.ToLowerInvariant()).ToList();
                    foreach (var r in await dal.LiveCustomersAsync(phones, emails))
                    {
                        var rec = new Dictionary<string, object?> { ["orders"] = r.L("orders"), ["name"] = r.S("name") };
                        if (r.S("phone").Length > 0) outp[r.S("phone")] = rec;
                        if (r.S("email").Length > 0) outp[r.S("email").ToLowerInvariant()] = rec;
                    }
                    break;
                }
                case "sellers":
                    foreach (var r in await dal.LiveSellersAsync(up)) outp[r.S("k").ToUpperInvariant()] = new() { ["status"] = r.S("status"), ["store"] = r.S("store") };
                    break;
            }
        }
        return outp;
    }

    /// <summary>
    /// Matches every row of the file to live records and lists what differs. Money in the file is in rupees; live money
    /// is converted from paise before comparing. Differences under ₹0.01 are ignored.
    /// </summary>
    public static async Task<JsonObject> CompareAsync(AssistantDAL dal, AssistantUploadModel up, string entity, string? keyColumn, JsonObject? columns, int limit = 100)
    {
        if (Entities[entity] is not JsonObject spec) throw new ArgumentException($"entity is one of {string.Join(", ", Entities.Select(e => e.Key))}");
        var sheet = new Sheet(up);
        if (sheet.Columns.Count == 0) throw new ArgumentException("This file is plain text, not a table");
        var keyCol = !string.IsNullOrEmpty(keyColumn) ? keyColumn : Guess(sheet, (spec["headers"] as JsonArray ?? []).Select(J.S));
        if (string.IsNullOrEmpty(keyCol))
            throw new ArgumentException($"Which column holds the {J.S(spec["key"])}? Columns are: {string.Join(", ", sheet.Columns.Take(40))}");
        var ki = sheet.Col(keyCol);
        var fieldsSpec = (JsonObject)spec["fields"]!;
        var mapping = new Dictionary<string, string>();
        if (columns is { Count: > 0 })
            foreach (var (k, v) in columns) mapping[k] = J.S(v);
        else
            foreach (var (field, names) in fieldsSpec)
                if (Guess(sheet, (names as JsonArray ?? []).Select(J.S)) is { } c && c != keyCol) mapping[field] = c;
        foreach (var f in mapping.Keys)
            if (!fieldsSpec.ContainsKey(f)) throw new ArgumentException($"For {entity} you can compare: {string.Join(", ", fieldsSpec.Select(x => x.Key))}");
        var idx = mapping.ToDictionary(kv => kv.Key, kv => sheet.Col(kv.Value));
        var keys = sheet.Rows.Where(r => ki < r.Count && sheet.Get(r, ki).Trim().Length > 0).Select(r => NormKey(entity, sheet.Get(r, ki))).Distinct().ToList();
        var live = await LiveAsync(dal, entity, keys);
        int matched = 0, missing = 0, differing = 0;
        var diffs = new JsonArray();
        var notFound = new List<string>();
        var totals = idx.Keys.Where(f => MoneyFields.Contains(f) || f is "stock" or "orders").ToDictionary(f => f, _ => (File: 0m, Live: 0m));
        var seen = new Dictionary<string, int>();
        var seenOrder = new List<string>();
        foreach (var r in sheet.Rows)
        {
            var raw = sheet.Get(r, ki);
            var k = NormKey(entity, raw);
            if (k.Length == 0) continue;
            if (!seen.ContainsKey(k)) seenOrder.Add(k);
            seen[k] = seen.GetValueOrDefault(k) + 1;
            if (!live.TryGetValue(k, out var rec))
            {
                missing++;
                if (notFound.Count < limit) notFound.Add(raw);
                continue;
            }
            matched++;
            var rowDiffs = new JsonArray();
            foreach (var (f, i) in idx)
            {
                var fv = i < r.Count ? r[i] : JsonValue.Create("");
                var lv = rec.GetValueOrDefault(f);
                if (MoneyFields.Contains(f))
                {
                    var a = ToDecimal(fv);
                    var b = AiDAL.N(lv) / 100m;
                    if (a.HasValue) totals[f] = (totals[f].File + a.Value, totals[f].Live + b);
                    if (a is null || Math.Abs(a.Value - b) >= 0.01m) rowDiffs.Add(J.O(("field", f), ("file", J.S(fv)), ("live", b.ToString("0.00", Inv))));
                }
                else if (f is "stock" or "orders")
                {
                    var a = ToDecimal(fv);
                    var b = (decimal)AiDAL.N(lv);
                    if (a.HasValue) totals[f] = (totals[f].File + a.Value, totals[f].Live + b);
                    if (a is null || a.Value != b) rowDiffs.Add(J.O(("field", f), ("file", J.S(fv)), ("live", Convert.ToString(lv, Inv))));
                }
                else if (J.S(fv).Trim().ToLowerInvariant() != (Convert.ToString(lv, Inv) ?? "").Trim().ToLowerInvariant())
                {
                    rowDiffs.Add(J.O(("field", f), ("file", J.S(fv)), ("live", Convert.ToString(lv, Inv) ?? "")));
                }
            }
            if (rowDiffs.Count > 0)
            {
                differing++;
                if (diffs.Count < limit) diffs.Add(J.O(("key", raw), ("differences", rowDiffs)));
            }
        }
        var totalsOut = new JsonObject();
        foreach (var (f, v) in totals)
            totalsOut[f] = J.O(("file", v.File.ToString("0.00", Inv)), ("live", v.Live.ToString("0.00", Inv)), ("difference", (v.File - v.Live).ToString("0.00", Inv)));
        var mapOut = new JsonObject();
        foreach (var (k, v) in mapping) mapOut[k] = v;
        return J.O(("entity", entity), ("key_column", keyCol), ("compared_columns", mapOut), ("file_rows", up.RowCount), ("rows_with_key", seen.Values.Sum()),
            ("matched", matched), ("not_found_in_live", missing), ("rows_with_differences", differing), ("rows_identical", matched - differing),
            ("duplicate_keys_in_file", J.Strings(seenOrder.Where(k => seen[k] > 1).Take(20))), ("totals", totalsOut), ("differences", diffs), ("not_found", J.Strings(notFound)));
    }
}
