using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>Public storefront configuration: /api/site, the home page with its products resolved, and CMS pages.</summary>
public interface IStorefrontBAL
{
    /// <summary>GET /api/site: site settings plus features, payments, gallery, product page switches, reviews, lists, maintenance, error pages, app links.</summary>
    Task<JsonObject> SiteAsync();

    /// <summary>GET /api/home: live sections (empty product rows left out) and the category tree.</summary>
    Task<JsonObject> HomeAsync();

    /// <summary>GET /api/pages/{slug}: a published page, or the built-in text of a standard page; 404 "Page not found".</summary>
    Task<JsonObject> PageAsync(string slug);
}
