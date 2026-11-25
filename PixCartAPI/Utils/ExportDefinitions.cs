using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
namespace Utils;

/// <summary>Source-derived export definitions and pure filter/column semantics. No data read or route by itself.</summary>
public static class ExportDefinitions
{
    public const int MaxRangeDays = 366, Batch = 1000, MaxRows = 1_000_000;
    public static readonly string[] Formats = ["csv", "xlsx", "pdf"];
    public sealed record Spec(string Name, string Label, string Description, string Scope, string Permission,
        IReadOnlyList<string> Headers, string DateLabel, IReadOnlyList<(string Value, string Label)> Statuses,
        bool NeedsMonth, bool PersonalData, bool DateOptional, IReadOnlyList<string> Filters, IReadOnlyList<string> PdfColumns);
    /// <summary>Start inclusive/end exclusive in UTC, with whole IST dates preserved for labels.</summary>
    public sealed record Context(Guid? SellerId, DateTimeOffset? Start, DateTimeOffset? End, string? Status, string? Month, IReadOnlyDictionary<string, object> Extra);
    private static readonly JsonObject Source;
    public static readonly IReadOnlyList<Spec> All;
    static ExportDefinitions()
    {
        using var input = typeof(ExportDefinitions).Assembly.GetManifestResourceStream("Utils.Assets.export-definitions.json")!;
        Source = JsonNode.Parse(input)!.AsObject();
        static string Text(JsonObject o, string k) => o[k]?.GetValue<string>() ?? "";
        static bool Flag(JsonObject o, string k) => o[k]?.GetValue<bool>() ?? false;
        static List<string> List(JsonObject o, string k) => (o[k] as JsonArray ?? []).Select(n => n!.GetValue<string>()).ToList();
        All = Source["specs"]!.AsArray().OfType<JsonObject>().Select(o => new Spec(Text(o,"name"),Text(o,"label"),Text(o,"description"),Text(o,"scope"),Text(o,"permission"),List(o,"headers"),Text(o,"date_label"),
            (o["statuses"] as JsonArray ?? []).Select(n => (n![0]!.GetValue<string>(),n[1]!.GetValue<string>())).ToList(), Flag(o,"needs_month"), Flag(o,"contains_personal_data"),Flag(o,"date_optional"),List(o,"filters"),List(o,"pdf_columns"))).ToList();
    }
    public static IReadOnlyList<string> DefaultPdfColumns(Spec s) => s.PdfColumns.Count > 0 ? s.PdfColumns : s.Headers.Take(ReportPdf.MaxColumns).ToList();
    public static JsonObject Describe(Spec s) => new()
    {
        ["name"] = s.Name, ["label"] = s.Label, ["description"] = s.Description,
        ["columns"] = new JsonArray(s.Headers.Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
        ["date_filter"] = s.DateLabel, ["statuses"] = new JsonArray(s.Statuses.Select(x => (JsonNode)new JsonObject { ["value"] = x.Value, ["label"] = x.Label }).ToArray()),
        ["needs_month"] = s.NeedsMonth, ["personal_data"] = s.PersonalData, ["date_optional"] = s.DateOptional,
        ["filters"] = new JsonArray(s.Filters.Select(k => { var f = Source["filters"]![k]!.DeepClone().AsObject(); f["key"] = k; return (JsonNode)f; }).ToArray()),
        ["formats"] = new JsonArray(Formats.Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
        ["pdf_columns"] = new JsonArray(DefaultPdfColumns(s).Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
        ["pdf_max_columns"] = ReportPdf.MaxColumns, ["pdf_max_rows"] = ReportPdf.MaxRows,
    };
    private static string Label(string key) => Source["filters"]?[key]?["label"]?.GetValue<string>() ?? key;
    public static Context Parse(Spec spec, Guid? sellerId = null, DateOnly? from = null, DateOnly? to = null,
        string? status = null, string? month = null, IReadOnlyDictionary<string, string?>? extra = null, DateOnly? today = null)
    {
        if (!string.IsNullOrEmpty(status) && !spec.Statuses.Any(s => s.Value == status)) throw new ArgumentException("That status cannot be used for this export");
        var clean = new Dictionary<string, object>();
        foreach (var (key, raw) in extra ?? new Dictionary<string, string?>())
        {
            if (string.IsNullOrEmpty(raw)) continue;
            if (!spec.Filters.Contains(key)) throw new ArgumentException("This export cannot be filtered by " + Label(key).ToLowerInvariant());
            if (key is "seller" or "category")
            {
                if (!Guid.TryParse(raw, out var id)) throw new ArgumentException("Choose a " + Label(key).ToLowerInvariant() + " from the list"); clean[key] = id;
            }
            else if (key == "payment_method")
            {
                if (raw is not ("cod" or "online")) throw new ArgumentException("Payment must be cod or online"); clean[key] = raw;
            }
            else if (key == "q")
            {
                var q = Regex.Replace(raw.Trim(), @"\s+", " "); q = q[..Math.Min(80, q.Length)]; if (q.Length > 0) clean[key] = q;
            }
            else if (key == "low_stock")
            {
                if (!long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)) throw new ArgumentException("Low stock must be a whole number");
                if (n is < 0 or > 100000) throw new ArgumentException("Low stock must be between 0 and 100000"); clean[key] = (int)n;
            }
        }
        if (spec.NeedsMonth)
        {
            if (month is null || !Regex.IsMatch(month, @"^\d{4}-(0[1-9]|1[0-2])$")) throw new ArgumentException("Choose a month");
            return new(sellerId,null,null,null,month,clean);
        }
        DateTimeOffset? start = null, end = null;
        if (spec.DateLabel.Length > 0 && !(spec.DateOptional && from is null && to is null))
        {
            to ??= today ?? DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata")));
            from ??= to.Value.AddDays(-30);
            if (from > to) throw new ArgumentException("The start date is after the end date");
            if (to.Value.DayNumber - from.Value.DayNumber >= MaxRangeDays) throw new ArgumentException("Export at most 366 days at a time");
            start = new DateTimeOffset(from.Value.ToDateTime(TimeOnly.MinValue),TimeSpan.FromMinutes(330)).ToUniversalTime();
            end = new DateTimeOffset(to.Value.AddDays(1).ToDateTime(TimeOnly.MinValue),TimeSpan.FromMinutes(330)).ToUniversalTime();
        }
        return new(sellerId,start,end,string.IsNullOrEmpty(status) ? null : status,null,clean);
    }
    public static IReadOnlyList<int> PickColumns(Spec s, IReadOnlyList<string>? wanted, string format)
    {
        wanted = wanted is { Count: > 0 } ? wanted : format == "pdf" ? DefaultPdfColumns(s) : s.Headers;
        foreach (var column in wanted) if (!s.Headers.Contains(column)) throw new ArgumentException("Unknown column: " + column);
        var indexes = Enumerable.Range(0,s.Headers.Count).Where(i => wanted.Contains(s.Headers[i])).ToList();
        if (indexes.Count == 0) throw new ArgumentException("Choose at least one column");
        if (format == "pdf" && indexes.Count > ReportPdf.MaxColumns) throw new ArgumentException("A PDF fits at most 14 columns. Choose fewer, or download Excel for all of them.");
        return indexes;
    }
    private static DateTimeOffset Local(DateTimeOffset d) => d.ToOffset(TimeSpan.FromMinutes(330));
    public static string PeriodLabel(Context c, DateOnly? today = null) => c.Month ?? (c.Start is not null && c.End is not null
        ? Local(c.Start.Value).ToString("yyyy-MM-dd") + "-to-" + Local(c.End.Value).AddDays(-1).ToString("yyyy-MM-dd")
        : (today ?? DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow,TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata")))).ToString("yyyy-MM-dd"));
    public static string FileName(string brand, Spec spec, Context c, string format, DateOnly? today = null)
    {
        var slug = Regex.Replace(brand.ToLowerInvariant(),"[^a-z0-9]+","-").Trim('-');
        return (slug.Length > 0 ? slug : "export") + "-" + spec.Name + "-" + PeriodLabel(c,today) + "." + format;
    }
    public static IReadOnlyList<(string Key,string Value)> Summary(Spec spec, Context c, IReadOnlyDictionary<string,string>? names = null)
    {
        var result = new List<(string,string)>();
        if (c.Month is not null) result.Add(("Month",c.Month));
        else if (c.Start is not null && c.End is not null) result.Add(("Dates (" + spec.DateLabel + ")", Local(c.Start.Value).ToString("dd MMM yyyy",CultureInfo.InvariantCulture) + " to " + Local(c.End.Value).AddDays(-1).ToString("dd MMM yyyy",CultureInfo.InvariantCulture)));
        else if (spec.DateLabel.Length > 0) result.Add(("Dates","All"));
        if (c.Status is not null) result.Add(("Status",spec.Statuses.FirstOrDefault(s => s.Value == c.Status).Label ?? c.Status));
        foreach (var (k,v) in c.Extra)
        {
            var value = k == "payment_method" ? (string)v == "cod" ? "Cash on delivery" : "Paid online" : Convert.ToString(v,CultureInfo.InvariantCulture) ?? "";
            if (names?.TryGetValue(k,out var name) == true && name.Length > 0) value = name;
            result.Add((Label(k),value));
        }
        return result;
    }
}
