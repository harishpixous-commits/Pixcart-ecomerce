namespace Utils.TextSearch;

/// <summary>
/// A search query of prefix terms: every term must match (or, for <see cref="Any"/>, one is enough). Each word goes
/// through the tokenizer: one lexeme makes a prefix term, several (a word the tokenizer splits, such as "a_b") make a
/// phrase of prefix terms at consecutive positions, and a word without a lexeme is dropped.
/// <see cref="Matches"/> tells whether a vector matches; <see cref="Rank"/> is the relevance: for every-term queries a
/// proximity rank (pairs of terms close together count most), otherwise a frequency rank, with the weights D 0.1,
/// C 0.2, B 0.4 and A 1.0. The arithmetic is single precision, rounded at each step, so ranks are reproducible to the
/// last bit.
/// </summary>
public sealed class SearchQuery
{
    private static readonly float[] Weights = [0.1f, 0.2f, 0.4f, 1.0f];

    private readonly string[][] terms;
    private readonly string[] operands; // every lexeme, in byte order, without duplicates

    private SearchQuery(string[][] terms, bool any)
    {
        this.terms = terms;
        Any = any;
        var all = terms.SelectMany(t => t).Distinct(StringComparer.Ordinal).ToArray();
        Array.Sort(all, SearchVector.CompareLexemes);
        operands = all;
    }

    /// <summary>The terms; a term with more than one lexeme is a phrase.</summary>
    public IReadOnlyList<IReadOnlyList<string>> Terms => terms;

    /// <summary>OR instead of AND.</summary>
    public bool Any { get; }

    /// <summary>A query without lexemes: matches nothing and ranks 0.</summary>
    public bool IsEmpty => terms.Length == 0;

    /// <summary>The query of prefix terms for words made of word characters only (all of them, or any when <paramref name="any"/>).</summary>
    public static SearchQuery Prefix(IEnumerable<string> words, bool any = false) =>
        new(words.Select(SearchVector.Lexemes).Where(l => l.Count > 0).Select(l => l.ToArray()).ToArray(), any);

    /// <summary>The query as text, for example <c>'cotton':* &amp; 'usb':* &lt;-&gt; 'c':*</c> (&lt;-&gt; joins a phrase).</summary>
    public override string ToString() =>
        string.Join(Any ? " | " : " & ", terms.Select(t => string.Join(" <-> ", t.Select(l => $"'{l.Replace("'", "''")}':*"))));

    // ------------------------------------------------------------------------------------------------- matching

    /// <summary>Whether the vector matches the query.</summary>
    public bool Matches(SearchVector vector)
    {
        if (terms.Length == 0) return false;
        foreach (var term in terms)
        {
            var hit = TermMatches(vector, term);
            if (Any && hit) return true;
            if (!Any && !hit) return false;
        }
        return !Any;
    }

    private static bool TermMatches(SearchVector vector, string[] term)
    {
        if (term.Length == 1) return vector.FindPrefix(term[0]).Count > 0;
        // a phrase: some position p with the first lexeme at p, the second at p + 1, ...
        var sets = new HashSet<int>[term.Length];
        for (var i = 0; i < term.Length; i++)
        {
            sets[i] = Positions(vector, term[i]);
            if (sets[i].Count == 0) return false;
        }
        foreach (var p in sets[0])
        {
            var ok = true;
            for (var i = 1; i < term.Length && ok; i++) ok = sets[i].Contains(p + i);
            if (ok) return true;
        }
        return false;
    }

    private static HashSet<int> Positions(SearchVector vector, string prefix)
    {
        var (start, n) = vector.FindPrefix(prefix);
        var outp = new HashSet<int>();
        for (var e = start; e < start + n; e++)
            foreach (var w in vector.PositionsAt(e))
                outp.Add(SearchVector.PositionOf(w));
        return outp;
    }

    // ------------------------------------------------------------------------------------------------- relevance

    /// <summary>The relevance: the proximity rank for an every-term (or phrase) query, the frequency rank otherwise.</summary>
    public float Rank(SearchVector vector)
    {
        if (vector.Count == 0 || terms.Length == 0) return 0f;
        var andRoot = terms.Length > 1 ? !Any : terms[0].Length > 1;
        var res = andRoot ? RankAnd(vector) : RankOr(vector);
        return res < 0 ? 1e-20f : res;
    }

    /// <summary>Frequency rank: per matching lexeme, its weights summed over 1/i² around the strongest; averaged per term.</summary>
    private float RankOr(SearchVector vector)
    {
        var res = 0f;
        foreach (var item in operands)
        {
            var (start, n) = vector.FindPrefix(item);
            for (var e = start; e < start + n; e++)
            {
                var post = vector.PositionsAt(e);
                var resj = 0f;
                var wjm = -1f;
                var jm = 0;
                for (var j = 0; j < post.Length; j++)
                {
                    var w = Weights[post[j] >> 14];
                    resj = (float)(resj + (float)(w / (float)((j + 1) * (j + 1))));
                    if (w > wjm)
                    {
                        wjm = w;
                        jm = j;
                    }
                }
                var inner = (float)((float)(wjm + resj) - (float)(wjm / (float)((jm + 1) * (jm + 1))));
                res = (float)(res + inner / 1.64493406685);
            }
        }
        return operands.Length > 0 ? (float)(res / (float)operands.Length) : res;
    }

    /// <summary>
    /// Proximity rank: every pair of positions of different terms adds sqrt(w1 · w2 · closeness(distance)), combined as
    /// 1 − Π(1 − x). A term that matches several lexemes is compared with the later terms through its last lexeme only.
    /// </summary>
    private float RankAnd(SearchVector vector)
    {
        if (operands.Length < 2) return RankOr(vector);
        var pos = new ushort[]?[operands.Length];
        var res = -1f;
        for (var i = 0; i < operands.Length; i++)
        {
            var (start, n) = vector.FindPrefix(operands[i]);
            for (var e = start; e < start + n; e++)
            {
                var post = pos[i] = vector.PositionArray(e);
                for (var k = 0; k < i; k++)
                {
                    var ct = pos[k];
                    if (ct is null) continue;
                    foreach (var a in post)
                        foreach (var b in ct)
                        {
                            var dist = Math.Abs(SearchVector.PositionOf(a) - SearchVector.PositionOf(b));
                            if (dist == 0) continue;
                            var product = (float)((float)(Weights[a >> 14] * Weights[b >> 14]) * WordDistance(dist));
                            var curw = (float)Math.Sqrt(product);
                            res = res < 0 ? curw : (float)(1.0 - (1.0 - res) * (1.0 - curw));
                        }
                }
            }
        }
        return res;
    }

    private static float WordDistance(int w) =>
        w > 100 ? 1e-30f : (float)(1.0 / (1.005 + 0.05 * Math.Exp((float)w / 1.5 - 2)));
}
