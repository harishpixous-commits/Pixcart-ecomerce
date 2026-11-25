using System.Text;

namespace API.Helpers;

/// <summary>Query-string encoding identical to the reference's urllib.parse.urlencode (quote_plus).</summary>
public static class UrlQuery
{
    /// <summary>Letters, digits and _.-~ stay; a space becomes +; every other UTF-8 byte becomes %XX (upper case).</summary>
    public static string QuotePlus(string value)
    {
        var sb = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_' or '.' or '-' or '~') sb.Append(c);
            else if (c == ' ') sb.Append('+');
            else sb.Append('%').Append(b.ToString("X2"));
        }
        return sb.ToString();
    }
}
