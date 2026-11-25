namespace BAL;

using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.AI;
using DAL;
using Utils;

/// <summary>
/// The assistant tools that read reports, settings, exports and uploaded files (reference: app/assistant/tools.py
/// gst_tcs_report, marketplace_settings, prepare_export, file_query, file_compare), so every one of the 25 tools the
/// model is offered can run.
/// </summary>
public partial class AssistantToolsBAL
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private static AssistantToolOutput Error(string message) => new(new JsonObject { ["error"] = message }, []);

    private static string PyStr(JsonNode? n) => AssistantPrompts.PyStr(n);

    private static JsonArray Cells(params object?[] cells) => new(cells.Select(J.Node).ToArray());

    // ----------------------------------------------------------------------------- reports and settings

    /// <summary>Reference: tools.gst_tcs_report.</summary>
    private async Task<AssistantToolOutput> GstTcsReportAsync(AssistantToolContext ctx, JsonObject a)
    {
        var month = a.ContainsKey("month") ? PyStr(a["month"]) : "";
        if (!Regex.IsMatch(month, @"^\d{4}-(0[1-9]|1[0-2])$"))
            return Error("month must look like 2026-10");
        var data = await tcs.DataAsync(month);
        string Inr(JsonNode? n) => AssistantQueriesDAL.Inr(J.Double(n) ?? 0);
        var rows = (data["items"] as JsonArray ?? []).OfType<JsonObject>().Select(i => Cells(
            i["gstin"], i["legal_name"], i["sub_orders"], Inr(i["returned_value"]), Inr(i["net_taxable_value"]),
            Inr(i["igst_tcs"]), Inr(i["cgst_tcs"]), Inr(i["sgst_tcs"])));
        return new(data, [TableCard($"GST TCS {month}", ["GSTIN", "Legal name", "Packages", "Returned", "Net taxable", "IGST TCS", "CGST TCS", "SGST TCS"],
            rows, link: "/admin/reports")]);
    }

    /// <summary>Python's f"{x:g}".</summary>
    private static string G(double x)
    {
        var s = x.ToString("G6", Inv);
        return s.Contains('E') ? Regex.Replace(s, @"E([+-])(\d)$", "e${1}0$2").Replace("E", "e") : s;
    }

    /// <summary>Reference: tools.marketplace_settings — settings, connected integrations (never their keys).</summary>
    private async Task<AssistantToolOutput> MarketplaceSettingsAsync(AssistantToolContext ctx, JsonObject a)
    {
        var cfg = (JsonObject)(await platform.GetAsync()).DeepClone();
        var integ = new JsonArray();
        if (ctx.Permissions.Contains("integrations"))
            foreach (var i in await integrations.StatusAsync())
                integ.Add(new JsonObject { ["name"] = J.Node(i.GetValueOrDefault("name")), ["on"] = J.Node(i.GetValueOrDefault("ready")), ["mode"] = J.Node(i.GetValueOrDefault("mode")) });
        var show = cfg.Select(kv =>
        {
            var (k, v) = (kv.Key, kv.Value);
            var value = k.EndsWith("_paise") ? AssistantQueriesDAL.Inr(J.Double(v) ?? 0)
                : k.EndsWith("_bps") ? G((J.Double(v) ?? 0) / 100) + "%"
                : J.IsBool(v) ? (J.Truthy(v) ? "on" : "off")
                : PyStr(v);
            return Cells(k.Replace("_", " "), value);
        }).ToList();
        var cards = new List<JsonObject> { TableCard("Marketplace settings", ["Setting", "Value"], show, link: "/admin/settings") };
        if (integ.Count > 0)
            cards.Add(TableCard("Integrations", ["Integration", "Connected", "Mode"],
                integ.OfType<JsonObject>().Select(i => Cells(i["name"], J.Truthy(i["on"]) ? "yes" : "no", i["mode"])), link: "/admin/integrations"));
        return new(new JsonObject
        {
            ["settings"] = cfg, ["integrations"] = integ, ["setting_keys_note"] = "*_paise are paise, *_bps are basis points (100 = 1%)",
        }, cards);
    }

    // ----------------------------------------------------------------------------- exports

    /// <summary>Python's urllib.parse.quote_plus.</summary>
    private static string QuotePlus(string s)
    {
        var b = new StringBuilder();
        foreach (var by in Encoding.UTF8.GetBytes(s))
        {
            var c = (char)by;
            if (c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '.' or '-' or '~') b.Append(c);
            else if (c == ' ') b.Append('+');
            else b.Append('%').Append(by.ToString("X2"));
        }
        return b.ToString();
    }

    /// <summary>Reference: tools.prepare_export — a download button for an admin export, with the same filters and checks.</summary>
    private async Task<AssistantToolOutput> PrepareExportAsync(AssistantToolContext ctx, JsonObject a)
    {
        var admin = ExportDefinitions.All.Where(s => s.Scope == "admin").ToList();
        var name = PyStr(a["name"]);
        var spec = admin.FirstOrDefault(s => s.Name == name);
        if (spec is null)
            return Error($"Unknown export. Choose from: {string.Join(", ", admin.Select(s => s.Name))}");
        if (!ctx.Permissions.Contains(spec.Permission))
            return Error($"Your role cannot download {spec.Label}.");
        var fmt = J.Truthy(a["format"]) ? PyStr(a["format"]) : "xlsx";
        var query = new List<(string Key, string Value)>();
        if (spec.NeedsMonth)
        {
            query.Add(("month", J.Truthy(a["month"]) ? PyStr(a["month"]) : ""));
        }
        else if (spec.DateLabel.Length > 0)
        {
            var p = PeriodArg(a, "last_30_days");
            query.Add(("from", p.FirstDay.ToString("yyyy-MM-dd", Inv)));
            query.Add(("to", p.LastDay.ToString("yyyy-MM-dd", Inv)));
        }
        foreach (var k in new[] { "status", "q", "payment_method", "low_stock" })
            if (a[k] is { } v && !(v is JsonValue sv && sv.TryGetValue<string>(out var s0) && s0.Length == 0) && (k == "status" || spec.Filters.Contains(k)))
                query.Add((k, PyStr(v)));
        if (J.Truthy(a["seller"]) && spec.Filters.Contains("seller") && await q.ResolveSellerAsync(PyStr(a["seller"])) is { } seller)
            query.Add(("seller", seller.Id));
        foreach (var c in a["columns"] as JsonArray ?? [])
            if (c is JsonValue cv && cv.TryGetValue<string>(out var col) && spec.Headers.Contains(col))
                query.Add(("columns", col));
        var first = query.GroupBy(x => x.Key).ToDictionary(g => g.Key, g => g.Last().Value); // dict(q)
        var extra = new Dictionary<string, string?>();
        foreach (var (k, v) in query)
            if (k is not ("from" or "to" or "month" or "columns")) extra[k] = v;
        var status = extra.Remove("status", out var st) ? st : null;
        ExportDefinitions.Context exportCtx;
        try
        {
            exportCtx = ExportDefinitions.Parse(spec, null,
                first.TryGetValue("from", out var from) && from.Length > 0 ? DateOnly.ParseExact(from, "yyyy-MM-dd", Inv) : null,
                first.TryGetValue("to", out var to) && to.Length > 0 ? DateOnly.ParseExact(to, "yyyy-MM-dd", Inv) : null,
                status, first.GetValueOrDefault("month"), extra);
            ExportDefinitions.PickColumns(spec, query.Where(x => x.Key == "columns").Select(x => x.Value).ToList(), fmt);
        }
        catch (ArgumentException exc)
        {
            return Error(exc.Message);
        }
        var path = $"/api/admin/exports/{spec.Name}.{fmt}?" + string.Join("&", query.Select(x => QuotePlus(x.Key) + "=" + QuotePlus(x.Value)));
        var summary = string.Join(" · ", ExportDefinitions.Summary(spec, exportCtx).Select(x => $"{x.Key}: {x.Value}"));
        var card = new JsonObject
        {
            ["type"] = "file", ["title"] = spec.Label, ["format"] = fmt, ["path"] = path, ["filename"] = $"{spec.Name}.{fmt}", ["detail"] = summary,
        };
        return new(new JsonObject { ["ready"] = true, ["export"] = spec.Label, ["format"] = fmt, ["filters"] = summary }, [card]);
    }

    // ----------------------------------------------------------------------------- files

    /// <summary>Reference: tools._upload — the named upload, else the latest one attached to this message; only the person's own.</summary>
    private async Task<Model.DomainModel.AssistantUploadModel?> UploadArgAsync(AssistantToolContext ctx, JsonObject a)
    {
        var id = Str(a, "file_id") ?? ctx.UploadIds.LastOrDefault();
        return Guid.TryParse(id, out var fid) ? await uploads.OwnAsync(ctx.UserId, fid, DateTime.UtcNow) : null;
    }

    /// <summary>Reference: tools.file_query.</summary>
    private async Task<AssistantToolOutput> FileQueryAsync(AssistantToolContext ctx, JsonObject a)
    {
        var up = await UploadArgAsync(ctx, a);
        if (up is null) return Error("No uploaded file found.");
        JsonObject outp;
        var groupBy = J.Truthy(a["group_by"]) ? PyStr(a["group_by"]) : null;
        try
        {
            outp = AssistantUploadAnalysis.Query(up, a["filters"] as JsonArray, groupBy,
                a.ContainsKey("metric") ? PyStr(a["metric"]) : "count", J.Truthy(a["value_column"]) ? PyStr(a["value_column"]) : null,
                a.ContainsKey("sort") ? PyStr(a["sort"]) : "desc", LimitArg(a, 50, 500));
        }
        catch (ArgumentException exc)
        {
            return Error(exc.Message);
        }
        var metric = outp["metric"]!.GetValue<string>();
        var valueColumn = outp["value_column"] is JsonValue vc && vc.TryGetValue<string>(out var vcs) && vcs.Length > 0 ? vcs : null;
        var label = metric + (valueColumn is not null ? " of " + valueColumn : "");
        List<JsonObject> cards;
        if (outp["items"] is JsonArray items)
        {
            var list = items.OfType<JsonObject>().ToList();
            var by = groupBy ?? "None";
            cards =
            [
                TableCard($"{up.Filename}: {label} by {by}", [by, label, "Rows"],
                    list.Select(i => Cells(i["group"], i["value"], i["rows"])), note: $"{outp["matched_rows"]!.GetValue<int>().ToString("#,0", Inv)} rows matched."),
                ChartCard($"{label} by {by}", "bar", list.Take(20).Select(i => i["group"]!.GetValue<string>()),
                    [(label, list.Take(20).Select(i => double.Parse(i["value"]!.GetValue<string>(), Inv)))]),
            ];
        }
        else
        {
            // Python's str.capitalize(): the first letter upper case, the rest lower case
            var cap = label.Length > 0 ? char.ToUpperInvariant(label[0]) + label[1..].ToLowerInvariant() : label;
            cards = [MetricsCard(up.Filename, [(cap, outp["value"]!.GetValue<string>(), null), ("Rows matched", outp["matched_rows"]!.GetValue<int>().ToString("#,0", Inv), null)])];
        }
        return new(outp, cards);
    }

    /// <summary>Reference: tools.file_compare.</summary>
    private async Task<AssistantToolOutput> FileCompareAsync(AssistantToolContext ctx, JsonObject a)
    {
        var up = await UploadArgAsync(ctx, a);
        if (up is null) return Error("No uploaded file found.");
        var entity = PyStr(a["entity"]);
        var need = entity switch
        {
            "orders" or "packages" => "orders", "products" => "catalog", "payouts" => "payouts", "customers" => "customers", "sellers" => "sellers", _ => "",
        };
        if (need.Length > 0 && !ctx.Permissions.Contains(need))
            return Error($"Your role cannot read live {entity}.");
        JsonObject outp;
        try
        {
            outp = await AssistantUploadAnalysis.CompareAsync(q, up, entity, J.Truthy(a["key_column"]) ? PyStr(a["key_column"]) : null, a["columns"] as JsonObject);
        }
        catch (ArgumentException exc)
        {
            return Error(exc.Message);
        }
        string Num(string key) => AssistantQueriesDAL.Num(outp[key]!.GetValue<int>());
        var items = new List<(string, string, string?)>
        {
            ("Rows with a key", Num("rows_with_key"), null), ("Matched", Num("matched"), null), ("Identical", Num("rows_identical"), null),
            ("Different", Num("rows_with_differences"), null), ("Not found live", Num("not_found_in_live"), null),
        };
        foreach (var (f, v) in outp["totals"]!.AsObject())
            items.Add(($"{f} total (file / live)", $"{v!["file"]} / {v["live"]}", $"difference {v["difference"]}"));
        var compared = string.Join(", ", outp["compared_columns"]!.AsObject().Select(kv => $"{kv.Key} ← {PyStr(kv.Value)}"));
        var cards = new List<JsonObject>
        {
            MetricsCard($"{up.Filename} vs live {outp["entity"]}", items,
                note: $"Matched on column “{outp["key_column"]}”. Compared: {(compared.Length > 0 ? compared : "presence only")}."),
        };
        var diffs = outp["differences"]!.AsArray();
        if (diffs.Count > 0)
            cards.Add(TableCard("Differences", ["Key", "Field", "In file", "Live"],
                diffs.OfType<JsonObject>().SelectMany(d => d["differences"]!.AsArray().OfType<JsonObject>().Select(x => Cells(d["key"], x["field"], x["file"], x["live"])))));
        var notFound = outp["not_found"]!.AsArray();
        if (notFound.Count > 0)
            cards.Add(TableCard("Not found in live data", ["Key"], notFound.Select(k => Cells(k))));
        return new(outp, cards);
    }
}

