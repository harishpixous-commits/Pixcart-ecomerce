using System.Text.Json.Nodes;

namespace Utils;

/// <summary>A category's size guide: lines of cells split by "|", the first line is the header.</summary>
public static class SizeGuide
{
    public const int MaxRows = 30, MaxCols = 8, MaxCell = 30;

    private static List<string[]> Parse(string? text)
    {
        var grid = new List<string[]>();
        foreach (var line in (text ?? "").Split('\n'))
        {
            var cells = line.Split('|').Select(c => string.Join(' ', c.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))).Select(c => c.Length > MaxCell ? c[..MaxCell] : c).ToArray();
            if (cells.Any(c => c.Length > 0)) grid.Add(cells);
        }
        return grid;
    }

    /// <summary>The stored text: tidy lines. Throws AppException for a table that cannot be shown.</summary>
    public static string Clean(string? text)
    {
        var grid = Parse(text);
        if (grid.Count == 0) return "";
        if (grid.Count < 2) throw new AppException("A size guide needs a header line and at least one size line", "invalid_size_guide", fields: new Dictionary<string, string> { { "size_guide", "Invalid" } });
        if (grid.Count > MaxRows) throw new AppException($"A size guide has at most {MaxRows} lines", "invalid_size_guide", fields: new Dictionary<string, string> { { "size_guide", "Invalid" } });
        if (grid.Any(r => r.Length > MaxCols)) throw new AppException($"A size guide has at most {MaxCols} columns", "invalid_size_guide", fields: new Dictionary<string, string> { { "size_guide", "Invalid" } });
        if (grid.Select(r => r.Length).Distinct().Count() != 1) throw new AppException("Every line of the size guide needs the same number of columns", "invalid_size_guide", fields: new Dictionary<string, string> { { "size_guide", "Invalid" } });
        return string.Join('\n', grid.Select(r => string.Join(" | ", r)));
    }

    /// <summary>The table for the product page, or null when there is no guide.</summary>
    public static JsonArray? Rows(string? text)
    {
        var grid = Parse(text);
        if (grid.Count < 2) return null;
        return new JsonArray(grid.Select(r => (JsonNode)new JsonArray(r.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray())).ToArray());
    }
}
