using Utils;
using System.Text.Json.Nodes;
using BAL.Interface;
using Utils.Interface;
namespace BAL;

/// <summary>Return reasons as staff set them (mirror of growth.return_reasons). Admin → Growth → Return reasons: rename a reason or switch it off.
/// Codes never change; an empty label keeps the built-in text. With onlyOn, switched-off reasons are left out (all stay if staff switched every one off).</summary>
public static class ReturnReasonsConfig
{
    public static async Task<Dictionary<string, string>> Async(IMySqlDapperHelper db, bool onlyOn = true)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["return_reasons"]!;
        var labels = PlatformSettingsBAL.ReturnReasons.ToDictionary(kv => kv.Key, kv => string.IsNullOrWhiteSpace(cfg["label_" + kv.Key]?.ToString()) ? kv.Value : cfg["label_" + kv.Key]!.ToString().Trim());
        if (!onlyOn) return labels;
        var on = labels.Where(kv => !cfg.Bool("off_" + kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value);
        return on.Count > 0 ? on : labels;
    }
}
