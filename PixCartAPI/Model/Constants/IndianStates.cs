using System.Text.RegularExpressions;

namespace Model.Constants;

/// <summary>
/// GST state codes and their names, and the Indian identifier checks the storefront needs (PIN code, GSTIN with its
/// check character). Same table and messages as the reference version's core/validators.py.
/// </summary>
public static partial class IndianStates
{
    public static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string>
    {
        ["01"] = "Jammu and Kashmir", ["02"] = "Himachal Pradesh", ["03"] = "Punjab", ["04"] = "Chandigarh", ["05"] = "Uttarakhand",
        ["06"] = "Haryana", ["07"] = "Delhi", ["08"] = "Rajasthan", ["09"] = "Uttar Pradesh", ["10"] = "Bihar", ["11"] = "Sikkim",
        ["12"] = "Arunachal Pradesh", ["13"] = "Nagaland", ["14"] = "Manipur", ["15"] = "Mizoram", ["16"] = "Tripura", ["17"] = "Meghalaya",
        ["18"] = "Assam", ["19"] = "West Bengal", ["20"] = "Jharkhand", ["21"] = "Odisha", ["22"] = "Chhattisgarh", ["23"] = "Madhya Pradesh",
        ["24"] = "Gujarat", ["26"] = "Dadra and Nagar Haveli and Daman and Diu", ["27"] = "Maharashtra", ["29"] = "Karnataka", ["30"] = "Goa",
        ["31"] = "Lakshadweep", ["32"] = "Kerala", ["33"] = "Tamil Nadu", ["34"] = "Puducherry", ["35"] = "Andaman and Nicobar Islands",
        ["36"] = "Telangana", ["37"] = "Andhra Pradesh", ["38"] = "Ladakh",
    };

    private const string GstinChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    [GeneratedRegex(@"^[1-9]\d{5}$")]
    private static partial Regex PinRx();

    [GeneratedRegex(@"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")]
    private static partial Regex GstinRx();

    /// <summary>The state's name, or "" for an unknown code.</summary>
    public static string Name(string? code) => code != null && Names.TryGetValue(code, out var n) ? n : "";

    /// <summary>A 6-digit PIN code, or ArgumentException("Enter a valid 6-digit PIN code").</summary>
    public static string ValidatePincode(string? value)
    {
        var v = (value ?? "").Trim();
        if (!PinRx().IsMatch(v)) throw new ArgumentException("Enter a valid 6-digit PIN code");
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

    /// <summary>A valid GSTIN in capitals, or ArgumentException with the reference message.</summary>
    public static string ValidateGstin(string? value)
    {
        var v = (value ?? "").Trim().ToUpperInvariant();
        if (!GstinRx().IsMatch(v)) throw new ArgumentException("Enter a valid 15-character GSTIN");
        if (!Names.ContainsKey(v[..2])) throw new ArgumentException("GSTIN state code is not valid");
        if (GstinCheckChar(v[..14]) != v[14]) throw new ArgumentException("GSTIN check digit does not match; please re-check the number");
        return v;
    }
}
