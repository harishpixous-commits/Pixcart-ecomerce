namespace Utils.TextSearch;

/// <summary>
/// The trigrams of a text in order: every word (a run of letters and digits, lower-cased) is padded as "  word "
/// and cut into three-character pieces ("  w", " wo", "wor", "ord", "rd "). Duplicates are kept, because
/// word_similarity looks for the best continuous stretch of the second text. Distinct trigrams get small numbers so a
/// comparison works on arrays.
/// </summary>
public sealed class TrigramSequence
{
    public static readonly TrigramSequence Empty = new([], []);

    /// <summary>The distinct trigrams.</summary>
    public string[] Distinct { get; }

    /// <summary>The trigrams in text order, as indexes into <see cref="Distinct"/>.</summary>
    public int[] Order { get; }

    private TrigramSequence(string[] distinct, int[] order)
    {
        Distinct = distinct;
        Order = order;
    }

    public static TrigramSequence Of(string text)
    {
        var cps = TextTokenizer.CodePoints(text);
        var ids = new Dictionary<string, int>(StringComparer.Ordinal);
        var order = new List<int>();
        var i = 0;
        while (i < cps.Length)
        {
            if (!TextTokenizer.IsAlnum(cps[i]))
            {
                i++;
                continue;
            }
            var start = i;
            while (i < cps.Length && TextTokenizer.IsAlnum(cps[i])) i++;
            var word = TextTokenizer.FromCodePoints(cps, start, i - start).ToLowerInvariant();
            var padded = TextTokenizer.CodePoints("  " + word + " ");
            for (var k = 0; k + 3 <= padded.Length; k++)
            {
                var trigram = TextTokenizer.FromCodePoints(padded, k, 3);
                if (!ids.TryGetValue(trigram, out var id)) ids[trigram] = id = ids.Count;
                order.Add(id);
            }
        }
        var distinct = new string[ids.Count];
        foreach (var (t, id) in ids) distinct[id] = t;
        return new TrigramSequence(distinct, order.ToArray());
    }
}

/// <summary>
/// The search text side of the trigram word similarity: its distinct trigrams. The similarity to a title is the best
/// |shared| / |union| between these and any continuous stretch of the title's trigrams, found with a left-to-right scan
/// that also tries moving the start of the stretch up. It is computed in single precision, so values (and the order
/// of search results) are reproducible to the last bit.
/// </summary>
public sealed class TrigramQuery
{
    private readonly HashSet<string> trigrams;

    public TrigramQuery(string text)
    {
        trigrams = new HashSet<string>(TrigramSequence.Of(text).Distinct, StringComparer.Ordinal);
    }

    public int Count => trigrams.Count;

    /// <summary>The word similarity of this text to <paramref name="b"/>.</summary>
    public float WordSimilarity(string b) => WordSimilarity(TrigramSequence.Of(b));

    /// <summary>The word similarity of this text to a text given by its trigram sequence.</summary>
    public float WordSimilarity(TrigramSequence b)
    {
        var order = b.Order;
        if (trigrams.Count == 0 || order.Length == 0) return 0f;
        var found = new bool[b.Distinct.Length];
        var any = false;
        for (var j = 0; j < found.Length; j++) any |= found[j] = trigrams.Contains(b.Distinct[j]);
        return any ? Iterate(order, found, trigrams.Count) : 0f;
    }

    /// <summary>Whether the word similarity reaches the threshold (compared in double precision).</summary>
    public bool IsSimilar(TrigramSequence b, double threshold) => WordSimilarity(b) >= threshold;

    /// <summary>The scan for the best stretch.</summary>
    private static float Iterate(int[] trg2indexes, bool[] found, int ulen1)
    {
        var lastpos = new int[found.Length];
        Array.Fill(lastpos, -1);
        int ulen2 = 0, count = 0, upper, lower = -1;
        var smlrMax = 0f;
        for (var i = 0; i < trg2indexes.Length; i++)
        {
            var trgindex = trg2indexes[i];
            if (lower >= 0 || found[trgindex])
            {
                if (lastpos[trgindex] < 0)
                {
                    ulen2++;
                    if (found[trgindex]) count++;
                }
                lastpos[trgindex] = i;
            }
            if (!found[trgindex]) continue;

            upper = i;
            if (lower == -1)
            {
                lower = i;
                ulen2 = 1;
            }
            var smlrCur = Similarity(count, ulen1, ulen2);
            // also try to move the lower bound up for a better similarity
            int tmpCount = count, tmpUlen2 = ulen2, prevLower = lower;
            for (var tmpLower = lower; tmpLower <= upper; tmpLower++)
            {
                var smlrTmp = Similarity(tmpCount, ulen1, tmpUlen2);
                if (smlrTmp > smlrCur)
                {
                    smlrCur = smlrTmp;
                    ulen2 = tmpUlen2;
                    lower = tmpLower;
                    count = tmpCount;
                }
                var tmpTrgindex = trg2indexes[tmpLower];
                if (lastpos[tmpTrgindex] == tmpLower)
                {
                    tmpUlen2--;
                    if (found[tmpTrgindex]) tmpCount--;
                }
            }
            smlrMax = smlrMax > smlrCur ? smlrMax : smlrCur;
            for (var tmpLower = prevLower; tmpLower < lower; tmpLower++)
            {
                var tmpTrgindex = trg2indexes[tmpLower];
                if (lastpos[tmpTrgindex] == tmpLower) lastpos[tmpTrgindex] = -1;
            }
        }
        return smlrMax;
    }

    /// <summary>shared / (|text| + |stretch| − shared), in single precision.</summary>
    private static float Similarity(int count, int len1, int len2) => (float)count / (float)(len1 + len2 - count);
}
