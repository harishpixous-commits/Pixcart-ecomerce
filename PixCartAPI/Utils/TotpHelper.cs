using System.Security.Cryptography;
using System.Text;

namespace Utils;

/// <summary>
/// RFC 6238 time-based one-time passwords (Google Authenticator, Authy, Microsoft Authenticator), the same as the
/// reference version's core/totp.py: 6 digits, 30-second steps, SHA-1, one step of clock drift either way.
/// </summary>
public static class TotpHelper
{
    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>A new base32 secret (20 random bytes, no padding).</summary>
    public static string NewSecret() => Base32Encode(RandomNumberGenerator.GetBytes(20)).TrimEnd('=');

    /// <summary>True when the code matches the secret now (or one step before or after).</summary>
    public static bool Verify(string secret, string? code, long? atUnixSeconds = null, int window = 1)
    {
        code = (code ?? "").Trim().Replace(" ", "");
        if (code.Length != 6 || !code.All(char.IsAsciiDigit) || string.IsNullOrEmpty(secret)) return false;
        var step = (atUnixSeconds ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()) / 30;
        try
        {
            for (var d = -window; d <= window; d++)
                if (EncryptDecrypt.SafeEquals(Code(secret, step + d), code)) return true;
        }
        catch (FormatException)
        {
            return false;
        }
        return false;
    }

    /// <summary>The current code (tests and setup screens).</summary>
    public static string Current(string secret, long? atUnixSeconds = null) =>
        Code(secret, (atUnixSeconds ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()) / 30);

    /// <summary>The otpauth:// address shown as a QR code.</summary>
    public static string Uri(string secret, string account, string issuer) =>
        $"otpauth://totp/{Quote(issuer)}:{Quote(account)}?secret={secret}&issuer={Quote(issuer)}&digits=6&period=30";

    private static string Code(string secret, long counter)
    {
        var key = Base32Decode(secret);
        var msg = BitConverter.GetBytes((ulong)counter);
        if (BitConverter.IsLittleEndian) Array.Reverse(msg);
        var digest = HMACSHA1.HashData(key, msg);
        var offset = digest[^1] & 0x0F;
        var value = ((digest[offset] & 0x7F) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
        return (value % 1_000_000).ToString("D6");
    }

    /// <summary>Python's urllib.parse.quote (safe "/").</summary>
    private static string Quote(string s)
    {
        var sb = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            var c = (char)b;
            if (char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '-' or '~' or '/') sb.Append(c);
            else sb.Append('%').Append(b.ToString("X2"));
        }
        return sb.ToString();
    }

    private static string Base32Encode(byte[] data)
    {
        var sb = new StringBuilder();
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Alphabet[(buffer << (5 - bits)) & 31]);
        while (sb.Length % 8 != 0) sb.Append('=');
        return sb.ToString();
    }

    private static byte[] Base32Decode(string s)
    {
        var clean = s.Trim().TrimEnd('=').ToUpperInvariant();
        var bytes = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var c in clean)
        {
            var v = Alphabet.IndexOf(c);
            if (v < 0) throw new FormatException("Not base32");
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8)
            {
                bytes.Add((byte)((buffer >> (bits - 8)) & 0xFF));
                bits -= 8;
            }
        }
        return bytes.ToArray();
    }
}
