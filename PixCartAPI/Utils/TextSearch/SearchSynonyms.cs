using System.Text.RegularExpressions;

namespace Utils.TextSearch;

/// <summary>Search synonyms the admin sets ("tee = t-shirt = tshirt; sneakers = shoes"). Single words only.</summary>
public static class SearchSynonyms
{
    public const int MaxVariants = 6;

    public static List<List<string>> Parse(string? text)
    {
        var groups = new List<List<string>>();
        foreach (var part in (text ?? "").Replace("\n", ";").Split(';'))
        {
            var words = new List<string>();
            foreach (var raw in part.Split('='))
            {
                var w = string.Join(" ", Regex.Split(raw.ToLowerInvariant(), @"[^\w-]+").Where(x => x.Length > 0));
                if (w.Length > 0 && !w.Contains(' ') && !words.Contains(w)) words.Add(w);
            }
            if (words.Count > 1) groups.Add(words);
        }
        return groups;
    }

    public static string Normalize(string text)
    {
        var parts = (text ?? "").Replace("\n", ";").Split(';').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        foreach (var p in parts)
            if (Parse(p).Count == 0) throw new ArgumentException($"search_synonyms: \"{(p.Length > 40 ? p[..40] : p)}\" needs two or more single words joined with =");
        return string.Join("; ", parts);
    }

    /// <summary>The query itself first, then the query with one word swapped for each synonym (at most MaxVariants).</summary>
    public static List<string> Variants(string query, List<List<string>> groups)
    {
        var outp = new List<string> { query };
        if (groups.Count == 0) return outp;
        var tokens = Regex.Split(query.Trim(), @"\s+").Where(t => t.Length > 0).ToList();
        for (var i = 0; i < tokens.Count; i++)
        {
            var low = tokens[i].ToLowerInvariant();
            foreach (var g in groups.Where(g => g.Contains(low)))
                foreach (var alt in g)
                {
                    if (alt != low)
                    {
                        var v = string.Join(" ", tokens.Take(i).Append(alt).Concat(tokens.Skip(i + 1)));
                        if (!outp.Contains(v)) outp.Add(v);
                    }
                    if (outp.Count >= MaxVariants) return outp;
                }
        }
        return outp;
    }
}
