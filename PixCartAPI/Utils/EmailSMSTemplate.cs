using System.Text.RegularExpressions;

namespace Utils;

/// <summary>Fills {{name}} placeholders in notification templates (Admin → Notifications). Unknown names stay empty.</summary>
public static partial class EmailSMSTemplate
{
    [GeneratedRegex(@"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")]
    private static partial Regex Placeholder();

    public static string Render(string text, IReadOnlyDictionary<string, string> variables) =>
        Placeholder().Replace(text ?? "", m => variables.TryGetValue(m.Groups[1].Value, out var v) ? v : "");
}
