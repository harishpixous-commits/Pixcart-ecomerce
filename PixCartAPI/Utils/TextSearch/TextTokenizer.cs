using System.Globalization;
using System.Text;

namespace Utils.TextSearch;

/// <summary>The kinds of token the search tokenizer recognises.</summary>
public enum TextTokenType
{
    None = 0,
    AsciiWord = 1,
    Word = 2,
    NumWord = 3,
    Email = 4,
    Url = 5,
    Host = 6,
    SciFloat = 7,
    Version = 8,
    HWordNumPart = 9,
    HWordPart = 10,
    HWordAsciiPart = 11,
    Blank = 12,
    Tag = 13,
    Protocol = 14,
    NumHWord = 15,
    AsciiHWord = 16,
    HWord = 17,
    UrlPath = 18,
    File = 19,
    Float = 20,
    Int = 21,
    UInt = 22,
    Entity = 23,
}

/// <summary>
/// The search tokenizer: a table-driven state machine that splits text into words, numbers, hyphenated words and their
/// parts, hosts, e-mail addresses, URLs, file paths, versions, markup tags and entities. Each state lists
/// (character class, action, next state) rules tried in order. PUSH saves the position so that a longer reading that
/// fails can POP back and try the next rule: that is how "22.5W" becomes the number "22.5" and the word "w", and how
/// "usb-c" yields the hyphenated word and then its parts.
/// It works on Unicode code points: letters of every script are letters, only 0-9 are digits, and combining marks
/// continue a word.
/// </summary>
public sealed class TextTokenizer
{
    private enum Cls : byte { Any, Eof, EqC, Asclet, Alpha, Digit, Alnum, NotAlnum, Space, XDigit, Special, Ignore, StopHost, Host, UrlChar, UrlPath }

    [Flags]
    private enum Act : byte { Next = 0, Bingo = 1, Pop = 2, Push = 4, Rerun = 8, Clear = 16, Merge = 32, ClrAll = 64 }

    private enum Sp : byte { None, Tags, VerVersion, Hyphen, FUrl }

    private enum St : byte
    {
        Base, InNumWord, InAsciiWord, InWord, InUnsignedInt, InSignedIntFirst, InSignedInt, InSpace, InUDecimalFirst,
        InUDecimal, InDecimalFirst, InDecimal, InVerVersion, InSVerVersion, InVersionFirst, InVersion, InMantissaFirst,
        InMantissaSign, InMantissa, InXMLEntityFirst, InXMLEntity, InXMLEntityNumFirst, InXMLEntityNum,
        InXMLEntityHexNumFirst, InXMLEntityHexNum, InXMLEntityEnd, InTagFirst, InXMLBegin, InTagCloseFirst, InTagName,
        InTagBeginEnd, InTag, InTagEscapeK, InTagEscapeKK, InTagBackSleshed, InTagEnd, InCommentFirst, InCommentLast,
        InComment, InCloseCommentFirst, InCloseCommentLast, InCommentEnd, InHostFirstDomain, InHostDomainSecond,
        InHostDomain, InPortFirst, InPort, InHostFirstAN, InHost, InEmail, InFileFirst, InFileTwiddle, InPathFirst,
        InPathFirstFirst, InPathSecond, InFile, InFileNext, InURLPathFirst, InURLPathStart, InURLPath, InFURL,
        InProtocolFirst, InProtocolSecond, InProtocolEnd, InHyphenAsciiWordFirst, InHyphenAsciiWord, InHyphenWordFirst,
        InHyphenWord, InHyphenNumWordFirst, InHyphenNumWord, InHyphenDigitLookahead, InParseHyphen,
        InParseHyphenHyphen, InHyphenWordPart, InHyphenAsciiWordPart, InHyphenNumWordPart, InHyphenUnsignedInt,
        Null,
    }

    private readonly record struct Rule(Cls Cls, int C, Act Act, St To, TextTokenType Type, Sp Special);

    private sealed class Frame
    {
        public St State;
        public int Pos;          // index of the character under examination
        public int CharLen;      // 1, or 0 at the end of the text
        public int TokenLen;     // characters taken into the current token
        public int PushedAt = -1; // the rule that pushed from this frame; a POP resumes with the rule after it
        public Frame? Prev;

        public Frame() { }

