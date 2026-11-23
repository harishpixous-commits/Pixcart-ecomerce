using System.Security.Cryptography;
using System.Text;

namespace Utils;

/// <summary>
/// Passwords (bcrypt, cost 12), one-way hashes for tokens (SHA-256 hex) and field encryption for PAN, bank numbers and
/// saved integration keys. Field encryption is Fernet (AES-128-CBC + HMAC-SHA256), byte-for-byte compatible with the
/// reference version, so data copied from it still decrypts.
/// </summary>
public class EncryptDecrypt
{
    private readonly byte[] _signingKey;
    private readonly byte[] _encryptionKey;
    private static readonly string DummyHash = BCrypt.Net.BCrypt.HashPassword("dummy", 12);

    public EncryptDecrypt(AppSettings settings)
    {
        var key = FromBase64Url(settings.FieldEncryptionKey);
        if (key.Length != 32) throw new InvalidOperationException("FieldEncryptionKey must be 32 bytes, urlsafe base64 (a Fernet key)");
        _signingKey = key[..16];
        _encryptionKey = key[16..];
    }

    // ---------------------------------------------------------------- passwords

    public static string HashPassword(string password) => BCrypt.Net.BCrypt.HashPassword(password, 12);

    /// <summary>Constant work even when there is no hash, so timing does not reveal which accounts exist.</summary>
    public static bool VerifyPassword(string password, string? hash)
    {
        if (string.IsNullOrEmpty(hash))
        {
            BCrypt.Net.BCrypt.Verify("not-the-password", DummyHash);
            return false;
        }
        try { return BCrypt.Net.BCrypt.Verify(password, hash); }
        catch (BCrypt.Net.SaltParseException) { return false; }
    }

    // ---------------------------------------------------------------- tokens

    /// <summary>A random token for cookies and links (64 characters, like Python's secrets.token_urlsafe(48)).</summary>
    public static string NewOpaqueToken() => ToBase64Url(RandomNumberGenerator.GetBytes(48));

    public static string Sha256(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static string HmacSha256Hex(string secret, string message) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(message)));

    public static string HmacSha256Hex(string secret, byte[] message) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), message));

    /// <summary>Compares two strings in constant time (signatures, codes).</summary>
    public static bool SafeEquals(string? a, string? b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a ?? ""), Encoding.UTF8.GetBytes(b ?? ""));

    /// <summary>A numeric one-time code of the given length.</summary>
    public static string NumericCode(int length)
    {
        var sb = new StringBuilder(length);
        for (var i = 0; i < length; i++) sb.Append(RandomNumberGenerator.GetInt32(10));
        return sb.ToString();
    }

    // ---------------------------------------------------------------- Fernet field encryption

    public string Encrypt(string plain)
    {
        var iv = RandomNumberGenerator.GetBytes(16);
        using var aes = Aes.Create();
        aes.Key = _encryptionKey;
        var cipher = aes.EncryptCbc(Encoding.UTF8.GetBytes(plain), iv, PaddingMode.PKCS7);
        var ts = BitConverter.GetBytes((ulong)DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        if (BitConverter.IsLittleEndian) Array.Reverse(ts);
        var body = new byte[1 + 8 + 16 + cipher.Length];
        body[0] = 0x80;
        Buffer.BlockCopy(ts, 0, body, 1, 8);
        Buffer.BlockCopy(iv, 0, body, 9, 16);
        Buffer.BlockCopy(cipher, 0, body, 25, cipher.Length);
        var mac = HMACSHA256.HashData(_signingKey, body);
        var all = new byte[body.Length + mac.Length];
        Buffer.BlockCopy(body, 0, all, 0, body.Length);
        Buffer.BlockCopy(mac, 0, all, body.Length, mac.Length);
        return ToBase64Url(all);
    }

    /// <summary>The plain text, or "" when the value is empty or cannot be decrypted (a different key).</summary>
    public string Decrypt(string? token)
    {
        if (string.IsNullOrEmpty(token)) return "";
        try
        {
            var data = FromBase64Url(token);
            if (data.Length < 57 || data[0] != 0x80) return "";
            var body = data[..^32];
            var mac = data[^32..];
            if (!CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(_signingKey, body), mac)) return "";
            using var aes = Aes.Create();
            aes.Key = _encryptionKey;
            var plain = aes.DecryptCbc(body[25..], body[9..25], PaddingMode.PKCS7);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception e) when (e is FormatException or CryptographicException) { return ""; }
    }

    public static string ToBase64Url(byte[] bytes) => Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    public static byte[] FromBase64Url(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(t.PadRight(t.Length + (4 - t.Length % 4) % 4, '='));
    }
}
