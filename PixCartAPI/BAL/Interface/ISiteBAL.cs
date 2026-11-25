using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>
/// Storefront customisation (Admin → Storefront; <c>platform_settings['site']</c> and <c>home_sections</c>): brand and
/// colours, theme and per-theme settings, navigation, footer, announcement, business and grievance details, contact and
/// social links, SEO, analytics, and the home page sections. Used by /api/site, invoices, emails and the admin panel.
/// </summary>
public interface ISiteBAL
{
    /// <summary>The site settings: defaults with the saved values on top (older saved formats upgraded), theme cleaned.</summary>
    Task<JsonObject> GetSiteAsync();

    /// <summary>
    /// Checks and saves the whole site document; returns what was saved. 400 "invalid_site" with the reference message
    /// (e.g. "Colour 'primary' must be a hex value like #0B5563") when something is not allowed.
    /// </summary>
    Task<JsonObject> SaveSiteAsync(JsonObject data, System.Data.IDbTransaction? tx = null);

    /// <summary>
    /// Switches the theme and merges per-theme presets, colours and layout over the saved ones, leaving every other site
    /// setting as it is. Returns {"theme", "theme_settings"}; 400 "invalid_theme" for unknown themes or bad values.
    /// </summary>
    Task<JsonObject> SaveThemeAsync(string theme, JsonObject? settings, System.Data.IDbTransaction? tx = null);

    /// <summary>The operator details other modules need: brand, legal name, GSTIN, CIN, address, grievance, support email and phone.</summary>
    JsonObject PublicBusiness(JsonObject site);

    /// <summary>A home section's settings checked and cleaned for its kind; 400 "invalid_section" with the reference message.</summary>
    JsonObject ValidateSection(string kind, JsonObject? config);

    /// <summary>Adds the starting home page sections when there are none.</summary>
    Task EnsureDefaultSectionsAsync();

    /// <summary>A section as the admin panel lists it (with kind_label, position, schedule).</summary>
    JsonObject SectionOut(HomeSectionModel s);

    /// <summary>Section kinds and their names, for the admin's "add a section" list.</summary>
    IReadOnlyDictionary<string, string> SectionKinds { get; }

    /// <summary>Built-in pages shown until the admin writes their own: slug → (title, body).</summary>
    IReadOnlyDictionary<string, (string Title, string Body)> DefaultPages { get; }
}
