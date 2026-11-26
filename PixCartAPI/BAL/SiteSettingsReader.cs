using System.Text.Json.Nodes;
using DAL;
using Utils;

namespace BAL;

/// <summary>The marketplace operator's details other modules need (emails, notifications, authenticator issuer).</summary>
public record BusinessInfo(
    string Brand, string LegalName, string Gstin, string Cin, string RegisteredAddress,
    string GrievanceName, string GrievanceEmail, string GrievancePhone, string SupportEmail, string SupportPhone);

/// <summary>
/// Reads the storefront settings (<c>platform_settings['site']</c>, edited in Admin → Storefront) and the marketplace
/// settings (<c>platform_settings['marketplace']</c>) for the parts this module needs, with their defaults. The storefront
/// module owns the full documents and their editing (the operator's details come from ISiteBAL).
/// </summary>
public static class SiteSettingsReader
{
    /// <summary>The brand name (Admin → Storefront), or the app name before anyone set one.</summary>
    public static async Task<string> BrandNameAsync(SettingsDAL settings, AppSettings env)
    {
        var site = await settings.GetAsync("site");
        return site["brand_name"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : env.AppName;
    }

    /// <summary>One marketplace setting (Admin → Marketplace settings) or its default.</summary>
    public static async Task<JsonNode?> MarketplaceAsync(SettingsDAL settings, string key, JsonNode? fallback)
    {
        var saved = await settings.GetAsync("marketplace");
        return saved.TryGetPropertyValue(key, out var v) && v is not null ? v.DeepClone() : fallback;
    }

}
