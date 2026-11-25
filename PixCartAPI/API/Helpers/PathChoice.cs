namespace API.Helpers;

/// <summary>Checks for path values the reference validates as a fixed list (FastAPI <c>Literal[...]</c>).</summary>
public static class PathChoice
{
    /// <summary>
    /// The reference checks sign-in before it validates the path, then answers 422 for a value outside the list.
    /// A route constraint would answer 404 before sign-in is checked, so the value is checked here instead.
    /// </summary>
    public static string Require(string value, string field, params string[] allowed)
    {
        if (Array.IndexOf(allowed, value) >= 0) return value;
        var expected = allowed.Length == 1
            ? $"'{allowed[0]}'"
            : string.Join(", ", allowed[..^1].Select(a => $"'{a}'")) + $" or '{allowed[^1]}'";
        var msg = $"must be one of: {expected}";
        var label = char.ToUpperInvariant(field[0]) + field[1..].Replace('_', ' ');
        throw new Utils.AppException($"{label}: {msg}", "validation_error", 422, new Dictionary<string, string> { [field] = msg });
    }
}
