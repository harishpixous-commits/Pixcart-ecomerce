using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Utils;

namespace BAL;

/// <summary>Public storefront configuration (reference: routers/storefront.py).</summary>
public class StorefrontBAL(
    ISiteBAL site,
    IPlatformSettingsBAL platform,
    IReviewSettingsBAL reviewSettings,
    ICatalogBAL catalog,
    IRazorpayBAL razorpay,
    SettingsDAL settings,
    CmsDAL cms,
    AppSettings app,
    IEnumerable<IAiAvailability> ai,
    IEnumerable<IDealSync> dealSync) : IStorefrontBAL
{
    private static JsonObject Pick(JsonObject cfg, IEnumerable<string> keys)
    {
        var o = new JsonObject();
        foreach (var k in keys) o[k] = cfg[k]?.DeepClone();
        return o;
    }

    public async Task<JsonObject> SiteAsync()
    {
        var s = await site.GetSiteAsync();
        var cfg = await platform.GetAsync();
        var features = new JsonObject();
        foreach (var (k, v) in cfg.Where(kv => kv.Key.StartsWith("feature_", StringComparison.Ordinal)))
            features[k["feature_".Length..]] = v?.DeepClone();
        // Sellers see AI buttons when AI studio is on and a key is set (or, outside production, in sandbox mode).
        var aiCfg = await settings.GetAsync("ai");
        var aiEnabled = !aiCfg.ContainsKey("enabled") || SettingsJson.Truthy(aiCfg["enabled"]);
        var live = false;
        foreach (var a in ai) live |= await a.ConfiguredAsync("studio");
        features["ai"] = aiEnabled && (live || !app.IsProduction);
        var pdp = new JsonObject();
        foreach (var (k, v) in cfg.Where(kv => kv.Key.StartsWith("pdp_", StringComparison.Ordinal)))
            pdp[k["pdp_".Length..]] = v?.DeepClone();
        pdp["header_pincode"] = cfg["header_pincode"]?.DeepClone();
        pdp["page_loading_bar"] = cfg["page_loading_bar"]?.DeepClone();
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
        outp["reviews"] = reviewSettings.Public(await reviewSettings.GetAsync());
        outp["lists"] = Pick(cfg, PlatformSettingsBAL.ListKeys);
        outp["maintenance"] = new JsonObject { ["on"] = cfg.Bool("maintenance_mode"), ["message"] = cfg.Str("maintenance_message") };
        outp["error_pages"] = Pick(cfg, PlatformSettingsBAL.ErrorPageKeys);
        outp["payment_return"] = cfg.Str("payment_return_mode");
        outp["app"] = new JsonObject
        {
            ["banner"] = cfg.Bool("shop_app_banner"), ["android_apk_url"] = cfg.Str("shop_android_apk_url"), ["play_store_url"] = cfg.Str("shop_play_store_url"),
            ["app_store_url"] = cfg.Str("shop_app_store_url"), ["version"] = cfg.Str("shop_app_version"),
        };
        return outp;
    }

    public async Task<JsonObject> HomeAsync()
    {
        await site.EnsureDefaultSectionsAsync();
        var now = DateTimeFunctions.UtcNow();
        var sections = (await cms.LiveSectionsAsync(now)).ToList();
        var tree = await catalog.CategoryTreeAsync();
        foreach (var s in dealSync) await s.SyncAsync();
        var flat = new Dictionary<string, JsonObject>();
        foreach (var c in tree.OfType<JsonObject>())
        {
            flat[CatalogText.Str(c["slug"])] = c;
            foreach (var ch in (c["children"] as JsonArray ?? []).OfType<JsonObject>()) flat[CatalogText.Str(ch["slug"])] = ch;
        }
        var outp = new JsonArray();
        foreach (var s in sections)
        {
            var config = JsonHelper.Node(s.Config) as JsonObject ?? [];
            var data = new JsonObject { ["id"] = s.Id.ToString(), ["kind"] = s.Kind, ["title"] = s.Title, ["device"] = s.Device, ["config"] = config };
            switch (s.Kind)
            {
                case "products":
                {
                    var products = await catalog.ProductsForAsync(config);
                    if (products.Count == 0) continue;
                    data["products"] = CatalogBAL.Arr(products);
                    break;
                }
                case "deals":
                {
                    var cfg = new JsonObject
                    {
                        ["source"] = "deals_live", ["limit"] = config.TryGetPropertyValue("limit", out var l) ? l?.DeepClone() : 12,
                        ["kind"] = config["kind"]?.DeepClone(),
                    };
                    var products = await catalog.ProductsForAsync(cfg);
                    if (products.Count == 0) continue;
                    data["products"] = CatalogBAL.Arr(products);
                    break;
                }
                case "cards":
                {
                    var cards = new JsonArray();
                    foreach (var card in (config["cards"] as JsonArray ?? []).OfType<JsonObject>())
                    {
                        var copy = (JsonObject)card.DeepClone();
                        if (CatalogText.AsString(copy["mode"]) == "products")
                        {
                            var products = await catalog.ProductsForAsync(new JsonObject
                            {
                                ["source"] = copy.TryGetPropertyValue("source", out var src) ? src?.DeepClone() : "deals", ["limit"] = 4,
                                ["category_slug"] = copy["category_slug"]?.DeepClone(),
                            });
                            if (products.Count == 0) continue;
                            copy["products"] = CatalogBAL.Arr(products);
                        }
                        cards.Add(copy);
                    }
                    if (cards.Count == 0) continue;
                    var newConfig = (JsonObject)config.DeepClone();
                    newConfig["cards"] = cards;
                    data["config"] = newConfig;
                    break;
                }
                case "countdown":
                    if (!CatalogText.TryParseIso(CatalogText.OrEmpty(config["ends_at"]), out var ends, out _) || ends.UtcDateTime <= now) continue;
                    break;
                case "categories":
                {
                    var slugs = (config["slugs"] as JsonArray ?? []).Select(CatalogText.Str).ToList();
                    data["categories"] = slugs.Count > 0
                        ? CatalogBAL.Arr(slugs.Where(flat.ContainsKey).Select(x => flat[x].DeepClone()))
                        : tree.DeepClone();
                    break;
                }
            }
            outp.Add(data);
        }
        return new JsonObject { ["sections"] = outp, ["categories"] = tree };
    }

    public async Task<JsonObject> PageAsync(string slug)
    {
        var p = await cms.GetPageAsync(slug);
        if (p is null)
        {
            if (site.DefaultPages.TryGetValue(slug, out var d))
                return new JsonObject { ["slug"] = slug, ["title"] = d.Title, ["body"] = d.Body, ["meta_description"] = "", ["updated_at"] = null };
            throw new NotFoundException("Page");
        }
        if (!p.IsPublished) throw new NotFoundException("Page");
        return new JsonObject
        {
            ["slug"] = p.Slug, ["title"] = p.Title, ["body"] = p.Body, ["meta_description"] = p.MetaDescription, ["updated_at"] = DateTimeFunctions.Iso(p.UpdatedAt),
        };
    }
}
