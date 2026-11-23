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
/// settings (<c>platform_settings['marketplace']</c>) for the parts this module needs, with the reference defaults:
/// <c>cms.get_site</c> + <c>cms.public_business</c> and <c>platform_settings.get_settings</c>. The storefront module owns the full
/// documents and their editing.
/// </summary>
public static class SiteSettingsReader
{
    /// <summary>The brand name (Admin → Storefront), or the app name before anyone set one.</summary>
    public static async Task<string> BrandNameAsync(SettingsDAL settings, AppSettings env)
    {
        var site = await settings.GetAsync("site");
        return site["brand_name"] is JsonValue v && v.TryGetValue<string>(out var s) ? s : env.AppName;
    }

    public static async Task<BusinessInfo> PublicBusinessAsync(SettingsDAL settings, AppSettings env)
    {
        var site = await settings.GetAsync("site");
        var brand = site["brand_name"] is JsonValue bv && bv.TryGetValue<string>(out var b) ? b : env.AppName;
        var business = site["business"] as JsonObject ?? [];
        var grievance = business["grievance"] as JsonObject ?? [];
        var registered = Str(business, "registered_address");

        // settings saved by earlier versions kept email/phone/address as fixed contact fields
        var contact = site["contact"] as JsonObject;
        var items = new List<(string Type, string Value, bool Enabled)>();
        if (contact is not null && contact["items"] is JsonArray arr)
        {
            foreach (var it in arr.OfType<JsonObject>())
                items.Add((Str(it, "type"), Str(it, "value"), it["enabled"] is JsonValue ev && ev.TryGetValue<bool>(out var en) && en));
        }
        else if (contact is not null)
        {
            foreach (var t in new[] { "email", "phone" })
                if (Str(contact, t).Length > 0) items.Add((t, Str(contact, t), true));
            if (Str(contact, "address").Length > 0 && business["registered_address"] is null) registered = Str(contact, "address");
        }

        var legal = Str(business, "legal_name");
        return new BusinessInfo(
            brand, legal.Length > 0 ? legal : brand, Str(business, "gstin"), Str(business, "cin"), registered,
            Str(grievance, "name"), Str(grievance, "email"), Str(grievance, "phone"),
            items.FirstOrDefault(i => i.Type == "email" && i.Enabled).Value ?? "",
            items.FirstOrDefault(i => i.Type == "phone" && i.Enabled).Value ?? "");
    }

    /// <summary>One marketplace setting (Admin → Marketplace settings) or its default.</summary>
    public static async Task<JsonNode?> MarketplaceAsync(SettingsDAL settings, string key, JsonNode? fallback)
    {
        var saved = await settings.GetAsync("marketplace");
        return saved.TryGetPropertyValue(key, out var v) && v is not null ? v.DeepClone() : fallback;
    }

    private static string Str(JsonObject o, string key) => o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
}
