using System.Text;

namespace Utils.TextSearch;

/// <summary>Weights of word positions, strongest last; the values are the two weight bits of a position.</summary>
public enum SearchWeight : byte { D = 0, C = 1, B = 2, A = 3 }

/// <summary>
/// A search vector: the distinct lower-cased words (lexemes) of a text in byte order, each with its word positions
/// (1..16383) and their weights. Each field is built with its weight, and fields are joined one after another (the
/// positions of a later field continue after the earlier ones). At most 256 positions are kept per lexeme, positions
/// are capped at 16383, and words of 2 KB or more are not indexed.
/// </summary>
public sealed class SearchVector
{
    /// <summary>Positions are below this.</summary>
    public const int MaxEntryPos = 1 << 14;

    /// <summary>Positions kept per lexeme.</summary>
    public const int MaxNumPos = 256;

    /// <summary>Words this long (in UTF-8 bytes) or longer are not indexed.</summary>
    public const int MaxStrLen = 1 << 11;

    public static readonly SearchVector Empty = new([], []);

    private readonly string[] lexemes;
    private readonly ushort[][] positions; // per lexeme: weight << 14 | position, ascending

    private SearchVector(string[] lexemes, ushort[][] positions)
    {
        this.lexemes = lexemes;
        this.positions = positions;
    }

    public int Count => lexemes.Length;

    public string LexemeAt(int index) => lexemes[index];

    /// <summary>The positions of a lexeme, each <c>weight &lt;&lt; 14 | position</c>.</summary>
    public ReadOnlySpan<ushort> PositionsAt(int index) => positions[index];

    internal ushort[] PositionArray(int index) => positions[index];

    public static int PositionOf(ushort entry) => entry & 0x3FFF;

    public static SearchWeight WeightOf(ushort entry) => (SearchWeight)(entry >> 14);

    /// <summary>The token types that are indexed: all but blanks, tags, entities and protocol heads.</summary>
    public static bool IsIndexed(TextTokenType type) =>
        type is not (TextTokenType.None or TextTokenType.Blank or TextTokenType.Tag or TextTokenType.Entity or TextTokenType.Protocol);

    /// <summary>The lexemes of a text in order: every indexed token in lower case.</summary>
    public static List<string> Lexemes(string text)
    {
        var outp = new List<string>();
        foreach (var (type, token) in TextTokenizer.Tokenize(text))
            if (IsIndexed(type) && Encoding.UTF8.GetByteCount(token) < MaxStrLen)
                outp.Add(token.ToLowerInvariant());
        return outp;
    }

    /// <summary>The vector of one text, every position with the given weight.</summary>
    public static SearchVector FromText(string text, SearchWeight weight = SearchWeight.D)
    {
        var words = Lexemes(text);
        if (words.Count == 0) return Empty;
        // sort by lexeme then position and merge the positions of each lexeme
        var order = new int[words.Count];
        for (var i = 0; i < order.Length; i++) order[i] = i;
        Array.Sort(order, (x, y) =>
        {
            var c = CompareLexemes(words[x], words[y]);
            return c != 0 ? c : x.CompareTo(y);
        });
        var lex = new List<string>();
        var pos = new List<ushort[]>();
        var cur = new List<int>();
        string? last = null;
        void Flush()
        {
            if (last is null) return;
            lex.Add(last);
            pos.Add(cur.Select(p => (ushort)((int)weight << 14 | p)).ToArray());
            cur.Clear();
        }
        foreach (var i in order)
        {
            var p = LimitPos(i + 1);
            if (last is null || !string.Equals(words[i], last, StringComparison.Ordinal))
            {
                Flush();
                last = words[i];
                cur.Add(p);
            }
            else if (cur.Count < MaxNumPos - 1 && cur[^1] != MaxEntryPos - 1 && cur[^1] != p)
                cur.Add(p);
        }
        Flush();
        return new SearchVector(lex.ToArray(), pos.ToArray());
    }

