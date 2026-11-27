using System.Text.Json.Nodes;
using BAL.Interface;
using Utils.Interface;
namespace BAL;

/// <summary>Cash on delivery risk rules (Admin → Growth → COD risk; mirror of services/growth.cod_block_reason). Off by default.
/// The marketplace limit cod_max_order_paise is checked separately.</summary>
public static class CodRisk
{
    public static async Task<string?> ReasonAsync(IUnitOfWork uow, Guid userId, string pincode, long grandTotal)
    {
        var saved = Utils.JsonHelper.Object(await uow.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["cod_risk"]!;
        if (!cfg.Bool("enabled")) return null;
        if ((cfg["blocked_pincodes"] as JsonArray ?? []).Any(x => x?.GetValue<string>() == pincode)) return "Cash on delivery is not available for this pincode. Please pay online.";
        if (cfg.Int("max_cod_paise") > 0 && grandTotal > cfg.Int("max_cod_paise")) return "Cash on delivery is not available for this order value. Please pay online.";
        if (cfg.Int("new_account_max_cod_paise") > 0 && grandTotal > cfg.Int("new_account_max_cod_paise"))
        {
            var delivered = await uow.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM sub_orders so JOIN orders o ON o.id = so.order_id WHERE o.user_id = @userId AND so.status = 'delivered'", new { userId });
            if (delivered == 0) return "Cash on delivery for a first order is limited. Please pay online or order a smaller amount.";
        }
        return null;
    }
}