/// <summary>Exact calculations over an uploaded table and its comparison with live records (reference: assistant/uploads.py
/// query, compare, _guess, _col, _match, _norm_key). Failures the person can fix are <see cref="ArgumentException"/>s
/// (the reference's ValueError) with the reference's messages.</summary>
public static class AssistantUploadAnalysis
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static readonly string[] Ops = ["equals", "not_equals", "contains", "greater_than", "less_than", "is_empty", "not_empty"];
    public static readonly string[] Metrics = ["count", "sum", "average", "min", "max"];

    private sealed record EntitySpec(string Key, string[] Headers, (string Field, string[] Names)[] Fields);

    private static readonly Dictionary<string, EntitySpec> Entities = new()
    {
        ["orders"] = new("order number", ["order", "order number", "order no", "order_no", "order id", "order_id"],
            [("total", ["order total", "grand total", "total", "amount", "value"]), ("status", ["status", "order status"]), ("payment", ["payment", "payment method", "mode"])]),
        ["packages"] = new("package number", ["package", "package number", "sub order", "suborder", "shipment"],
            [("total", ["package total", "total", "amount"]), ("status", ["status"]), ("awb", ["awb", "tracking", "tracking number"])]),
        ["products"] = new("SKU", ["sku", "seller sku", "item sku", "product sku"],
            [("price", ["price", "selling price", "sale price"]), ("mrp", ["mrp"]), ("stock", ["stock", "quantity", "qty", "inventory"]), ("status", ["status"])]),
        ["payouts"] = new("payout number or UTR", ["payout", "payout number", "utr", "reference", "utr number"],
            [("amount", ["amount", "payout amount", "value"]), ("status", ["status"]), ("utr", ["utr"])]),
        ["customers"] = new("mobile or email", ["mobile", "phone", "email", "customer phone", "contact"],
            [("orders", ["orders", "order count"]), ("name", ["name", "customer name"])]),
        ["sellers"] = new("GSTIN", ["gstin", "gst", "gst number"], [("status", ["status"]), ("store", ["store", "store name", "seller", "name"])]),
    };

    private static readonly HashSet<string> MoneyFields = ["total", "price", "mrp", "amount"];

    private static string S(JsonNode? n) => AssistantPrompts.PyStr(n);

    private static decimal? Dec(JsonNode? n) => AssistantUploadBAL.Number(n);

    private static string Dec2(decimal d) => Math.Round(d, 2, MidpointRounding.ToEven).ToString("F2", Inv);

    private static (List<string> Columns, List<JsonArray> Rows) Table(Model.DomainModel.AssistantUploadModel up) =>
        ((J.Parse(up.Columns) as JsonArray ?? []).Select(c => S(c)).ToList(), (J.Parse(up.Rows) as JsonArray ?? []).OfType<JsonArray>().ToList());

    private static JsonNode? Cell(JsonArray r, int i) => i < r.Count ? r[i] : JsonValue.Create("");

    /// <summary>Reference: uploads._col.</summary>
    private static int Col(List<string> columns, string name)
    {
        for (var i = 0; i < columns.Count; i++)
            if (columns[i].ToLowerInvariant() == name.Trim().ToLowerInvariant()) return i;
        throw new ArgumentException($"No column named '{name}'. Columns are: {string.Join(", ", columns.Take(40))}");
    }

    /// <summary>Reference: uploads._match.</summary>
    private static bool Match(JsonNode? v, string op, JsonNode? want)
    {
        var s = (v is null ? "" : S(v)).Trim();
        if (op == "is_empty") return s.Length == 0;
        if (op == "not_empty") return s.Length > 0;
        if (op is "greater_than" or "less_than")
        {
            var (x, y) = (Dec(v), Dec(want));
            if (x is null || y is null) return false;
            return op == "greater_than" ? x > y : x < y;
        }
        var w = (want is null ? "" : S(want)).Trim().ToLowerInvariant();
        if (op == "contains") return s.ToLowerInvariant().Contains(w);
        var (da, db) = (Dec(v), Dec(want));
        var eq = da is not null && db is not null ? da == db : s.ToLowerInvariant() == w;
        return op == "equals" ? eq : !eq;
    }

    private static JsonObject Zip(List<string> columns, JsonArray r)
    {
        var o = new JsonObject();
        for (var i = 0; i < Math.Min(columns.Count, r.Count); i++) o[columns[i]] = r[i]?.DeepClone();
        return o;
    }

    /// <summary>Reference: uploads.query — count, sum, average, min or max, optionally filtered and grouped.</summary>
    public static JsonObject Query(Model.DomainModel.AssistantUploadModel up, JsonArray? filters, string? groupBy, string metric, string? valueColumn, string sort, int limit)
    {
        var (columns, all) = Table(up);
        if (columns.Count == 0) throw new ArgumentException("This file is plain text, not a table");
        if (!Metrics.Contains(metric)) throw new ArgumentException($"metric is one of {string.Join(", ", Metrics)}");
        var rows = all;
        foreach (var f in (filters ?? []).OfType<JsonObject>())
        {
            var op = f.ContainsKey("op") ? S(f["op"]) : "equals";
            if (!Ops.Contains(op)) throw new ArgumentException($"op is one of {string.Join(", ", Ops)}");
            var i = Col(columns, f.ContainsKey("column") ? S(f["column"]) : "");
            rows = rows.Where(r => Match(Cell(r, i), op, f["value"])).ToList();
        }
        int? vi = valueColumn is not null ? Col(columns, valueColumn) : null;
        if (metric != "count" && vi is null) throw new ArgumentException("Say which column to add up (value_column)");

        string Agg(List<JsonArray> rs)
        {
            if (metric == "count") return rs.Count.ToString(Inv);
            var nums = rs.Select(r => Dec(Cell(r, vi!.Value))).Where(d => d is not null).Select(d => d!.Value).ToList();
            if (nums.Count == 0) return "0";
            var sum = nums.Aggregate(0m, (x, y) => x + y);
            return metric switch
            {
                "sum" => sum.ToString(Inv),
                "average" => Math.Round(sum / nums.Count, 2, MidpointRounding.ToEven).ToString("F2", Inv),
                "min" => nums.Min().ToString(Inv),
                _ => nums.Max().ToString(Inv),
            };
        }

        limit = Math.Max(1, Math.Min(limit, 500));
        if (groupBy is not null)
        {
            var gi = Col(columns, groupBy);
            var groups = new List<(string Key, List<JsonArray> Rows)>();
            var index = new Dictionary<string, int>();
            foreach (var r in rows)
            {
                var k = gi < r.Count ? S(r[gi]) : "";
                if (!index.TryGetValue(k, out var at)) { index[k] = at = groups.Count; groups.Add((k, [])); }
                groups[at].Rows.Add(r);
            }
            var items = groups.Select(g => (Group: g.Key.Length > 0 ? g.Key : "(blank)", Value: Agg(g.Rows), Rows: g.Rows.Count)).ToList();
            items = (sort != "asc" ? items.OrderByDescending(x => decimal.Parse(x.Value, NumberStyles.Float, Inv)) : items.OrderBy(x => decimal.Parse(x.Value, NumberStyles.Float, Inv))).ToList();
            return new JsonObject
            {
                ["matched_rows"] = rows.Count, ["groups"] = items.Count, ["metric"] = metric, ["value_column"] = valueColumn,
                ["items"] = new JsonArray(items.Take(limit).Select(x => (JsonNode)new JsonObject { ["group"] = x.Group, ["value"] = x.Value, ["rows"] = x.Rows }).ToArray()),
            };
        }
        return new JsonObject
        {
            ["matched_rows"] = rows.Count, ["metric"] = metric, ["value_column"] = valueColumn, ["value"] = Agg(rows),
            ["sample"] = new JsonArray(rows.Take(Math.Min(limit, 20)).Select(r => (JsonNode)Zip(columns, r)).ToArray()),
        };
    }

    /// <summary>Reference: uploads._guess — the column named like one of the names (exact first, then containing).</summary>
    private static string? Guess(List<string> columns, string[] names)
    {
        var lower = new Dictionary<string, string>();
        foreach (var c in columns) lower[c.ToLowerInvariant().Trim()] = c;
        foreach (var n in names)
            if (lower.TryGetValue(n, out var hit)) return hit;
        return columns.FirstOrDefault(c => names.Any(n => c.ToLowerInvariant().Contains(n)));
    }

    /// <summary>Reference: uploads._norm_key.</summary>
    private static string NormKey(string entity, JsonNode? v)
    {
        var s = (v is null ? "" : S(v)).Trim();
        if (s == "None") s = "";
        if (entity == "customers")
        {
            if (s.Contains('@')) return s.ToLowerInvariant();
            var d = Regex.Replace(s, @"\D", "");
            return d.Length > 10 ? d[^10..] : d;
        }
        return s.ToUpperInvariant();
    }

    private static string LiveText(object? v) => v switch { null => "", string s => s, _ => Convert.ToString(v, Inv) ?? "" };

    /// <summary>
    /// Reference: uploads.compare — matches every row of the file to live records and lists what differs. Money in the
    /// file is in rupees; live money is converted from paise before comparing. Differences under ₹0.01 are ignored.
    /// </summary>
    public static async Task<JsonObject> CompareAsync(AssistantQueriesDAL q, Model.DomainModel.AssistantUploadModel up, string entity, string? keyColumn,
        JsonObject? columnsArg, int limit = 100)
    {
        if (!Entities.TryGetValue(entity, out var spec)) throw new ArgumentException($"entity is one of {string.Join(", ", Entities.Keys)}");
        var (columns, rows) = Table(up);
        if (columns.Count == 0) throw new ArgumentException("This file is plain text, not a table");
        var keyCol = keyColumn ?? Guess(columns, spec.Headers)
            ?? throw new ArgumentException($"Which column holds the {spec.Key}? Columns are: {string.Join(", ", columns.Take(40))}");
        var ki = Col(columns, keyCol);
        var mapping = new List<(string Field, string Column)>();
        foreach (var (k, v) in columnsArg ?? []) mapping.Add((k, S(v)));
        if (mapping.Count == 0)
            foreach (var (field, names) in spec.Fields)
                if (Guess(columns, names) is { } c && c != keyCol) mapping.Add((field, c));
        foreach (var (field, _) in mapping)
            if (!spec.Fields.Any(x => x.Field == field)) throw new ArgumentException($"For {entity} you can compare: {string.Join(", ", spec.Fields.Select(x => x.Field))}");
        var idx = mapping.Select(m => (m.Field, Index: Col(columns, m.Column))).ToList();
        var keys = rows.Where(r => ki < r.Count && S(r[ki]).Trim().Length > 0).Select(r => NormKey(entity, r[ki])).Distinct().ToList();
        var live = keys.Count > 0 ? await q.CompareLiveAsync(entity, keys) : [];
        int matched = 0, missing = 0, differing = 0;
        var diffs = new JsonArray();
        var notFound = new JsonArray();
        var totals = idx.Where(x => MoneyFields.Contains(x.Field) || x.Field is "stock" or "orders")
            .ToDictionary(x => x.Field, _ => new decimal[2]); // file, live
        var seenCount = new Dictionary<string, int>();
        foreach (var r in rows)
        {
            var raw = ki < r.Count ? r[ki] : JsonValue.Create("");
            var k = NormKey(entity, raw);
            if (k.Length == 0) continue;
            if (!seenCount.TryAdd(k, 1)) seenCount[k]++;
            if (!live.TryGetValue(k, out var rec))
            {
                missing++;
                if (notFound.Count < limit) notFound.Add(S(raw));
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
                    var (a, b) = (Dec(fv), Convert.ToInt64(lv ?? 0L, Inv) / 100m);
                    if (a is not null)
                    {
                        totals[f][0] += a.Value;
                        totals[f][1] += b;
                    }
                    if (a is null || Math.Abs(a.Value - b) >= 0.01m)
                        rowDiffs.Add(new JsonObject { ["field"] = f, ["file"] = S(fv), ["live"] = Dec2(b) });
                }
                else if (f is "stock" or "orders")
                {
                    var a = Dec(fv);
                    var liveN = Convert.ToInt64(lv ?? 0L, Inv);
                    if (a is not null)
                    {
                        totals[f][0] += a.Value;
                        totals[f][1] += liveN;
                    }
                    if (a is null || a.Value != liveN)
                        rowDiffs.Add(new JsonObject { ["field"] = f, ["file"] = S(fv), ["live"] = lv is null ? "None" : LiveText(lv) });
                }
                else if (S(fv).Trim().ToLowerInvariant() != LiveText(lv).Trim().ToLowerInvariant())
                {
                    rowDiffs.Add(new JsonObject { ["field"] = f, ["file"] = S(fv), ["live"] = LiveText(lv) });
                }
            }
            if (rowDiffs.Count > 0)
            {
                differing++;
                if (diffs.Count < limit) diffs.Add(new JsonObject { ["key"] = S(raw), ["differences"] = rowDiffs });
            }
        }
        var dupes = seenCount.Where(kv => kv.Value > 1).Select(kv => kv.Key).Take(20).ToList();
        var totalsOut = new JsonObject();
        foreach (var (f, v) in totals)
            totalsOut[f] = new JsonObject { ["file"] = Dec2(v[0]), ["live"] = Dec2(v[1]), ["difference"] = Dec2(v[0] - v[1]) };
        var compared = new JsonObject();
        foreach (var (f, c) in mapping) compared[f] = c;
        return new JsonObject
        {
            ["entity"] = entity, ["key_column"] = keyCol, ["compared_columns"] = compared, ["file_rows"] = up.RowCount,
            ["rows_with_key"] = seenCount.Values.Sum(), ["matched"] = matched, ["not_found_in_live"] = missing,
            ["rows_with_differences"] = differing, ["rows_identical"] = matched - differing,
            ["duplicate_keys_in_file"] = new JsonArray(dupes.Select(d => (JsonNode)JsonValue.Create(d)!).ToArray()),
            ["totals"] = totalsOut, ["differences"] = diffs, ["not_found"] = notFound,
        };
    }
}