    /// <summary>Joins two vectors: the right one's positions move past the left one's last position.</summary>
    public static SearchVector Concat(SearchVector left, SearchVector right)
    {
        if (right.Count == 0) return left;
        var maxPos = 0;
        foreach (var list in left.positions)
            foreach (var e in list)
                maxPos = Math.Max(maxPos, PositionOf(e));
        var lex = new List<string>(left.Count + right.Count);
        var pos = new List<ushort[]>(left.Count + right.Count);
        int i = 0, j = 0;
        while (i < left.Count || j < right.Count)
        {
            var cmp = i == left.Count ? 1 : j == right.Count ? -1 : CompareLexemes(left.lexemes[i], right.lexemes[j]);
            if (cmp < 0)
            {
                lex.Add(left.lexemes[i]);
                pos.Add(left.positions[i]);
                i++;
            }
            else
            {
                var merged = cmp == 0 ? new List<ushort>(left.positions[i]) : new List<ushort>();
                // shifted positions, while fewer than MaxNumPos are kept and the last one is not the cap
                foreach (var e in right.positions[j])
                {
                    if (merged.Count >= MaxNumPos || merged.Count > 0 && PositionOf(merged[^1]) == MaxEntryPos - 1) break;
                    merged.Add((ushort)(e & 0xC000 | LimitPos(PositionOf(e) + maxPos)));
                }
                lex.Add(right.lexemes[j]);
                pos.Add(merged.ToArray());
                if (cmp == 0) i++;
                j++;
            }
        }
        return new SearchVector(lex.ToArray(), pos.ToArray());
    }

    private static int LimitPos(int p) => p >= MaxEntryPos ? MaxEntryPos - 1 : p;

    /// <summary>
    /// The first lexeme starting with <paramref name="prefix"/> and how many there are: lexemes are in byte order, so the
    /// lexemes with a prefix are consecutive and start with the prefix itself when it is a lexeme.
    /// </summary>
    public (int Start, int Count) FindPrefix(string prefix)
    {
        int lo = 0, hi = lexemes.Length;
        while (lo < hi)
        {
            var mid = lo + (hi - lo) / 2;
            var c = CompareLexemes(prefix, lexemes[mid]);
            if (c == 0)
            {
                hi = mid;
                break;
            }
            if (c > 0) lo = mid + 1;
            else hi = mid;
        }
        var start = hi;
        var n = 0;
        while (start + n < lexemes.Length && lexemes[start + n].StartsWith(prefix, StringComparison.Ordinal)) n++;
        return (start, n);
    }

    /// <summary>
    /// Byte order of the UTF-8 texts, a prefix before longer strings. Code-point order is UTF-8 byte order; UTF-16
    /// ordinal order differs only where surrogates (code points above U+FFFF) meet U+E000..U+FFFF, which this fixes up.
    /// </summary>
    public static int CompareLexemes(string a, string b)
    {
        var n = Math.Min(a.Length, b.Length);
        for (var i = 0; i < n; i++)
        {
            int x = a[i], y = b[i];
            if (x == y) continue;
            return Fix(x) - Fix(y);
        }
        return a.Length - b.Length;

        static int Fix(int c) => c >= 0xE000 ? c - 0x800 : c >= 0xD800 ? c + 0x2000 : c;
    }

    /// <summary>The text form, for example <c>'cotton':4A,11C 'men':1A</c> (positions with their weight letter; D is not written).</summary>
    public override string ToString()
    {
        var sb = new StringBuilder();
        for (var i = 0; i < lexemes.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append('\'');
            foreach (var ch in lexemes[i])
            {
                if (ch is '\'' or '\\') sb.Append(ch);
                sb.Append(ch);
            }
            sb.Append('\'');
            var list = positions[i];
            if (list.Length == 0) continue;
            sb.Append(':');
            for (var k = 0; k < list.Length; k++)
            {
                if (k > 0) sb.Append(',');
                sb.Append(PositionOf(list[k]));
                var w = WeightOf(list[k]);
                if (w != SearchWeight.D) sb.Append(w.ToString());
            }
        }
        return sb.ToString();
    }
}