        public Frame(Frame from)
        {
            State = from.State;
            Pos = from.Pos;
            CharLen = from.CharLen;
            TokenLen = from.TokenLen;
            Prev = from;
        }
    }

    private readonly int[] text;
    private readonly int end;
    private Frame state;
    private bool ignore;     // inside <script> or <style>
    private bool wantHost;   // a nested reading that must stop at the end of a host name
    private int tokenStart;
    private int tokenLength;
    private TextTokenType type;

    private TextTokenizer(int[] text, int start, int end)
    {
        this.text = text;
        this.end = end;
        state = new Frame { State = St.Base, Pos = start };
    }

    /// <summary>Every token of the text in order, blanks included.</summary>
    public static List<(TextTokenType Type, string Text)> Tokenize(string text)
    {
        var cps = CodePoints(text);
        var tokenizer = new TextTokenizer(cps, 0, cps.Length);
        var outp = new List<(TextTokenType, string)>();
        while (tokenizer.Next())
            outp.Add((tokenizer.type, FromCodePoints(cps, tokenizer.tokenStart, tokenizer.tokenLength)));
        return outp;
    }

    internal static int[] CodePoints(string s)
    {
        var outp = new int[s.Length];
        var n = 0;
        foreach (var r in s.EnumerateRunes()) outp[n++] = r.Value;
        return n == outp.Length ? outp : outp[..n];
    }

    internal static string FromCodePoints(int[] cps, int start, int length)
    {
        var sb = new StringBuilder(length);
        for (var i = start; i < start + length; i++) sb.Append(new Rune(cps[i]).ToString());
        return sb.ToString();
    }

    // ------------------------------------------------------------------------------------------------- the machine

    /// <summary>Reads the next token; false at the end of the text.</summary>
    private bool Next()
    {
        if (state.Pos >= end) return false;
        tokenStart = state.Pos;
        state.PushedAt = -1;
        Rule rule = default;
        var have = false;
        while (state.Pos <= end)
        {
            state.CharLen = state.Pos == end ? 0 : 1;
            var rules = Rules[(int)state.State];
            int at;
            if (state.PushedAt >= 0)
            {
                at = state.PushedAt + 1;  // after a POP, pick up at the next rule
                state.PushedAt = -1;
            }
            else at = 0;
            while (rules[at].Cls != Cls.Any && !Test(rules[at])) at++;
            rule = rules[at];
            have = true;

            switch (rule.Special)
            {
                case Sp.Tags: SpecialTags(); break;
                case Sp.FUrl:
                    // a URL token is followed by its host and its path as tokens of their own
                    wantHost = true;
                    state.Pos -= state.TokenLen;
                    break;
                case Sp.Hyphen:
                    // a hyphenated word is followed by its parts
                    state.Pos -= state.TokenLen;
                    break;
                case Sp.VerVersion:
                    state.Pos -= state.TokenLen;
                    state.TokenLen = 0;
                    break;
            }

            if ((rule.Act & Act.Bingo) != 0)
            {
                tokenLength = state.TokenLen;
                state.TokenLen = 0;
                type = rule.Type;
            }

            if ((rule.Act & Act.Pop) != 0) state = state.Prev!;
            else if ((rule.Act & Act.Push) != 0)
            {
                state.PushedAt = at;
                state = new Frame(state);
            }
            else if ((rule.Act & Act.Clear) != 0) state.Prev = state.Prev!.Prev;
            else if ((rule.Act & Act.ClrAll) != 0) state.Prev = null;
            else if ((rule.Act & Act.Merge) != 0)
            {
                var top = state;
                state = state.Prev!;
                state.Pos = top.Pos;
                state.CharLen = top.CharLen;
                state.TokenLen = top.TokenLen;
            }

            if (rule.To != St.Null) state.State = rule.To;
            if ((rule.Act & Act.Bingo) != 0 || (state.Pos >= end && (rule.Act & Act.Rerun) == 0)) break;
            if ((rule.Act & (Act.Rerun | Act.Pop)) != 0) continue;
            if (state.CharLen != 0)
            {
                state.Pos++;
                state.TokenLen++;
            }
        }
        return have && (rule.Act & Act.Bingo) != 0;
    }

    private int Current => state.Pos < end ? text[state.Pos] : 0;

