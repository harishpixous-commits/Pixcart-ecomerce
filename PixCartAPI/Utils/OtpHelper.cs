using System.Security.Cryptography;

namespace Utils;

/// <summary>One-time codes (reference: core/security.py generate_otp / hash_otp).</summary>
public static class OtpHelper
{
    /// <summary>Reference: generate_otp — digits only, from a cryptographic source.</summary>
    public static string Generate(int length)
    {
        var chars = new char[length];
        for (var i = 0; i < length; i++)
            chars[i] = (char)('0' + RandomNumberGenerator.GetInt32(10));
        return new string(chars);
    }

    /// <summary>Reference: hash_otp — HMAC-SHA256 of "phone:code" with the JWT secret, hex.</summary>
    public static string Hash(string secret, string phone, string code) =>
        EncryptDecrypt.HmacSha256Hex(secret, $"{phone}:{code}");
}
