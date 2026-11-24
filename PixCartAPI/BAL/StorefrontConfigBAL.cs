using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Public storefront configuration (reference: routers/storefront.py): /api/site (brand, theme, menus and the
/// storefront feature flags), /api/home (home sections with their products resolved) and /api/pages/{slug}.
/// </summary>
public class StorefrontConfigBAL(
    SiteBAL site, PlatformSettingsBAL platform, ReviewSettingsBAL reviews, AiBAL ai, RazorpayBAL razorpay,
    CatalogBAL catalog, DealsBAL deals, CmsDAL cms, AppSettings app)
{
    /// <summary>Reference: GET /api/site.</summary>
    public async Task<JsonObject> SiteConfigAsync()
    {
        var s = await site.GetSiteAsync();
        var cfg = await platform.GetAsync();
        var aiCfg = await ai.GetSettingsAsync();
        var features = new JsonObject();
        foreach (var (k, v) in cfg)
            if (k.StartsWith("feature_")) features[k["feature_".Length..]] = v?.DeepClone();
        // Sellers see AI buttons when AI studio is on and a key is set (or, outside production, in sandbox mode).
        features["ai"] = aiCfg.Bool("enabled") && (await ai.ModeAsync() == "live" || !app.IsProduction);
        var pdp = new JsonObject();
        foreach (var (k, v) in cfg)
            if (k.StartsWith("pdp_")) pdp[k["pdp_".Length..]] = v?.DeepClone();
        pdp["header_pincode"] = cfg.Bool("header_pincode");
        pdp["page_loading_bar"] = cfg.Bool("page_loading_bar");
        var lists = new JsonObject();
        foreach (var k in PlatformSettingsBAL.ListKeys) lists[k] = cfg[k]?.DeepClone();
        var errorPages = new JsonObject();
        foreach (var k in PlatformSettingsBAL.ErrorPageKeys) errorPages[k] = cfg[k]?.DeepClone();
        var outp = (JsonObject)s.DeepClone();
        outp["features"] = features;
        outp["cod_enabled"] = cfg.Bool("cod_enabled");
        outp["online_payments"] = await razorpay.OnlinePaymentsAsync();
        outp["free_shipping_threshold_paise"] = cfg.Long("free_shipping_threshold_paise");
        outp["gallery"] = new JsonObject
        {
            ["zoom"] = cfg.Bool("gallery_zoom"), ["zoom_level"] = cfg.Long("gallery_zoom_level") / 10.0,
            ["max_video_mb"] = cfg.Long("max_video_mb"), ["max_videos"] = cfg.Long("max_videos_per_listing"),
        };
        outp["shipping_fee_paise"] = cfg.Long("shipping_fee_paise");
        outp["max_qty_per_item"] = cfg.Long("max_qty_per_item");
        outp["pdp"] = pdp;
        outp["reviews"] = reviews.Public(await reviews.GetAsync());
        outp["lists"] = lists;
        outp["maintenance"] = new JsonObject { ["on"] = cfg.Bool("maintenance_mode"), ["message"] = cfg.Str("maintenance_message") };
        outp["error_pages"] = errorPages;
        outp["payment_return"] = cfg.Str("payment_return_mode");
        outp["app"] = new JsonObject
        {
            ["banner"] = cfg.Bool("shop_app_banner"), ["android_apk_url"] = cfg.Str("shop_android_apk_url"),
            ["play_store_url"] = cfg.Str("shop_play_store_url"), ["app_store_url"] = cfg.Str("shop_app_store_url"),
            ["version"] = cfg.Str("shop_app_version"),
        };
        return outp;
    }

    /// <summary>Reference: GET /api/home. Sections resolve their products; empty sections drop out.</summary>
    public async Task<JsonObject> HomeAsync()
    {
        await site.EnsureDefaultSectionsAsync();
        var now = DateTimeFunctions.UtcNow();
        var sections = await cms.LiveSectionsAsync(now);
        var tree = await catalog.CategoryTreeAsync();
        await deals.SyncAsync();
        var outp = new JsonArray();
        foreach (var s in sections)
        {
            var data = new JsonObject
            {
                ["id"] = s.Id.ToString(), ["kind"] = s.Kind, ["title"] = s.Title, ["device"] = s.Device,
                ["config"] = JsonNode.Parse(s.Config ?? "{}")?.DeepClone(),
            };
            var config = (JsonObject)data["config"]!;
            switch (s.Kind)
            {
                case "products":
                {
                    var products = await catalog.ProductsForAsync(config);
                    if (products.Count == 0) continue;
                    data["products"] = new JsonArray(products.Select(p => (JsonNode)p).ToArray());
                    break;
                }
                case "deals":
                {
                    var cfg = new JsonObject
                    {
                        ["source"] = "deals_live",
                        ["limit"] = config.TryGetPropertyValue("limit", out var l) && l is not null ? l.DeepClone() : 12,
                    };
                    if (config.TryGetPropertyValue("kind", out var kind) && kind is not null) cfg["kind"] = kind.DeepClone();
                    var products = await catalog.ProductsForAsync(cfg);
                    if (products.Count == 0) continue;
                    data["products"] = new JsonArray(products.Select(p => (JsonNode)p).ToArray());
                    break;
                }
                case "cards":
                {
                    var cards = new JsonArray();
                    foreach (var cardNode in config["cards"] as JsonArray ?? [])
                    {
                        if (cardNode is not JsonObject card) continue;
                        card = (JsonObject)card.DeepClone();
                        if (card.Str("mode") == "products")
                        {
                            var cfg = new JsonObject
                            {
                                ["source"] = card.TryGetPropertyValue("source", out var src) && src is not null ? src.DeepClone() : "deals",
                                ["limit"] = 4,
                            };
                            if (card.TryGetPropertyValue("category_slug", out var slug) && slug is not null) cfg["category_slug"] = slug.DeepClone();
                            var products = await catalog.ProductsForAsync(cfg);
                            if (products.Count == 0) continue;
                            card["products"] = new JsonArray(products.Select(p => (JsonNode)p).ToArray());
                        }
                        cards.Add(card);
                    }
                    if (cards.Count == 0) continue;
                    config["cards"] = cards;
                    break;
                }
                case "countdown":
                {
                    var endsAt = config.Str("ends_at");
                    if (endsAt.Length == 0 || DateTime.Parse(endsAt, null, System.Globalization.DateTimeStyles.RoundtripKind) <= now) continue;
                    break;
                }
                case "categories":
                {
                    var slugs = (config["slugs"] as JsonArray ?? []).Select(x => x?.GetValue<string>() ?? "").Where(x => x.Length > 0).ToList();
                    if (slugs.Count > 0)
                    {
                        var flat = new Dictionary<string, JsonNode>();
                        foreach (var c in tree)
                        {
                            if (c is not JsonObject co) continue;
                            flat[co.Str("slug")] = c.DeepClone();
                            foreach (var ch in co["children"] as JsonArray ?? [])
                                if (ch is JsonObject cho) flat[cho.Str("slug")] = cho.DeepClone();
                        }
                        data["categories"] = new JsonArray(slugs.Where(flat.ContainsKey).Select(x => flat[x]).ToArray());
                    }
                    else data["categories"] = tree.DeepClone();
                    break;
                }
            }
            outp.Add(data);
        }
        return new JsonObject { ["sections"] = outp, ["categories"] = tree };
    }

    /// <summary>Reference: GET /api/pages/{slug}. Unpublished and unknown pages are 404; built-in defaults always exist.</summary>
    public async Task<JsonObject> PageAsync(string slug)
    {
        var p = await cms.GetPageAsync(slug);
        if (p is null)
        {
            if (!site.DefaultPages.TryGetValue(slug, out var d)) throw new NotFoundException("Page");
            return new JsonObject { ["slug"] = slug, ["title"] = d.Title, ["body"] = d.Body, ["meta_description"] = "", ["updated_at"] = null };
        }
        if (!p.IsPublished) throw new NotFoundException("Page");
        return new JsonObject
        {
            ["slug"] = p.Slug, ["title"] = p.Title, ["body"] = p.Body, ["meta_description"] = p.MetaDescription,
            ["updated_at"] = DateTimeFunctions.Iso(p.UpdatedAt),
        };
    }
}