    private bool Test(Rule rule) => rule.Cls switch
    {
        Cls.Eof => state.Pos == end || state.CharLen == 0,
        Cls.EqC => state.CharLen == 1 && Current == rule.C,
        Cls.Asclet => Current < 0x80 && IsAsciiLetter(Current),
        Cls.Alpha => IsAlpha(Current),
        Cls.Digit => IsDigit(Current),
        Cls.Alnum => IsAlnum(Current),
        Cls.NotAlnum => !IsAlnum(Current),
        Cls.Space => IsSpace(Current),
        Cls.XDigit => IsHexDigit(Current),
        Cls.Special => IsSpecial(Current),
        Cls.Ignore => ignore,
        Cls.StopHost => StopHost(),
        Cls.Host => Nested(wanthost: true, St.Null, TextTokenType.Host),
        Cls.UrlChar => state.CharLen == 1 && IsUrlChar(Current),
        Cls.UrlPath => Nested(wanthost: false, St.InURLPathFirst, TextTokenType.UrlPath),
        _ => false,
    };

    private bool StopHost()
    {
        if (!wantHost) return false;
        wantHost = false;
        return true;
    }

    /// <summary>Reads a fresh token from here and takes it in when it is a host (or a URL path).</summary>
    private bool Nested(bool wanthost, St start, TextTokenType want)
    {
        var sub = new TextTokenizer(text, state.Pos, end) { wantHost = wanthost };
        if (start != St.Null) sub.state = new Frame(sub.state) { State = start };
        if (!sub.Next() || sub.type != want) return false;
        state.Pos += sub.tokenLength;
        state.TokenLen += sub.tokenLength;
        state.CharLen = sub.state.CharLen;
        return true;
    }

    /// <summary>Inside &lt;script&gt; and &lt;style&gt; everything up to the closing tag is skipped.</summary>
    private void SpecialTags()
    {
        bool Is(string tag)
        {
            if (state.TokenLen != tag.Length) return false;
            for (var i = 0; i < tag.Length; i++)
            {
                var c = text[tokenStart + i];
                if ((IsAsciiLetter(c) ? c | 0x20 : c) != tag[i]) return false;
            }
            return true;
        }
        if (Is("</script") || Is("</style")) ignore = false;
        else if (Is("<script") || Is("<style")) ignore = true;
    }

    // ------------------------------------------------------------------------------------------------- character classes

    private static bool IsAsciiLetter(int c) => (uint)((c | 0x20) - 'a') <= 'z' - 'a';

    /// <summary>A letter: ASCII letters, letters of every script, and other scripts' digits.</summary>
    internal static bool IsAlpha(int c)
    {
        if (c < 0x80) return IsAsciiLetter(c);
        if (!Rune.IsValid(c)) return false;
        var cat = Rune.GetUnicodeCategory(new Rune(c));
        return cat is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter or UnicodeCategory.DecimalDigitNumber;
    }

    internal static bool IsDigit(int c) => (uint)(c - '0') <= 9;

    internal static bool IsAlnum(int c) => IsAlpha(c) || IsDigit(c);

    private static bool IsHexDigit(int c) => IsDigit(c) || (uint)((c | 0x20) - 'a') <= 'f' - 'a';

    /// <summary>White space: ASCII white space and the Unicode spaces other than the no-break ones.</summary>
    private static bool IsSpace(int c) =>
        c == ' ' || (uint)(c - '\t') <= '\r' - '\t' || c == 0x1680 || (uint)(c - 0x2000) <= 6 || (uint)(c - 0x2008) <= 2 ||
        c == 0x2028 || c == 0x2029 || c == 0x205F || c == 0x3000;

    /// <summary>Characters of no width (combining and format marks) and spacing vowel signs: they continue a word.</summary>
    private static bool IsSpecial(int c)
    {
        if (c < 0x80 || c == 0xAD || !Rune.IsValid(c)) return false;
        return Rune.GetUnicodeCategory(new Rune(c)) is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark
            or UnicodeCategory.Format or UnicodeCategory.SpacingCombiningMark;
    }

    /// <summary>Printable ASCII that RFC 3986 allows in a URL.</summary>
    private static bool IsUrlChar(int c) => c > 0x20 && c < 0x7F && c is not ('"' or '<' or '>' or '\\' or '^' or '`' or '{' or '|' or '}');

    // ------------------------------------------------------------------------------------------------- the state table

