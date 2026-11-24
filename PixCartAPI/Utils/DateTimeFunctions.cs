namespace Utils;

/// <summary>Times are stored in UTC; India (IST, UTC+05:30) is used for business days, reports and cut-offs.</summary>
public static class DateTimeFunctions
{
    public static readonly TimeZoneInfo Ist = FindIst();

    private static TimeZoneInfo FindIst()
    {
        foreach (var id in new[] { "Asia/Kolkata", "India Standard Time" })
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById(id); } catch (TimeZoneNotFoundException) { }
        }
        return TimeZoneInfo.CreateCustomTimeZone("IST", TimeSpan.FromMinutes(330), "India Standard Time", "IST");
    }

    /// <summary>Now, in UTC (what the database stores), to the microsecond like the reference version.</summary>
    public static DateTime UtcNow() => new(DateTime.UtcNow.Ticks / 10 * 10, DateTimeKind.Utc);

    public static DateTime ToIst(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Ist);

    public static DateTime IstToUtc(DateTime ist) => TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(ist, DateTimeKind.Unspecified), Ist);

    /// <summary>
    /// ISO 8601 with offset exactly like the reference API (Python isoformat): "2026-11-23T10:15:00.123456+00:00", and
    /// without the fraction when it is zero ("2026-11-23T10:15:00+00:00").
    /// </summary>
    public static string Iso(DateTime utc)
    {
        var t = DateTime.SpecifyKind(utc, DateTimeKind.Utc);
        return t.Ticks % TimeSpan.TicksPerSecond / 10 == 0
            ? t.ToString("yyyy-MM-dd'T'HH:mm:ss'+00:00'")
            : t.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'+00:00'");
    }

    public static string? Iso(DateTime? utc) => utc.HasValue ? Iso(utc.Value) : null;
}
