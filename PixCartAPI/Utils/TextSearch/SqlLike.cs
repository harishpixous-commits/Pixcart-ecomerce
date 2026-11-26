namespace Utils.TextSearch;

/// <summary>
/// SQL's case-insensitive <c>text ILIKE pattern</c>: both sides lower-cased, <c>%</c> matches any run of characters,
/// <c>_</c> exactly one, and a backslash makes the next character literal. A pattern that ends in a lone backslash
/// matches nothing.
/// </summary>
public static class SqlLike
{
    private enum Result { False, True, Abort }

    public static bool ILike(string text, string pattern) =>
        Match(TextTokenizer.CodePoints(text.ToLowerInvariant()), 0, TextTokenizer.CodePoints(pattern.ToLowerInvariant()), 0) == Result.True;

    /// <summary>The match over code points; Abort means that no later start position can match either.</summary>
    private static Result Match(int[] t, int ti, int[] p, int pi)
    {
        if (p.Length - pi == 1 && p[pi] == '%') return Result.True;
        while (ti < t.Length && pi < p.Length)
        {
            if (p[pi] == '\\')
            {
                pi++;
                if (pi >= p.Length) return Result.False; // a pattern must not end with the escape character
                if (p[pi] != t[ti]) return Result.False;
            }
            else if (p[pi] == '%')
            {
                pi++;
                while (pi < p.Length)
                {
                    if (p[pi] == '%') pi++;
                    else if (p[pi] == '_')
                    {
                        if (ti >= t.Length) return Result.Abort;
                        ti++;
                        pi++;
                    }
                    else break;
                }
                if (pi >= p.Length) return Result.True;
                int firstpat;
                if (p[pi] == '\\')
                {
                    if (p.Length - pi < 2) return Result.False;
                    firstpat = p[pi + 1];
                }
                else firstpat = p[pi];
                while (ti < t.Length)
                {
                    if (t[ti] == firstpat)
                    {
                        var matched = Match(t, ti, p, pi);
                        if (matched != Result.False) return matched;
                    }
                    ti++;
                }
                return Result.Abort;
            }
            else if (p[pi] == '_')
            {
                ti++;
                pi++;
                continue;
            }
            else if (p[pi] != t[ti]) return Result.False;
            ti++;
            pi++;
        }
        if (ti < t.Length) return Result.False;
        while (pi < p.Length && p[pi] == '%') pi++;
        return pi >= p.Length ? Result.True : Result.Abort;
    }
}
