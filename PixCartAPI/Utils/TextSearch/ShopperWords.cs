using System.Globalization;
using System.Text;

namespace Utils.TextSearch;

/// <summary>
/// The words of a search box text as the storefront reads them: lower case (full Unicode lower-casing), split at every
/// run of characters that are not word characters (letters, digits and other numbers, and the underscore), empty
/// pieces dropped.
/// </summary>
public static class ShopperWords
{
    /// <summary>The words, at most <paramref name="max"/>.</summary>
    public static List<string> Split(string text, int max = int.MaxValue)
    {
        var outp = new List<string>();
        var cur = new StringBuilder();
        foreach (var r in Lower(text).EnumerateRunes())
        {
            if (IsWordChar(r))
            {
                cur.Append(r.ToString());
                continue;
            }
            if (cur.Length > 0)
            {
                outp.Add(cur.ToString());
                cur.Clear();
            }
        }
        if (cur.Length > 0) outp.Add(cur.ToString());
        return outp.Count > max ? outp.GetRange(0, max) : outp;
    }

    /// <summary>A word character: a letter, a number of any kind, or the underscore.</summary>
    public static bool IsWordChar(Rune r) =>
        r.Value == '_' || Rune.GetUnicodeCategory(r) is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter
            or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
            or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber;

    /// <summary>
    /// Full lower-casing: the simple mapping, plus the two context rules of the Unicode standard that apply to every
    /// language: capital I with dot above becomes "i" and a combining dot, and capital sigma at the end of a word becomes
    /// the final sigma.
    /// </summary>
    public static string Lower(string text)
    {
        var runes = text.EnumerateRunes().ToArray();
        var sb = new StringBuilder(text.Length);
        for (var i = 0; i < runes.Length; i++)
        {
            var r = runes[i];
            if (r.Value == 0x130) sb.Append("i̇");
            else if (r.Value == 0x3A3) sb.Append(FinalSigma(runes, i) ? 'ς' : 'σ');
            else sb.Append(Rune.ToLowerInvariant(r).ToString());
        }
        return sb.ToString();
    }

    private static bool FinalSigma(Rune[] runes, int i)
    {
        var j = i - 1;
        while (j >= 0 && IsCaseIgnorable(runes[j])) j--;
        if (j < 0 || !IsCased(runes[j])) return false;
        j = i + 1;
        while (j < runes.Length && IsCaseIgnorable(runes[j])) j++;
        return j == runes.Length || !IsCased(runes[j]);
    }

    private static bool IsCased(Rune r) =>
        Rune.GetUnicodeCategory(r) is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter;

    private static bool IsCaseIgnorable(Rune r) =>
        r.Value is '\'' or '.' or ':' or 0xB7 or 0x2018 or 0x2019 or 0x2024 or 0xFE52 or 0xFF07 or 0xFF0E
        || Rune.GetUnicodeCategory(r) is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark or UnicodeCategory.Format
            or UnicodeCategory.ModifierLetter or UnicodeCategory.ModifierSymbol;
}
