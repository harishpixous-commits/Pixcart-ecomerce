using BAL.Interface;
using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>The one-time welcome popup the storefront opens (Admin → Growth → Promo popup). Its link must stay on this site.</summary>
public static class PromoPopup
{
    public static async Task<JsonObject> BoxAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var c = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["promo_popup"]!;
        var link = c.Str("link").Trim();
        if (!link.StartsWith('/') || link.StartsWith("//") || link.Contains('\\')) link = "";
        var on = c.Bool("enabled") && (c.Str("title").Trim().Length > 0 || c.Str("body").Trim().Length > 0);
        if (!on) return new() { ["enabled"] = false };
        return new() { ["enabled"] = true, ["title"] = c.Str("title"), ["body"] = c.Str("body"), ["button_label"] = link.Length > 0 ? c.Str("button_label") : "", ["link"] = link, ["delay_seconds"] = c.Int("delay_seconds") };
    }
}
