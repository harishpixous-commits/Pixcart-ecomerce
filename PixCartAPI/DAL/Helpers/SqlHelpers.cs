namespace DAL.Helpers;

/// <summary>Small helpers for building safe SQL in the DAL. Values always go in parameters, never in the text.</summary>
public static class SqlHelpers
{
    /// <summary>Escapes % and _ for a LIKE search and wraps the text: "50%" → "%50\%%".</summary>
    public static string Contains(string text) => "%" + text.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    public static string StartsWith(string text) => text.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    /// <summary>"LIMIT @take OFFSET @skip" values for a page (1-based).</summary>
    public static (int Take, int Skip) Page(int page, int size, int maxSize = 200)
    {
        var s = Math.Clamp(size, 1, maxSize);
        return (s, (Math.Max(1, page) - 1) * s);
    }

    /// <summary>A WHERE clause from the parts that apply ("WHERE a AND b", or "" when none).</summary>
    public static string Where(IEnumerable<string> conditions)
    {
        var list = conditions.Where(c => !string.IsNullOrWhiteSpace(c)).ToList();
        return list.Count == 0 ? "" : "WHERE " + string.Join(" AND ", list);
    }

    /// <summary>Whitelists a sort column so user input never reaches the SQL text.</summary>
    public static string OrderBy(string? requested, IReadOnlyDictionary<string, string> allowed, string fallback) =>
        requested != null && allowed.TryGetValue(requested, out var sql) ? sql : fallback;
}
