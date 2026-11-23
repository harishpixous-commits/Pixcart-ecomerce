namespace Utils;

/// <summary>Calendar days in India: "today", week starts and date ranges for reports.</summary>
public static class DateFunctions
{
    public static DateOnly TodayIst() => DateOnly.FromDateTime(DateTimeFunctions.ToIst(DateTime.UtcNow));

    /// <summary>The UTC moment an Indian calendar day starts.</summary>
    public static DateTime StartOfIstDayUtc(DateOnly day) => DateTimeFunctions.IstToUtc(day.ToDateTime(TimeOnly.MinValue));

    /// <summary>Monday of the week (IST) the day falls in.</summary>
    public static DateOnly WeekStart(DateOnly day) => day.AddDays(-(((int)day.DayOfWeek + 6) % 7));

    public static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd");
}
