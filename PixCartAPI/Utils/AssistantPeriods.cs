namespace Utils;

using System.Globalization;
using System.Text.Json.Nodes;
using Utils;

/// <summary>
/// Turns "today", "last month" or two dates into exact IST time ranges (reference: app/assistant/periods.py).
/// The server does the calendar arithmetic so the assistant never miscounts days; every answer echoes the
/// resolved range. Throws <see cref="AppException"/> with a message the model can relay (reference ValueError).
/// </summary>
public static class AssistantPeriods
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    public static readonly string[] Presets =
    [
        "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days",
        "last_90_days", "this_quarter", "this_year", "this_financial_year", "last_financial_year", "custom",
    ];

    private const int MaxDays = 731;

    public sealed record Period(DateTime Start, DateTime End, DateOnly FirstDay, DateOnly LastDay, string Label, string Preset)
    {
        public int Days => LastDay.DayNumber - FirstDay.DayNumber + 1;

        /// <summary>The same-length period just before this one (for "vs previous" comparisons).</summary>
        public Period Previous()
        {
            if (Preset is "this_month" or "last_month")
            {
                var last = FirstDay.AddDays(-1);
                var first = new DateOnly(last.Year, last.Month, 1);
                // Compare like with like: month-to-date against the same days of the previous month.
                if (Preset == "this_month")
                {
                    var sameDays = first.AddDays(Days - 1);
                    if (sameDays < last) last = sameDays;
                }
                return Make(first, last, "previous period", "custom");
            }
            var l = FirstDay.AddDays(-1);
            return Make(l.AddDays(-(Days - 1)), l, "previous period", "custom");
        }

        public JsonObject AsDict() => new()
        {
            ["label"] = Label, ["from"] = FirstDay.ToString("yyyy-MM-dd"), ["to"] = LastDay.ToString("yyyy-MM-dd"),
            ["days"] = Days, ["timezone"] = "IST (UTC+05:30)",
        };
    }

    private static DateOnly Today() => DateOnly.FromDateTime(DateTimeFunctions.UtcNow() + Ist);

    private static Period Make(DateOnly first, DateOnly last, string label, string preset) => new(
        first.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc) - Ist,
        last.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc) - Ist,
        first, last, label, preset);

    private static string Fmt(DateOnly d) => d.ToString("d MMM yyyy", CultureInfo.InvariantCulture);

    public static Period Resolve(string? preset = null, string? dateFrom = null, string? dateTo = null)
    {
        var t = Today();
        var p = (preset ?? (dateFrom is not null || dateTo is not null ? "custom" : "last_30_days")).Trim().ToLowerInvariant();
        if (!Presets.Contains(p))
            throw new AppException($"Unknown period '{preset}'. Use one of: {string.Join(", ", Presets)}", "bad_period");
        if (p == "custom")
        {
            DateOnly? first = null, last = null;
            try
            {
                first = dateFrom is not null ? DateOnly.ParseExact(dateFrom, "yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
                last = dateTo is not null ? DateOnly.ParseExact(dateTo, "yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
            }
            catch (FormatException)
            {
                throw new AppException("Dates must look like 2026-11-17", "bad_period");
            }
            if (first is null && last is null)
                throw new AppException("Give date_from and/or date_to for a custom period", "bad_period");
            first ??= last;
            last ??= t;
            if (first > last) (first, last) = (last, first);
            if (last > t) last = t;
            if (last.Value.DayNumber - first.Value.DayNumber >= MaxDays)
                throw new AppException($"Ask for at most {MaxDays} days at a time", "bad_period");
            var label = first == last ? Fmt(first.Value) : $"{Fmt(first.Value)} to {Fmt(last.Value)}";
            return Make(first.Value, last.Value, label, p);
        }
        if (p == "today") return Make(t, t, $"Today, {Fmt(t)}", p);
        if (p == "yesterday")
        {
            var y = t.AddDays(-1);
            return Make(y, y, $"Yesterday, {Fmt(y)}", p);
        }
        if (p == "this_week")
        {
            // Python weekday(): Monday=0; .NET DayOfWeek: Sunday=0.
            var first = t.AddDays(-(((int)t.DayOfWeek + 6) % 7));
            return Make(first, t, $"This week ({Fmt(first)} to {Fmt(t)})", p);
        }
        if (p == "last_week")
        {
            var last = t.AddDays(-(((int)t.DayOfWeek + 6) % 7) - 1);
            var first = last.AddDays(-6);
            return Make(first, last, $"Last week ({Fmt(first)} to {Fmt(last)})", p);
        }
        if (p == "this_month")
        {
            var first = new DateOnly(t.Year, t.Month, 1);
            return Make(first, t, $"{t.ToString("MMMM yyyy", CultureInfo.InvariantCulture)} so far", p);
        }
        if (p == "last_month")
        {
            var last = new DateOnly(t.Year, t.Month, 1).AddDays(-1);
            return Make(new DateOnly(last.Year, last.Month, 1), last, last.ToString("MMMM yyyy", CultureInfo.InvariantCulture), p);
        }
        if (p.StartsWith("last_") && p.EndsWith("_days"))
        {
            var n = int.Parse(p.Split('_')[1], CultureInfo.InvariantCulture);
            var first = t.AddDays(-(n - 1));
            return Make(first, t, $"Last {n} days ({Fmt(first)} to {Fmt(t)})", p);
        }
        if (p == "this_quarter")
        {
            var qMonth = 3 * ((t.Month - 1) / 3) + 1;
            var first = new DateOnly(t.Year, qMonth, 1);
            return Make(first, t, $"This quarter ({Fmt(first)} to {Fmt(t)})", p);
        }
        if (p == "this_year")
        {
            var first = new DateOnly(t.Year, 1, 1);
            return Make(first, t, $"{t.Year} so far", p);
        }
        var fyStartYear = t.Month >= 4 ? t.Year : t.Year - 1;
        if (p == "this_financial_year")
        {
            var first = new DateOnly(fyStartYear, 4, 1);
            return Make(first, t, $"FY {fyStartYear}-{(fyStartYear + 1) % 100:D2} so far", p);
        }
        return Make(new DateOnly(fyStartYear - 1, 4, 1), new DateOnly(fyStartYear, 3, 31), $"FY {fyStartYear - 1}-{fyStartYear % 100:D2}", p);
    }
}