    private static Rule R(Cls cls, Act act, St to, TextTokenType type = TextTokenType.None, Sp sp = Sp.None) => new(cls, 0, act, to, type, sp);
    private static Rule C(char c, Act act, St to, TextTokenType type = TextTokenType.None, Sp sp = Sp.None) => new(Cls.EqC, c, act, to, type, sp);
    private static Rule Else(Act act, St to, TextTokenType type = TextTokenType.None, Sp sp = Sp.None) => new(Cls.Any, 0, act, to, type, sp);

    private static readonly Rule[][] Rules = BuildRules();

    private static Rule[][] BuildRules()
    {
        const Act N = Act.Next, B = Act.Bingo, P = Act.Pop, U = Act.Push, Rr = Act.Rerun, Cl = Act.Clear, M = Act.Merge, CA = Act.ClrAll;
        var t = new Rule[(int)St.Null][];
        void S(St s, params Rule[] rules) => t[(int)s] = rules;

        S(St.Base,
            R(Cls.Eof, N, St.Base), C('<', U, St.InTagFirst), R(Cls.Ignore, N, St.InSpace), R(Cls.Asclet, N, St.InAsciiWord),
            R(Cls.Alpha, N, St.InWord), R(Cls.Digit, N, St.InUnsignedInt), C('-', U, St.InSignedIntFirst),
            C('+', U, St.InSignedIntFirst), C('&', U, St.InXMLEntityFirst), C('~', U, St.InFileTwiddle),
            C('/', U, St.InFileFirst), C('.', U, St.InPathFirstFirst), Else(N, St.InSpace));
        S(St.InNumWord,
            R(Cls.Eof, B, St.Base, TextTokenType.NumWord), R(Cls.Alnum, N, St.InNumWord), R(Cls.Special, N, St.InNumWord),
            C('@', U, St.InEmail), C('/', U, St.InFileFirst), C('.', U, St.InFileNext), C('-', U, St.InHyphenNumWordFirst),
            Else(B, St.Base, TextTokenType.NumWord));
        S(St.InAsciiWord,
            R(Cls.Eof, B, St.Base, TextTokenType.AsciiWord), R(Cls.Asclet, N, St.Null), C('.', U, St.InHostFirstDomain),
            C('.', U, St.InFileNext), C('-', U, St.InHostFirstAN), C('-', U, St.InHyphenAsciiWordFirst),
            C('_', U, St.InHostFirstAN), C('@', U, St.InEmail), C(':', U, St.InProtocolFirst), C('/', U, St.InFileFirst),
            R(Cls.Digit, U, St.InHost), R(Cls.Digit, N, St.InNumWord), R(Cls.Alpha, N, St.InWord),
            R(Cls.Special, N, St.InWord), Else(B, St.Base, TextTokenType.AsciiWord));
        S(St.InWord,
            R(Cls.Eof, B, St.Base, TextTokenType.Word), R(Cls.Alpha, N, St.Null), R(Cls.Special, N, St.Null),
            R(Cls.Digit, N, St.InNumWord), C('-', U, St.InHyphenWordFirst), Else(B, St.Base, TextTokenType.Word));
        S(St.InUnsignedInt,
            R(Cls.Eof, B, St.Base, TextTokenType.UInt), R(Cls.Digit, N, St.Null), C('.', U, St.InHostFirstDomain),
            C('.', U, St.InUDecimalFirst), C('e', U, St.InMantissaFirst), C('E', U, St.InMantissaFirst),
            C('-', U, St.InHostFirstAN), C('_', U, St.InHostFirstAN), C('@', U, St.InEmail), R(Cls.Asclet, U, St.InHost),
            R(Cls.Alpha, N, St.InNumWord), R(Cls.Special, N, St.InNumWord), C('/', U, St.InFileFirst),
            Else(B, St.Base, TextTokenType.UInt));
        S(St.InSignedIntFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N | Cl, St.InSignedInt), Else(P, St.Null));
        S(St.InSignedInt,
            R(Cls.Eof, B, St.Base, TextTokenType.Int), R(Cls.Digit, N, St.Null), C('.', U, St.InDecimalFirst),
            C('e', U, St.InMantissaFirst), C('E', U, St.InMantissaFirst), Else(B, St.Base, TextTokenType.Int));
        S(St.InSpace,
            R(Cls.Eof, B, St.Base, TextTokenType.Blank), C('<', B, St.Base, TextTokenType.Blank), R(Cls.Ignore, N, St.Null),
            C('-', B, St.Base, TextTokenType.Blank), C('+', B, St.Base, TextTokenType.Blank), C('&', B, St.Base, TextTokenType.Blank),
            C('/', B, St.Base, TextTokenType.Blank), R(Cls.NotAlnum, N, St.InSpace), Else(B, St.Base, TextTokenType.Blank));
        S(St.InUDecimalFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, Cl, St.InUDecimal), Else(P, St.Null));
        S(St.InUDecimal,
            R(Cls.Eof, B, St.Base, TextTokenType.Float), R(Cls.Digit, N, St.InUDecimal), C('.', U, St.InVersionFirst),
            C('e', U, St.InMantissaFirst), C('E', U, St.InMantissaFirst), Else(B, St.Base, TextTokenType.Float));
        S(St.InDecimalFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, Cl, St.InDecimal), Else(P, St.Null));
        S(St.InDecimal,
            R(Cls.Eof, B, St.Base, TextTokenType.Float), R(Cls.Digit, N, St.InDecimal), C('.', U, St.InVerVersion),
            C('e', U, St.InMantissaFirst), C('E', U, St.InMantissaFirst), Else(B, St.Base, TextTokenType.Float));
        S(St.InVerVersion,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, Rr, St.InSVerVersion, sp: Sp.VerVersion), Else(P, St.Null));
        S(St.InSVerVersion,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, B | CA, St.InUnsignedInt, TextTokenType.Blank), Else(N, St.Null));
        S(St.InVersionFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, Cl, St.InVersion), Else(P, St.Null));
        S(St.InVersion,
            R(Cls.Eof, B, St.Base, TextTokenType.Version), R(Cls.Digit, N, St.InVersion), C('.', U, St.InVersionFirst),
            Else(B, St.Base, TextTokenType.Version));
        S(St.InMantissaFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, Cl, St.InMantissa), C('+', N, St.InMantissaSign),
            C('-', N, St.InMantissaSign), Else(P, St.Null));
        S(St.InMantissaSign,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, Cl, St.InMantissa), Else(P, St.Null));
        S(St.InMantissa,
            R(Cls.Eof, B, St.Base, TextTokenType.SciFloat), R(Cls.Digit, N, St.InMantissa), Else(B, St.Base, TextTokenType.SciFloat));
        S(St.InXMLEntityFirst,
            R(Cls.Eof, P, St.Null), C('#', N, St.InXMLEntityNumFirst), R(Cls.Asclet, N, St.InXMLEntity),
            C(':', N, St.InXMLEntity), C('_', N, St.InXMLEntity), Else(P, St.Null));
        S(St.InXMLEntity,
            R(Cls.Eof, P, St.Null), R(Cls.Alnum, N, St.InXMLEntity), C(':', N, St.InXMLEntity), C('_', N, St.InXMLEntity),
            C('.', N, St.InXMLEntity), C('-', N, St.InXMLEntity), C(';', N, St.InXMLEntityEnd), Else(P, St.Null));
        S(St.InXMLEntityNumFirst,
            R(Cls.Eof, P, St.Null), C('x', N, St.InXMLEntityHexNumFirst), C('X', N, St.InXMLEntityHexNumFirst),
            R(Cls.Digit, N, St.InXMLEntityNum), Else(P, St.Null));
        S(St.InXMLEntityHexNumFirst,
            R(Cls.Eof, P, St.Null), R(Cls.XDigit, N, St.InXMLEntityHexNum), Else(P, St.Null));
        S(St.InXMLEntityNum,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N, St.InXMLEntityNum), C(';', N, St.InXMLEntityEnd), Else(P, St.Null));
        S(St.InXMLEntityHexNum,
            R(Cls.Eof, P, St.Null), R(Cls.XDigit, N, St.InXMLEntityHexNum), C(';', N, St.InXMLEntityEnd), Else(P, St.Null));
        S(St.InXMLEntityEnd,
            Else(B | Cl, St.Base, TextTokenType.Entity));
        S(St.InTagFirst,
            R(Cls.Eof, P, St.Null), C('/', U, St.InTagCloseFirst), C('!', U, St.InCommentFirst), C('?', U, St.InXMLBegin),
            R(Cls.Asclet, U, St.InTagName), C(':', U, St.InTagName), C('_', U, St.InTagName), Else(P, St.Null));
        S(St.InXMLBegin,
            R(Cls.Eof, P, St.Null), C('x', N, St.InTag), C('X', N, St.InTag), Else(P, St.Null));
        S(St.InTagCloseFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InTagName), Else(P, St.Null));
        S(St.InTagName,
            R(Cls.Eof, P, St.Null), C('/', N, St.InTagBeginEnd), C('>', N, St.InTagEnd, sp: Sp.Tags),
            R(Cls.Space, N, St.InTag, sp: Sp.Tags), R(Cls.Alnum, N, St.Null), C(':', N, St.Null), C('_', N, St.Null),
            C('.', N, St.Null), C('-', N, St.Null), Else(P, St.Null));
        S(St.InTagBeginEnd,
            R(Cls.Eof, P, St.Null), C('>', N, St.InTagEnd), Else(P, St.Null));
        S(St.InTag,
            R(Cls.Eof, P, St.Null), C('>', N, St.InTagEnd, sp: Sp.Tags), C('\'', N, St.InTagEscapeK),
            C('"', N, St.InTagEscapeKK), R(Cls.Asclet, N, St.Null), R(Cls.Digit, N, St.Null), C('=', N, St.Null),
            C('-', N, St.Null), C('_', N, St.Null), C('#', N, St.Null), C('/', N, St.Null), C(':', N, St.Null),
            C('.', N, St.Null), C('&', N, St.Null), C('?', N, St.Null), C('%', N, St.Null), C('~', N, St.Null),
            R(Cls.Space, N, St.Null, sp: Sp.Tags), Else(P, St.Null));
        S(St.InTagEscapeK,
            R(Cls.Eof, P, St.Null), C('\\', U, St.InTagBackSleshed), C('\'', N, St.InTag), Else(N, St.InTagEscapeK));
        S(St.InTagEscapeKK,
            R(Cls.Eof, P, St.Null), C('\\', U, St.InTagBackSleshed), C('"', N, St.InTag), Else(N, St.InTagEscapeKK));
        S(St.InTagBackSleshed,
            R(Cls.Eof, P, St.Null), Else(M, St.Null));
        S(St.InTagEnd,
            Else(B | CA, St.Base, TextTokenType.Tag));
        S(St.InCommentFirst,
            R(Cls.Eof, P, St.Null), C('-', N, St.InCommentLast), C('D', N, St.InTag), C('d', N, St.InTag), Else(P, St.Null));
        S(St.InCommentLast,
            R(Cls.Eof, P, St.Null), C('-', N, St.InComment), Else(P, St.Null));
        S(St.InComment,
            R(Cls.Eof, P, St.Null), C('-', N, St.InCloseCommentFirst), Else(N, St.Null));
        S(St.InCloseCommentFirst,
            R(Cls.Eof, P, St.Null), C('-', N, St.InCloseCommentLast), Else(N, St.InComment));
        S(St.InCloseCommentLast,
            R(Cls.Eof, P, St.Null), C('-', N, St.Null), C('>', N, St.InCommentEnd), Else(N, St.InComment));
        S(St.InCommentEnd,
            Else(B | CA, St.Base, TextTokenType.Tag));
        S(St.InHostFirstDomain,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InHostDomainSecond), R(Cls.Digit, N, St.InHost), Else(P, St.Null));
        S(St.InHostDomainSecond,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InHostDomain), R(Cls.Digit, U, St.InHost), C('-', U, St.InHostFirstAN),
            C('_', U, St.InHostFirstAN), C('.', U, St.InHostFirstDomain), C('@', U, St.InEmail), Else(P, St.Null));
        S(St.InHostDomain,
            R(Cls.Eof, B | CA, St.Base, TextTokenType.Host), R(Cls.Asclet, N, St.InHostDomain), R(Cls.Digit, U, St.InHost),
            C(':', U, St.InPortFirst), C('-', U, St.InHostFirstAN), C('_', U, St.InHostFirstAN),
            C('.', U, St.InHostFirstDomain), C('@', U, St.InEmail), R(Cls.Digit, P, St.Null),
            R(Cls.StopHost, B | CA, St.InURLPathStart, TextTokenType.Host), C('/', U, St.InFURL),
            Else(B | CA, St.Base, TextTokenType.Host));
        S(St.InPortFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N, St.InPort), Else(P, St.Null));
        S(St.InPort,
            R(Cls.Eof, B | CA, St.Base, TextTokenType.Host), R(Cls.Digit, N, St.InPort),
            R(Cls.StopHost, B | CA, St.InURLPathStart, TextTokenType.Host), C('/', U, St.InFURL),
            Else(B | CA, St.Base, TextTokenType.Host));
        S(St.InHostFirstAN,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N, St.InHost), R(Cls.Asclet, N, St.InHost), Else(P, St.Null));
        S(St.InHost,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N, St.InHost), R(Cls.Asclet, N, St.InHost), C('@', U, St.InEmail),
            C('.', U, St.InHostFirstDomain), C('-', U, St.InHostFirstAN), C('_', U, St.InHostFirstAN), Else(P, St.Null));
        S(St.InEmail,
            R(Cls.StopHost, P, St.Null), R(Cls.Host, B | CA, St.Base, TextTokenType.Email), Else(P, St.Null));
        S(St.InFileFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InFile), R(Cls.Digit, N, St.InFile), C('.', N, St.InPathFirst),
            C('_', N, St.InFile), C('~', U, St.InFileTwiddle), Else(P, St.Null));
        S(St.InFileTwiddle,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InFile), R(Cls.Digit, N, St.InFile), C('_', N, St.InFile),
            C('/', N, St.InFileFirst), Else(P, St.Null));
        S(St.InPathFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InFile), R(Cls.Digit, N, St.InFile), C('_', N, St.InFile),
            C('.', N, St.InPathSecond), C('/', N, St.InFileFirst), Else(P, St.Null));
        S(St.InPathFirstFirst,
            R(Cls.Eof, P, St.Null), C('.', N, St.InPathSecond), C('/', N, St.InFileFirst), Else(P, St.Null));
        S(St.InPathSecond,
            R(Cls.Eof, B | Cl, St.Base, TextTokenType.File), C('/', N | U, St.InFileFirst), C('/', B | Cl, St.Base, TextTokenType.File),
            R(Cls.Space, B | Cl, St.Base, TextTokenType.File), Else(P, St.Null));
        S(St.InFile,
            R(Cls.Eof, B, St.Base, TextTokenType.File), R(Cls.Asclet, N, St.InFile), R(Cls.Digit, N, St.InFile),
            C('.', U, St.InFileNext), C('_', N, St.InFile), C('-', N, St.InFile), C('/', U, St.InFileFirst),
            Else(B, St.Base, TextTokenType.File));
        S(St.InFileNext,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, Cl, St.InFile), R(Cls.Digit, Cl, St.InFile), C('_', Cl, St.InFile),
            Else(P, St.Null));
        S(St.InURLPathFirst,
            R(Cls.Eof, P, St.Null), R(Cls.UrlChar, N, St.InURLPath), Else(P, St.Null));
        S(St.InURLPathStart,
            Else(N, St.InURLPath));
        S(St.InURLPath,
            R(Cls.Eof, B, St.Base, TextTokenType.UrlPath), R(Cls.UrlChar, N, St.InURLPath), Else(B, St.Base, TextTokenType.UrlPath));
        S(St.InFURL,
            R(Cls.Eof, P, St.Null), R(Cls.UrlPath, B | CA, St.Base, TextTokenType.Url, Sp.FUrl), Else(P, St.Null));
        S(St.InProtocolFirst,
            R(Cls.Eof, P, St.Null), C('/', N, St.InProtocolSecond), Else(P, St.Null));
        S(St.InProtocolSecond,
            R(Cls.Eof, P, St.Null), C('/', N, St.InProtocolEnd), Else(P, St.Null));
        S(St.InProtocolEnd,
            Else(B | CA, St.Base, TextTokenType.Protocol));
        S(St.InHyphenAsciiWordFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Asclet, N, St.InHyphenAsciiWord), R(Cls.Alpha, N, St.InHyphenWord),
            R(Cls.Digit, U, St.InHyphenDigitLookahead), Else(P, St.Null));
        S(St.InHyphenAsciiWord,
            R(Cls.Eof, B | CA, St.InParseHyphen, TextTokenType.AsciiHWord, Sp.Hyphen), R(Cls.Asclet, N, St.InHyphenAsciiWord),
            R(Cls.Alpha, N, St.InHyphenWord), R(Cls.Special, N, St.InHyphenWord), R(Cls.Digit, N, St.InHyphenNumWord),
            C('-', U, St.InHyphenAsciiWordFirst), Else(B | CA, St.InParseHyphen, TextTokenType.AsciiHWord, Sp.Hyphen));
        S(St.InHyphenWordFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Alpha, N, St.InHyphenWord), R(Cls.Digit, U, St.InHyphenDigitLookahead), Else(P, St.Null));
        S(St.InHyphenWord,
            R(Cls.Eof, B | CA, St.InParseHyphen, TextTokenType.HWord, Sp.Hyphen), R(Cls.Alpha, N, St.InHyphenWord),
            R(Cls.Special, N, St.InHyphenWord), R(Cls.Digit, N, St.InHyphenNumWord), C('-', U, St.InHyphenWordFirst),
            Else(B | CA, St.InParseHyphen, TextTokenType.HWord, Sp.Hyphen));
        S(St.InHyphenNumWordFirst,
            R(Cls.Eof, P, St.Null), R(Cls.Alpha, N, St.InHyphenNumWord), R(Cls.Digit, U, St.InHyphenDigitLookahead), Else(P, St.Null));
        S(St.InHyphenNumWord,
            R(Cls.Eof, B | CA, St.InParseHyphen, TextTokenType.NumHWord, Sp.Hyphen), R(Cls.Alnum, N, St.InHyphenNumWord),
            R(Cls.Special, N, St.InHyphenNumWord), C('-', U, St.InHyphenNumWordFirst),
            Else(B | CA, St.InParseHyphen, TextTokenType.NumHWord, Sp.Hyphen));
        S(St.InHyphenDigitLookahead,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N, St.InHyphenDigitLookahead), R(Cls.Alpha, N, St.InHyphenNumWord),
            R(Cls.Special, N, St.InHyphenNumWord), Else(P, St.Null));
        S(St.InParseHyphen,
            R(Cls.Eof, Rr, St.Base), R(Cls.Asclet, N, St.InHyphenAsciiWordPart), R(Cls.Alpha, N, St.InHyphenWordPart),
            R(Cls.Digit, U, St.InHyphenUnsignedInt), C('-', U, St.InParseHyphenHyphen), Else(Rr, St.Base));
        S(St.InParseHyphenHyphen,
            R(Cls.Eof, P, St.Null), R(Cls.Alnum, B | Cl, St.InParseHyphen, TextTokenType.Blank),
            R(Cls.Special, B | Cl, St.InParseHyphen, TextTokenType.Blank), Else(P, St.Null));
        S(St.InHyphenWordPart,
            R(Cls.Eof, B, St.Base, TextTokenType.HWordPart), R(Cls.Alpha, N, St.InHyphenWordPart),
            R(Cls.Special, N, St.InHyphenWordPart), R(Cls.Digit, N, St.InHyphenNumWordPart),
            Else(B, St.InParseHyphen, TextTokenType.HWordPart));
        S(St.InHyphenAsciiWordPart,
            R(Cls.Eof, B, St.Base, TextTokenType.HWordAsciiPart), R(Cls.Asclet, N, St.InHyphenAsciiWordPart),
            R(Cls.Alpha, N, St.InHyphenWordPart), R(Cls.Special, N, St.InHyphenWordPart),
            R(Cls.Digit, N, St.InHyphenNumWordPart), Else(B, St.InParseHyphen, TextTokenType.HWordAsciiPart));
        S(St.InHyphenNumWordPart,
            R(Cls.Eof, B, St.Base, TextTokenType.HWordNumPart), R(Cls.Alnum, N, St.InHyphenNumWordPart),
            R(Cls.Special, N, St.InHyphenNumWordPart), Else(B, St.InParseHyphen, TextTokenType.HWordNumPart));
        S(St.InHyphenUnsignedInt,
            R(Cls.Eof, P, St.Null), R(Cls.Digit, N, St.Null), R(Cls.Alpha, Cl, St.InHyphenNumWordPart),
            R(Cls.Special, Cl, St.InHyphenNumWordPart), Else(P, St.Null));

        for (var i = 0; i < t.Length; i++)
            if (t[i] is null || t[i][^1].Cls != Cls.Any)
                throw new InvalidOperationException($"Tokenizer state {(St)i} has no rules or does not end with a catch-all rule.");
        return t;
    }
}
