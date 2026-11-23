using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace Model.CustomeAttributes;

/// <summary>
/// Indian identifiers (the reference version's core/validators.py): mobile, PIN code, state code, PAN, GSTIN with its
/// check character, IFSC, bank account number. Each Normalize/Validate function returns the cleaned value or throws
/// <see cref="ArgumentException"/> with the message shown to people; the attributes below use the same rules on request bodies.
/// </summary>
public static partial class IndianFormats
{
    public static readonly IReadOnlyDictionary<string, string> States = new Dictionary<string, string>
    {
        ["01"] = "Jammu and Kashmir", ["02"] = "Himachal Pradesh", ["03"] = "Punjab", ["04"] = "Chandigarh", ["05"] = "Uttarakhand",
        ["06"] = "Haryana", ["07"] = "Delhi", ["08"] = "Rajasthan", ["09"] = "Uttar Pradesh", ["10"] = "Bihar", ["11"] = "Sikkim",
        ["12"] = "Arunachal Pradesh", ["13"] = "Nagaland", ["14"] = "Manipur", ["15"] = "Mizoram", ["16"] = "Tripura", ["17"] = "Meghalaya",
        ["18"] = "Assam", ["19"] = "West Bengal", ["20"] = "Jharkhand", ["21"] = "Odisha", ["22"] = "Chhattisgarh", ["23"] = "Madhya Pradesh",
        ["24"] = "Gujarat", ["26"] = "Dadra and Nagar Haveli and Daman and Diu", ["27"] = "Maharashtra", ["29"] = "Karnataka", ["30"] = "Goa",
        ["31"] = "Lakshadweep", ["32"] = "Kerala", ["33"] = "Tamil Nadu", ["34"] = "Puducherry", ["35"] = "Andaman and Nicobar Islands",
        ["36"] = "Telangana", ["37"] = "Andhra Pradesh", ["38"] = "Ladakh",
    };

    [GeneratedRegex(@"^[6-9]\d{9}$")] private static partial Regex Mobile();
    [GeneratedRegex(@"^[1-9]\d{5}$")] private static partial Regex Pin();
    [GeneratedRegex(@"^[A-Z]{5}[0-9]{4}[A-Z]$")] private static partial Regex Pan();
    [GeneratedRegex(@"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")] private static partial Regex Gstin();
    [GeneratedRegex(@"^[A-Z]{4}0[A-Z0-9]{6}$")] private static partial Regex Ifsc();
    [GeneratedRegex(@"^\d{9,18}$")] private static partial Regex Account();
    [GeneratedRegex(@"[^a-z0-9]+")] private static partial Regex NonSlug();
    private const string GstinChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    /// <summary>Accepts "98765 43210", "+91-9876543210", "09876543210"; returns 10 digits.</summary>
    public static string NormalizeMobile(string? value)
    {
        var digits = new string((value ?? "").Where(char.IsAsciiDigit).ToArray());
        if (digits.Length == 12 && digits.StartsWith("91")) digits = digits[2..];
        else if (digits.Length == 11 && digits.StartsWith('0')) digits = digits[1..];
        if (!Mobile().IsMatch(digits)) throw new ArgumentException("Enter a valid 10-digit Indian mobile number");
        return digits;
    }

    public static string ValidatePincode(string? value)
    {
        var v = (value ?? "").Trim();
        if (!Pin().IsMatch(v)) throw new ArgumentException("Enter a valid 6-digit PIN code");
        return v;
    }

    public static string ValidateStateCode(string? value)
    {
        var v = (value ?? "").Trim().PadLeft(2, '0');
        if (!States.ContainsKey(v)) throw new ArgumentException("Choose a valid state");
        return v;
    }

    public static string ValidatePan(string? value)
    {
        var v = (value ?? "").Trim().ToUpperInvariant();
        if (!Pan().IsMatch(v)) throw new ArgumentException("Enter a valid PAN (e.g. ABCDE1234F)");
        return v;
    }

    public static char GstinCheckChar(string first14)
    {
        var total = 0;
        for (var i = 0; i < first14.Length; i++)
        {
            var value = GstinChars.IndexOf(first14[i]);
            var product = value * (i % 2 == 1 ? 2 : 1);
            total += product / 36 + product % 36;
        }
        return GstinChars[(36 - total % 36) % 36];
    }

    public static string ValidateGstin(string? value)
    {
        var v = (value ?? "").Trim().ToUpperInvariant();
        if (!Gstin().IsMatch(v)) throw new ArgumentException("Enter a valid 15-character GSTIN");
        if (!States.ContainsKey(v[..2])) throw new ArgumentException("GSTIN state code is not valid");
        if (GstinCheckChar(v[..14]) != v[14]) throw new ArgumentException("GSTIN check digit does not match; please re-check the number");
        return v;
    }

    public static string ValidateIfsc(string? value)
    {
        var v = (value ?? "").Trim().ToUpperInvariant();
        if (!Ifsc().IsMatch(v)) throw new ArgumentException("Enter a valid IFSC (e.g. SBIN0001234)");
        return v;
    }

    public static string ValidateAccountNumber(string? value)
    {
        var v = new string((value ?? "").Where(c => !char.IsWhiteSpace(c)).ToArray());
        if (!Account().IsMatch(v)) throw new ArgumentException("Bank account number must be 9 to 18 digits");
        return v;
    }

    /// <summary>"Ravi  Electricals!" → "ravi-electricals" (at most maxLen characters; "item" when nothing is left).</summary>
    public static string Slugify(string? value, int maxLen = 80)
    {
        var s = NonSlug().Replace((value ?? "").ToLowerInvariant(), "-").Trim('-');
        if (s.Length > maxLen) s = s[..maxLen];
        s = s.TrimEnd('-');
        return s.Length > 0 ? s : "item";
    }
}

/// <summary>Base for the format attributes: runs a validator and shows its message (null is left to [Required]).</summary>
public abstract class FormatAttribute(Func<string?, string> check) : ValidationAttribute
{
    protected override ValidationResult? IsValid(object? value, ValidationContext context)
    {
        if (value is null) return ValidationResult.Success;
        try
        {
            check(value as string);
            return ValidationResult.Success;
        }
        catch (ArgumentException e)
        {
            return new ValidationResult(e.Message, context.MemberName is { } m ? [m] : null);
        }
    }
}

/// <summary>A 10-digit Indian mobile number (spaces, +91 and a leading 0 are accepted).</summary>
public sealed class MobileAttribute() : FormatAttribute(IndianFormats.NormalizeMobile);

/// <summary>A 6-digit PIN code.</summary>
public sealed class PinCodeAttribute() : FormatAttribute(IndianFormats.ValidatePincode);

/// <summary>A GST state code ("33" for Tamil Nadu).</summary>
public sealed class StateCodeAttribute() : FormatAttribute(IndianFormats.ValidateStateCode);

/// <summary>A PAN like ABCDE1234F.</summary>
public sealed class PanAttribute() : FormatAttribute(IndianFormats.ValidatePan);

/// <summary>A 15-character GSTIN with a valid state code and check character.</summary>
public sealed class GstinAttribute() : FormatAttribute(IndianFormats.ValidateGstin);

/// <summary>An 11-character IFSC.</summary>
public sealed class IfscAttribute() : FormatAttribute(IndianFormats.ValidateIfsc);

/// <summary>A bank account number of 9 to 18 digits.</summary>
public sealed class BankAccountAttribute() : FormatAttribute(IndianFormats.ValidateAccountNumber);
