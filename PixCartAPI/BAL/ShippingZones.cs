using System.Text.Json.Nodes;
using BAL.Interface;
using System.Text.RegularExpressions;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Remote-area delivery surcharge (mirror of growth.remote_surcharge). Admin → Growth → Shipping zones, off by default: an extra fee
/// per seller package for pincodes that start with a listed prefix. Returns (amount in paise, waive when the package already ships free).</summary>
public static class ShippingZones
{
    /// <summary>Admin → Growth → Seller shipping: bounds (paise) for a seller's own free-delivery amount; null while switched off.</summary>
    public static async Task<(long Min, long Max)?> SellerFreeBoundsAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["seller_shipping"]!;
        if (!cfg.Bool("enabled")) return null;
        var min = (long)cfg.Int("min_paise");
        return (min, Math.Max(min, (long)cfg.Int("max_paise")));
    }

    /// <summary>"state_fees" ("33:3000, 29:5000"): the delivery fee in paise for a package that does not ship free, by destination state; null when off or not listed.</summary>
    public static async Task<long?> StateFeeAsync(IMySqlDapperHelper db, string? stateCode)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["shipping_zones"]!;
        if (!cfg.Bool("enabled")) return null;
        foreach (Match m in Regex.Matches(cfg["state_fees"]?.ToString() ?? "", @"(\d{2})\s*[:=]\s*(\d{1,7})"))
            if (m.Groups[1].Value == (stateCode ?? "")) return long.Parse(m.Groups[2].Value);
        return null;
    }

    public static async Task<(long Amount, bool Waive)> SurchargeAsync(IMySqlDapperHelper db, string? pincode)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["shipping_zones"]!;
        if (!cfg.Bool("enabled") || cfg.Int("remote_surcharge_paise") == 0) return (0, true);
        var prefixes = Regex.Matches(cfg["remote_prefixes"]?.ToString() ?? "", @"\d{1,6}").Select(m => m.Value);
        return prefixes.Any(x => (pincode ?? "").StartsWith(x, StringComparison.Ordinal)) ? (cfg.Int("remote_surcharge_paise"), cfg.Bool("waive_when_free")) : (0, true);
    }
}
