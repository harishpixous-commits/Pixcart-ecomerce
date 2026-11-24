using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Configuration;
using Model.Constants;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Storefront customisation (reference: services/cms.py and services/themes.py). Everything here is edited in
/// Admin → Storefront; the storefront reads it through /api/site and /api/home.
/// </summary>
public class SiteBAL(SettingsDAL settings, CmsDAL cms, AppSettings app, IConfiguration config) : ISiteBAL
{
    public const string SiteKey = "site";

    private Cms.Env Env => new(app.AppName, config["App:PlatformLegalName"] ?? "", config["App:PlatformGstin"] ?? "",
        config["App:GrievanceOfficerName"] ?? "", config["App:GrievanceOfficerEmail"] ?? "", config["App:GrievanceOfficerPhone"] ?? "");

    public async Task<JsonObject> GetSiteAsync() => Cms.ReadSite(await settings.GetAsync(SiteKey), Env);

    public async Task<JsonObject> SaveSiteAsync(JsonObject data)
    {
        JsonObject site;
        try
        {
            site = Cms.ValidateSite(data, Env);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_site");
        }
        await settings.SaveAsync(SiteKey, site);
        return site;
    }

    public async Task<JsonObject> SaveThemeAsync(string theme, JsonObject? themeSettings)
    {
        var site = await GetSiteAsync();
        site["theme"] = theme;
        var merged = (site["theme_settings"] as JsonObject)?.DeepClone() as JsonObject ?? [];
        foreach (var (k, v) in themeSettings ?? []) merged[k] = v?.DeepClone();
        site["theme_settings"] = merged;
        JsonObject saved;
        try
        {
            saved = Cms.ValidateSite(site, Env);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_theme");
        }
        await settings.SaveAsync(SiteKey, saved);
        return new JsonObject { ["theme"] = saved["theme"]!.DeepClone(), ["theme_settings"] = saved["theme_settings"]!.DeepClone() };
    }

    public JsonObject PublicBusiness(JsonObject site) => Cms.PublicBusiness(site);

    public JsonObject ValidateSection(string kind, JsonObject? config)
    {
        try
        {
            return Cms.ValidateSection(kind, config);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_section");
        }
    }

    public async Task EnsureDefaultSectionsAsync()
    {
        if (await cms.AnySectionAsync()) return;
        var now = DateTimeFunctions.UtcNow();
        var i = 0;
        foreach (var (kind, title, cfg) in Cms.DefaultSections())
        {
            await cms.InsertSectionAsync(new HomeSectionModel
            {
                Id = Guid.NewGuid(), Kind = kind, Title = title, Config = cfg.ToJsonString(), Position = i * 10, IsActive = true, Device = "all",
                CreatedAt = now.AddTicks(i * 10), UpdatedAt = now,
            });
            i++;
        }
    }

    public JsonObject SectionOut(HomeSectionModel s) => new()
    {
        ["id"] = s.Id.ToString(), ["kind"] = s.Kind, ["kind_label"] = Cms.SectionKinds.TryGetValue(s.Kind, out var l) ? l : s.Kind,
        ["title"] = s.Title, ["config"] = JsonHelper.Node(s.Config), ["position"] = s.Position, ["is_active"] = s.IsActive, ["device"] = s.Device,
        ["starts_at"] = DateTimeFunctions.Iso(s.StartsAt), ["ends_at"] = DateTimeFunctions.Iso(s.EndsAt),
    };

    public IReadOnlyDictionary<string, string> SectionKinds => Cms.SectionKinds;

    public IReadOnlyDictionary<string, (string Title, string Body)> DefaultPages => Cms.DefaultPages;
}

/// <summary>Storefront themes: ids, per-theme presets, colours and layout changes (reference: services/themes.py).</summary>
public static partial class Themes
{
    public static readonly string[] All = ["classic", "bazaar", "fresh", "luxe"];
    public const string Default = "classic";
    public static readonly string[] ColorKeys = ["primary", "primary_dark", "accent", "buy", "success", "page"];

    /// <summary>The owner's changes to a theme's layout (same keys and values as the web app's LAYOUT_CHOICES).</summary>
    public static readonly IReadOnlyDictionary<string, object[]> LayoutChoices = new Dictionary<string, object[]>
    {
        ["container"] = ["boxed", "wide"],
        ["productGrid"] = ["hairline", "cards", "airy"],
        ["gridColumns"] = [4, 5, 6],
        ["categories"] = ["circles", "cards", "squares", "chips"],
        ["sections"] = ["panel", "plain"],
        ["filters"] = ["sidebar", "topbar"],
        ["pdp"] = ["three", "two", "gallery"],
        ["cart"] = ["side", "sticky"],
        ["auth"] = ["card", "split"],
    };

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    internal static partial Regex Hex();

    [GeneratedRegex("^[a-z0-9_-]{1,24}$")]
    private static partial Regex Preset();

    /// <summary>The theme id; an unknown one is refused when saving (strict) and read as the default.</summary>
    public static string CleanTheme(JsonNode? value, bool strict = false)
    {
        var v = CatalogText.OrEmpty(value).Trim().ToLowerInvariant();
        if (All.Contains(v)) return v;
        if (strict) throw new ArgumentException($"Choose one of the themes: {string.Join(", ", All)}");
        return Default;
    }

    /// <summary>Per-theme preset, colour and layout changes. Saving refuses bad values; reading drops them.</summary>
    public static JsonObject CleanSettings(JsonNode? raw, bool strict = false)
    {
        var outp = new JsonObject();
        if (raw is not JsonObject obj) return outp;
        foreach (var (themeId, value) in obj)
        {
            if (!All.Contains(themeId) || value is not JsonObject v) continue;
            var entry = new JsonObject();
            var preset = CatalogText.OrEmpty(CatalogText.Get(v, "preset")).Trim();
            if (preset.Length > 0)
            {
                if (Preset().IsMatch(preset)) entry["preset"] = preset;
                else if (strict) throw new ArgumentException("Choose one of the theme's colour presets");
            }
            var colors = CatalogText.Get(v, "colors") as JsonObject ?? [];
            var clean = new JsonObject();
            foreach (var (k, c) in colors)
            {
                if (!ColorKeys.Contains(k) || c is null || c.GetValueKind() == JsonValueKind.Null || CatalogText.AsString(c) == "") continue;
                var s = CatalogText.Str(c);
                if (Hex().IsMatch(s)) clean[k] = s.ToUpperInvariant();
                else if (strict) throw new ArgumentException($"Colour '{k}' must be a hex value like #0B5563");
            }
            if (clean.Count > 0) entry["colors"] = clean;
            var layout = CleanLayout(CatalogText.Get(v, "layout"), strict);
            if (layout.Count > 0) entry["layout"] = layout;
            if (entry.Count > 0) outp[themeId] = entry;
        }
        return outp;
    }

    /// <summary>Layout changes for one theme: known options with allowed values only (null or "" means the theme's own).</summary>
    public static JsonObject CleanLayout(JsonNode? raw, bool strict = false)
    {
        var outp = new JsonObject();
        if (raw is not JsonObject obj) return outp;
        foreach (var (key, value) in obj)
        {
            if (!LayoutChoices.TryGetValue(key, out var choices) || value is null || value.GetValueKind() == JsonValueKind.Null || CatalogText.AsString(value) == "") continue;
            JsonNode? accepted = null;
            var s = CatalogText.AsString(value);
            if (key == "gridColumns")
            {
                long n = 0;
                var isInt = s != null ? s.All(char.IsAsciiDigit) && long.TryParse(s, out n) : SettingsJson.IsWholeNumber(value, out n);
                if (isInt && choices.Contains((int)n)) accepted = (int)n;
            }
            else if (s != null && choices.Contains(s)) accepted = s;
            if (accepted != null) outp[key] = accepted;
            else if (strict) throw new ArgumentException($"Layout option '{key}' must be one of: {string.Join(", ", choices.Select(c => c.ToString()))}");
        }
        return outp;
    }
}

/// <summary>The site document and home sections: defaults, merging, validation (reference: services/cms.py).</summary>
public static partial class Cms
{
    /// <summary>Values that come from the server's configuration (a fresh install shows them before anyone edits).</summary>
    public sealed record Env(string AppName, string LegalName, string Gstin, string GrievanceName, string GrievanceEmail, string GrievancePhone);

    public static readonly string[] SocialIcons = ["instagram", "facebook", "x", "youtube", "linkedin", "whatsapp", "telegram", "pinterest", "threads", "website", "custom"];
    public static readonly string[] ContactTypes = ["email", "phone", "whatsapp", "address", "link", "text"];
    public const int MaxSocial = 12, MaxContact = 10;

    private static JsonArray Links(params (string Label, string Href)[] links) =>
        new(links.Select(l => (JsonNode)new JsonObject { ["label"] = l.Label, ["href"] = l.Href }).ToArray());

    public static JsonObject DefaultSite(Env env)
    {
        var brand = env.AppName;
        return new JsonObject
        {
            ["brand_name"] = brand,
            ["tagline"] = "Shop from verified sellers across India",
            ["logo_url"] = "",
            ["favicon_url"] = "",
            ["colors"] = new JsonObject { ["primary"] = "#0B5563", ["primary_dark"] = "#073B45", ["accent"] = "#F5A524", ["buy"] = "#D7263D", ["success"] = "#1E8E3E", ["page"] = "#EEF2F4" },
            ["radius"] = "rounded",
            ["theme"] = Themes.Default,
            ["announcement"] = new JsonObject { ["enabled"] = true, ["text"] = "Free delivery on orders over {free_delivery_amount} from a seller", ["link"] = "/search?sort=discount", ["tone"] = "accent" },
            ["header_links"] = Links(("Become a seller", "/sell")),
            ["footer_columns"] = new JsonArray(
                new JsonObject { ["title"] = "Help", ["links"] = Links(("Track your order", "/orders"), ("Returns and refunds", "/pages/returns-policy"), ("Contact us", "/contact"), ("Grievance redressal", "/help/grievance")) },
                new JsonObject { ["title"] = "Policies", ["links"] = Links(("Terms of use", "/pages/terms"), ("Privacy policy", "/pages/privacy"), ("Shipping policy", "/pages/shipping-policy")) },
                new JsonObject { ["title"] = "Sell", ["links"] = Links(("Become a seller", "/sell"), ("Seller dashboard", "/seller")) }),
            ["business"] = new JsonObject
            {
                ["legal_name"] = env.LegalName,
                ["registered_address"] = "",
                ["gstin"] = env.Gstin,
                ["cin"] = "",
                ["grievance"] = new JsonObject
                {
                    ["name"] = env.GrievanceName, ["designation"] = "Grievance Officer", ["email"] = env.GrievanceEmail, ["phone"] = env.GrievancePhone,
                    ["hours"] = "Monday to Saturday, 10 am to 6 pm",
                },
            },
            ["contact"] = new JsonObject { ["enabled"] = true, ["title"] = "Contact us", ["items"] = new JsonArray() },
            ["social"] = new JsonObject { ["enabled"] = true, ["title"] = "Follow us", ["links"] = new JsonArray() },
            ["footer"] = new JsonObject
            {
                ["show_business"] = true, ["show_contact"] = true, ["show_social"] = true, ["show_grievance"] = true, ["show_gstin"] = true,
                ["copyright"] = "© {year} {legal_name}. Products are sold by independent sellers; seller details are shown on every product page.",
            },
            ["nav"] = new JsonObject
            {
                ["all_menu"] = true,
                ["search_categories"] = true,
                ["show_categories"] = true,
                ["links"] = Links(("Today's Deals", "/deals"), ("Bestsellers", "/bestsellers"), ("New Releases", "/new-releases"), ("Coupons", "/coupons"), ("Customer Service", "/help")),
                ["promo"] = new JsonObject { ["enabled"] = false, ["text"] = "", ["link"] = "", ["tone"] = "accent" },
                ["drawer_links"] = Links(("Sell on {brand}", "/sell"), ("Help and support", "/help")),
                ["trending"] = new JsonArray("sarees", "earbuds", "filter coffee", "pressure cooker", "smart watch"),
            },
            ["home_extras"] = new JsonObject { ["back_to_top"] = true, ["signin_prompt"] = true },
            ["seo"] = new JsonObject
            {
                ["title"] = $"{brand} — Shop from trusted Indian sellers",
                ["description"] = "Electronics, fashion, home and everyday essentials from verified sellers across India. Cash on delivery and easy returns.",
            },
            ["analytics"] = new JsonObject { ["google_analytics_id"] = "", ["meta_pixel_id"] = "" },
        };
    }

    [GeneratedRegex(@"^(/(?!/)[A-Za-z0-9\-_/?=&.%#]*|https://[^\s""'<>]+)$")]
    internal static partial Regex SafeHref();

    [GeneratedRegex(@"^https://[A-Za-z0-9.\-]+(:\d+)?(/[^\s""'<>]*)?$")]
    private static partial Regex HttpsUrl();

    [GeneratedRegex(@"^[^@\s<>""']{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,24}$")]
    private static partial Regex Email();

    [GeneratedRegex(@"^\+?[0-9][0-9 \-]{6,18}$")]
    private static partial Regex Phone();

    [GeneratedRegex("^[a-z0-9]{6,16}$")]
    private static partial Regex ItemId();

    [GeneratedRegex("^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$")]
    private static partial Regex Cin();

    [GeneratedRegex(@"\{(?!year\}|legal_name\}|brand\})[^}]*\}")]
    private static partial Regex CopyrightTokens();

    [GeneratedRegex("^G-[A-Z0-9]{4,12}$")]
    private static partial Regex GaId();

    [GeneratedRegex(@"^\d{6,20}$")]
    private static partial Regex PixelId();

    /// <summary>Saved values over the defaults, key by key; nested objects merged; unknown keys dropped.</summary>
    public static JsonObject Merge(JsonObject baseObj, JsonObject? over)
    {
        var outp = (JsonObject)baseObj.DeepClone();
        foreach (var (k, v) in over ?? [])
        {
            if (!baseObj.ContainsKey(k)) continue;
            if (baseObj[k] is JsonObject b && v is JsonObject o) outp[k] = Merge(b, o);
            else outp[k] = v?.DeepClone();
        }
        return outp;
    }

    /// <summary>Converts settings saved by earlier versions (fixed social/contact fields) to the list-based modules.</summary>
    public static JsonObject Upgrade(JsonObject? raw)
    {
        var data = (JsonObject?)raw?.DeepClone() ?? [];
        if (data["social"] is JsonObject social && !social.ContainsKey("links"))
        {
            var links = new JsonArray();
            foreach (var (k, v) in social)
            {
                if (!SettingsJson.Truthy(v)) continue;
                links.Add(new JsonObject
                {
                    ["id"] = CatalogText.TokenHex(), ["icon"] = k, ["label"] = k == "x" ? "X" : Capitalize(k), ["url"] = v!.DeepClone(), ["icon_url"] = "", ["enabled"] = true,
                });
            }
            data["social"] = new JsonObject { ["enabled"] = true, ["title"] = "Follow us", ["links"] = links };
        }
        if (data["contact"] is JsonObject contact && !contact.ContainsKey("items"))
        {
            var items = new JsonArray();
            foreach (var (t, label) in new[] { ("email", "Email"), ("phone", "Phone") })
            {
                if (SettingsJson.Truthy(contact[t]))
                    items.Add(new JsonObject { ["id"] = CatalogText.TokenHex(), ["type"] = t, ["label"] = label, ["value"] = contact[t]!.DeepClone(), ["enabled"] = true });
            }
            data["contact"] = new JsonObject { ["enabled"] = true, ["title"] = "Contact us", ["items"] = items };
            if (SettingsJson.Truthy(contact["address"]))
            {
                if (data["business"] is not JsonObject business)
                {
                    business = [];
                    if (!data.ContainsKey("business")) data["business"] = business;
                    else business = data["business"] as JsonObject ?? business;
                }
                business["registered_address"] = contact["address"]!.DeepClone();
            }
        }
        return data;
    }

    private static string Capitalize(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s[1..].ToLowerInvariant();

    /// <summary>The site as the storefront reads it (cms.get_site).</summary>
    public static JsonObject ReadSite(JsonObject saved, Env env)
    {
        var raw = Upgrade(saved);
        var site = Merge(DefaultSite(env), raw);
        site["theme"] = Themes.CleanTheme(site["theme"]);
        site["theme_settings"] = Themes.CleanSettings(raw["theme_settings"]);
        return site;
    }

    private static JsonArray LinksOf(JsonNode? items, int limit)
    {
        var outp = new JsonArray();
        if (items is not JsonArray arr) return outp;
        foreach (var it in arr.Take(limit))
        {
            if (it is not JsonObject o) continue;
            var label = CatalogText.Cut(CatalogText.Str(o.TryGetPropertyValue("label", out var l) ? l : "").Trim(), 40);
            var href = CatalogText.Cut(CatalogText.Str(o.TryGetPropertyValue("href", out var h) ? h : "").Trim(), 300);
            if (label.Length > 0 && SafeHref().IsMatch(href)) outp.Add(new JsonObject { ["label"] = label, ["href"] = href });
        }
        return outp;
    }

    private static string ItemIdOf(JsonNode? value)
    {
        var v = CatalogText.OrEmpty(value);
        return ItemId().IsMatch(v) ? v : CatalogText.TokenHex();
    }

    private static bool EnabledOf(JsonObject o, string key = "enabled") => !o.TryGetPropertyValue(key, out var v) || SettingsJson.Truthy(v);

    private static JsonObject Social(JsonNode? raw)
    {
        var data = raw as JsonObject ?? [];
        var links = new JsonArray();
        var items = CatalogText.Get(data, "links") as JsonArray ?? [];
        foreach (var it in items.Take(MaxSocial + 1))
        {
            if (it is not JsonObject o) continue;
            var label = CatalogText.PlainText(CatalogText.Get(o, "label"), 40);
            var url = CatalogText.Cut(CatalogText.Str(o.TryGetPropertyValue("url", out var u) ? u : "").Trim(), 300);
            var icon = CatalogText.Str(o.TryGetPropertyValue("icon", out var ic) ? ic : "website");
            var iconUrl = CatalogText.Cut(CatalogText.Str(o.TryGetPropertyValue("icon_url", out var iu) ? iu : "").Trim(), 400);
            if (label.Length == 0) throw new ArgumentException("Every social link needs a name");
            if (!HttpsUrl().IsMatch(url)) throw new ArgumentException($"The link for {label} must be a full address starting with https://");
            if (!SocialIcons.Contains(icon)) throw new ArgumentException($"Choose an icon for {label}");
            if (icon == "custom" && !(iconUrl.Length > 0 && SafeHref().IsMatch(iconUrl)))
                throw new ArgumentException($"Upload an icon image for {label} through the media library");
            links.Add(new JsonObject
            {
                ["id"] = ItemIdOf(CatalogText.Get(o, "id")), ["label"] = label, ["url"] = url, ["icon"] = icon,
                ["icon_url"] = icon == "custom" ? iconUrl : "", ["enabled"] = EnabledOf(o),
            });
        }
        if (links.Count > MaxSocial) throw new ArgumentException($"Add at most {MaxSocial} social links");
        return new JsonObject { ["enabled"] = EnabledOf(data), ["title"] = CatalogText.PlainText(CatalogText.Get(data, "title"), 40), ["links"] = links };
    }

    private static JsonObject Contact(JsonNode? raw)
    {
        var data = raw as JsonObject ?? [];
        var items = new JsonArray();
        var list = CatalogText.Get(data, "items") as JsonArray ?? [];
        foreach (var it in list.Take(MaxContact + 1))
        {
            if (it is not JsonObject o) continue;
            var kind = CatalogText.Str(o.TryGetPropertyValue("type", out var t) ? t : "");
            var label = CatalogText.PlainText(CatalogText.Get(o, "label"), 40);
            var value = CatalogText.PlainText(CatalogText.Get(o, "value"), 300);
            if (!ContactTypes.Contains(kind)) throw new ArgumentException("Choose what kind of contact detail this is");
            if (label.Length == 0 || value.Length == 0) throw new ArgumentException("Every contact detail needs a label and a value");
            if (kind == "email" && !Email().IsMatch(value)) throw new ArgumentException($"{label}: enter a valid email address");
            if (kind is "phone" or "whatsapp" && !Phone().IsMatch(value)) throw new ArgumentException($"{label}: enter a phone number with digits only, e.g. +91 98765 43210");
            if (kind == "link" && !SafeHref().IsMatch(value)) throw new ArgumentException($"{label}: links must start with / or https://");
            items.Add(new JsonObject { ["id"] = ItemIdOf(CatalogText.Get(o, "id")), ["type"] = kind, ["label"] = label, ["value"] = value, ["enabled"] = EnabledOf(o) });
        }
        if (items.Count > MaxContact) throw new ArgumentException($"Add at most {MaxContact} contact details");
        return new JsonObject { ["enabled"] = EnabledOf(data), ["title"] = CatalogText.PlainText(CatalogText.Get(data, "title"), 40), ["items"] = items };
    }

    private static JsonObject Business(JsonObject data)
    {
        var g = CatalogText.Get(data, "grievance") as JsonObject ?? [];
        var gstin = CatalogText.OrEmpty(CatalogText.Get(data, "gstin")).Trim().ToUpperInvariant();
        var cin = CatalogText.OrEmpty(CatalogText.Get(data, "cin")).Trim().ToUpperInvariant();
        var email = CatalogText.Cut(CatalogText.OrEmpty(CatalogText.Get(g, "email")).Trim(), 254);
        var phone = CatalogText.PlainText(CatalogText.Get(g, "phone"), 20);
        if (gstin.Length > 0) gstin = IndianStates.ValidateGstin(gstin);
        if (cin.Length > 0 && !Cin().IsMatch(cin)) throw new ArgumentException("CIN looks like U12345TN2024PTC123456");
        if (email.Length > 0 && !Email().IsMatch(email)) throw new ArgumentException("Enter a valid grievance officer email");
        if (phone.Length > 0 && !Phone().IsMatch(phone)) throw new ArgumentException("Enter a valid grievance officer phone number");
        return new JsonObject
        {
            ["legal_name"] = CatalogText.PlainText(CatalogText.Get(data, "legal_name"), 120),
            ["registered_address"] = CatalogText.PlainText(CatalogText.Get(data, "registered_address"), 400),
            ["gstin"] = gstin,
            ["cin"] = cin,
            ["grievance"] = new JsonObject
            {
                ["name"] = CatalogText.PlainText(CatalogText.Get(g, "name"), 80), ["designation"] = CatalogText.PlainText(CatalogText.Get(g, "designation"), 60),
                ["email"] = email, ["phone"] = phone, ["hours"] = CatalogText.PlainText(CatalogText.Get(g, "hours"), 80),
            },
        };
    }

    /// <summary>The whole site document checked and cleaned (cms.validate_site); ArgumentException with the reference message.</summary>
    public static JsonObject ValidateSite(JsonObject data, Env env)
    {
        var raw = Upgrade(data);
        var site = Merge(DefaultSite(env), raw);
        if (site["colors"] is JsonObject colors)
        {
            foreach (var (k, v) in colors)
                if (!Themes.Hex().IsMatch(CatalogText.Str(v))) throw new ArgumentException($"Colour '{k}' must be a hex value like #0B5563");
        }
        if (CatalogText.AsString(site["radius"]) is not ("rounded" or "soft" or "square"))
            throw new ArgumentException("Corner style must be rounded, soft or square");
        site["theme"] = Themes.CleanTheme(site["theme"], strict: true);
        site["theme_settings"] = Themes.CleanSettings(raw["theme_settings"], strict: true);
        foreach (var k in new[] { "logo_url", "favicon_url" })
        {
            if (SettingsJson.Truthy(site[k]) && !SafeHref().IsMatch(CatalogText.Str(site[k]))) throw new ArgumentException("Upload the logo through the media library");
        }
        var brandName = CatalogText.PlainText(site["brand_name"], 40);
        site["brand_name"] = brandName.Length > 0 ? brandName : env.AppName;
        site["tagline"] = CatalogText.PlainText(site["tagline"], 120);
        site["header_links"] = LinksOf(site["header_links"], 6);
        var columns = new JsonArray();
        foreach (var c in (site["footer_columns"] as JsonArray ?? []).Take(5))
        {
            var co = c as JsonObject ?? [];
            columns.Add(new JsonObject { ["title"] = CatalogText.PlainText(CatalogText.Get(co, "title"), 40), ["links"] = LinksOf(CatalogText.Get(co, "links"), 10) });
        }
        site["footer_columns"] = columns;
        var a = site["announcement"] as JsonObject ?? [];
        if (SettingsJson.Truthy(CatalogText.Get(a, "link")) && !SafeHref().IsMatch(CatalogText.Str(a["link"])))
            throw new ArgumentException("Announcement link must start with / or https://");
        a["enabled"] = SettingsJson.Truthy(CatalogText.Get(a, "enabled"));
        a["text"] = CatalogText.PlainText(CatalogText.Get(a, "text"), 160);
        if (CatalogText.AsString(CatalogText.Get(a, "tone")) is not ("accent" or "primary" or "dark")) a["tone"] = "accent";
        site["announcement"] = a.Parent == null ? a : a.DeepClone();
        site["business"] = Business(site["business"] as JsonObject ?? []);
        site["contact"] = Contact(site["contact"]);
        site["social"] = Social(site["social"]);
        var f = site["footer"] as JsonObject ?? [];
        var copyright = CatalogText.PlainText(CatalogText.Get(f, "copyright"), 240);
        if (CopyrightTokens().IsMatch(copyright)) throw new ArgumentException("The copyright line can use {year}, {legal_name} and {brand} only");
        var footer = new JsonObject();
        foreach (var k in new[] { "show_business", "show_contact", "show_social", "show_grievance", "show_gstin" }) footer[k] = EnabledOf(f, k);
        footer["copyright"] = copyright;
        site["footer"] = footer;
        var analytics = site["analytics"] as JsonObject ?? [];
        var ga = CatalogText.Get(analytics, "google_analytics_id");
        if (SettingsJson.Truthy(ga) && !GaId().IsMatch(CatalogText.Str(ga))) throw new ArgumentException("Google Analytics ID looks like G-XXXXXXX");
        var px = CatalogText.Get(analytics, "meta_pixel_id");
        if (SettingsJson.Truthy(px) && !PixelId().IsMatch(CatalogText.Str(px))) throw new ArgumentException("Meta Pixel ID is a number");
        var seo = site["seo"] as JsonObject ?? [];
        site["seo"] = new JsonObject { ["title"] = CatalogText.PlainText(CatalogText.Get(seo, "title"), 70), ["description"] = CatalogText.PlainText(CatalogText.Get(seo, "description"), 170) };
        var n = site["nav"] as JsonObject ?? [];
        var promo = CatalogText.Get(n, "promo") as JsonObject ?? [];
        if (SettingsJson.Truthy(CatalogText.Get(promo, "link")) && !SafeHref().IsMatch(CatalogText.Str(promo["link"])))
            throw new ArgumentException("The promotion link must start with / or https://");
        var promoTone = CatalogText.AsString(CatalogText.Get(promo, "tone"));
        var trending = new JsonArray();
        foreach (var x in (CatalogText.Get(n, "trending") as JsonArray ?? []).Take(10))
        {
            var t = CatalogText.PlainText(x, 40);
            if (t.Length > 0) trending.Add(t);
        }
        site["nav"] = new JsonObject
        {
            ["all_menu"] = EnabledOf(n, "all_menu"), ["search_categories"] = EnabledOf(n, "search_categories"), ["show_categories"] = EnabledOf(n, "show_categories"),
            ["links"] = LinksOf(CatalogText.Get(n, "links"), 12),
            ["promo"] = new JsonObject
            {
                ["enabled"] = SettingsJson.Truthy(CatalogText.Get(promo, "enabled")), ["text"] = CatalogText.PlainText(CatalogText.Get(promo, "text"), 60),
                ["link"] = CatalogText.Cut(CatalogText.OrEmpty(CatalogText.Get(promo, "link")), 300),
                ["tone"] = promoTone is "accent" or "buy" or "primary" or "dark" ? promoTone : "accent",
            },
            ["drawer_links"] = LinksOf(CatalogText.Get(n, "drawer_links"), 10),
            ["trending"] = trending,
        };
        var h = site["home_extras"] as JsonObject ?? [];
        site["home_extras"] = new JsonObject { ["back_to_top"] = EnabledOf(h, "back_to_top"), ["signin_prompt"] = EnabledOf(h, "signin_prompt") };
        return site;
    }

    /// <summary>The operator details other modules need (invoices, emails, grievance page, structured data).</summary>
    public static JsonObject PublicBusiness(JsonObject site)
    {
        var b = site["business"] as JsonObject ?? [];
        var items = (site["contact"] as JsonObject)?["items"] as JsonArray ?? [];
        string First(string type) => items.OfType<JsonObject>()
            .Where(i => CatalogText.AsString(i["type"]) == type && SettingsJson.Truthy(i["enabled"]))
            .Select(i => CatalogText.Str(i["value"])).FirstOrDefault() ?? "";
        var legal = CatalogText.OrEmpty(b["legal_name"]);
        return new JsonObject
        {
            ["brand"] = site["brand_name"]?.DeepClone(),
            ["legal_name"] = legal.Length > 0 ? legal : site["brand_name"]?.DeepClone(),
            ["gstin"] = b["gstin"]?.DeepClone(), ["cin"] = b["cin"]?.DeepClone(), ["registered_address"] = b["registered_address"]?.DeepClone(),
            ["grievance"] = b["grievance"]?.DeepClone(),
            ["support_email"] = First("email"),
            ["support_phone"] = First("phone"),
        };
    }

    // ------------------------------------------------------------------------- home sections

    public static readonly IReadOnlyDictionary<string, string> SectionKinds = new Dictionary<string, string>
    {
        ["hero"] = "Hero slides", ["categories"] = "Categories", ["products"] = "Product row", ["banner"] = "Single banner",
        ["banner_grid"] = "Banner grid", ["media"] = "Image or video block", ["text"] = "Text block", ["usp"] = "Promise strip",
        ["recent"] = "Recently viewed", ["cards"] = "Card row (up to 4 cards)", ["deals"] = "Today's deals with timers",
        ["sponsored"] = "Sponsored products", ["countdown"] = "Countdown banner", ["signin"] = "Sign-in prompt (visitors only)",
        ["inspired"] = "Inspired by your browsing history", ["buy_again"] = "Buy it again (signed-in shoppers)",
    };

    public static readonly string[] ProductSources = ["deals", "deals_live", "bestsellers", "new", "top_rated", "category", "manual"];
    public static readonly string[] CardModes = ["tiles", "products", "recent", "buy_again"];
    public static readonly string[] Tones = ["accent", "primary", "dark", "buy"];
    /// <summary>"auto" follows the theme's own category style; "tiles" (older versions) means "auto".</summary>
    public static readonly string[] CategoryStyles = ["auto", "circles", "cards", "squares", "chips"];
    public static readonly string[] MediaAspects = ["21/9", "16/9", "4/3", "1/1", "4/5"];

    [GeneratedRegex(@"\.(mp4|webm)$", RegexOptions.IgnoreCase)]
    private static partial Regex VideoFile();

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9+.-]*:")]
    private static partial Regex Scheme();

    /// <summary>The path of an address like Python's urlsplit(url).path; null when the address is malformed.</summary>
    private static string? UrlPath(string url)
    {
        var rest = url;
        var m = Scheme().Match(rest);
        if (m.Success) rest = rest[m.Length..];
        var cut = rest.IndexOfAny(['#']);
        if (cut >= 0) rest = rest[..cut];
        cut = rest.IndexOf('?');
        if (cut >= 0) rest = rest[..cut];
        if (rest.StartsWith("//", StringComparison.Ordinal))
        {
            rest = rest[2..];
            var slash = rest.IndexOf('/');
            var netloc = slash >= 0 ? rest[..slash] : rest;
            if (netloc.Contains('[') != netloc.Contains(']')) return null;
            rest = slash >= 0 ? rest[slash..] : "";
        }
        return rest;
    }

    /// <summary>True for an MP4 or WebM file (by the extension of the address's path, ignoring any ?query or #fragment).</summary>
    public static bool IsVideoUrl(string? url)
    {
        var path = UrlPath(url ?? "");
        return path != null && VideoFile().IsMatch(path);
    }

    private static string VideoUrl(JsonNode? value)
    {
        var v = CatalogText.OrEmpty(value).Trim();
        if (v.Length > 0 && (v.Length > 400 || !SafeHref().IsMatch(v) || !IsVideoUrl(v)))
            throw new ArgumentException("Videos must be uploaded through the media library");
        return v;
    }

    private static string LinkOnly(JsonNode? value)
    {
        var v = CatalogText.Cut(CatalogText.OrEmpty(value), 300);
        if (v.Length > 0 && !SafeHref().IsMatch(v)) throw new ArgumentException("Links must start with / or https://");
        return v;
    }

    private static string ImageOnly(JsonNode? value)
    {
        var v = CatalogText.Cut(CatalogText.OrEmpty(value), 400);
        if (v.Length > 0 && !SafeHref().IsMatch(v)) throw new ArgumentException("Images must be uploaded through the media library");
        return v;
    }

    private static string StrGet(JsonObject o, string key, string dflt = "") =>
        CatalogText.Str(o.TryGetPropertyValue(key, out var v) ? v : dflt);

    private static JsonObject ImgLink(JsonObject x)
    {
        var img = CatalogText.Cut(StrGet(x, "image"), 400);
        var link = CatalogText.Cut(StrGet(x, "link"), 300);
        if (img.Length > 0 && !SafeHref().IsMatch(img)) throw new ArgumentException("Images must be uploaded through the media library");
        if (link.Length > 0 && !SafeHref().IsMatch(link)) throw new ArgumentException("Links must start with / or https://");
        return new JsonObject
        {
            ["image"] = img, ["video"] = VideoUrl(CatalogText.Get(x, "video")), ["link"] = link, ["heading"] = CatalogText.Cut(StrGet(x, "heading"), 80),
            ["text"] = CatalogText.Cut(StrGet(x, "text"), 160), ["cta"] = CatalogText.Cut(StrGet(x, "cta"), 30),
        };
    }

    private static bool Is(JsonNode? n, string value) => CatalogText.AsString(n) == value;

    private static long Clamp(long v, long lo, long hi) => Math.Max(lo, Math.Min(hi, v));

    private static IEnumerable<JsonObject> Objects(JsonNode? n, int take = int.MaxValue) =>
        (n as JsonArray ?? []).Take(take).Select(x => x as JsonObject ?? throw new ArgumentException("'str' object has no attribute 'get'"));

    /// <summary>A home section's settings checked and cleaned for its kind (cms.validate_section).</summary>
    public static JsonObject ValidateSection(string kind, JsonObject? config)
    {
        if (!SectionKinds.ContainsKey(kind)) throw new ArgumentException("Unknown section type");
        var c = config ?? [];
        switch (kind)
        {
            case "hero":
            {
                var slides = new JsonArray();
                foreach (var raw in Objects(CatalogText.Get(c, "slides"), 8))
                {
                    var sl = ImgLink(raw);
                    sl["image_mobile"] = ImageOnly(CatalogText.Get(raw, "image_mobile"));
                    sl["offer"] = CatalogText.PlainText(CatalogText.Get(raw, "offer"), 80);
                    sl["note"] = CatalogText.PlainText(CatalogText.Get(raw, "note"), 60);
                    sl["theme"] = Is(CatalogText.Get(raw, "theme"), "dark") ? "dark" : "light";
                    sl["align"] = Is(CatalogText.Get(raw, "align"), "center") ? "center" : "left";
                    slides.Add(sl);
                }
                if (slides.Count == 0) throw new ArgumentException("Add at least one slide");
                var interval = c.ContainsKey("interval") ? c["interval"] : 5;
                return new JsonObject
                {
                    ["slides"] = slides,
                    ["autoplay"] = !c.ContainsKey("autoplay") || SettingsJson.Truthy(c["autoplay"]),
                    ["interval"] = Clamp(SettingsJson.Truthy(interval) ? CatalogText.PyInt(interval) : 5, 3, 10),
                    ["style"] = Is(CatalogText.Get(c, "style"), "fade") ? "fade" : "boxed",
                };
            }
            case "cards":
            {
                var cards = new JsonArray();
                foreach (var raw in Objects(CatalogText.Get(c, "cards"), 4))
                {
                    var modeRaw = CatalogText.AsString(CatalogText.Get(raw, "mode"));
                    var mode = modeRaw != null && CardModes.Contains(modeRaw) ? modeRaw : "tiles";
                    var title = CatalogText.PlainText(CatalogText.Get(raw, "title"), 60);
                    var linkText = CatalogText.PlainText(CatalogText.Get(raw, "link_text"), 30);
                    var card = new JsonObject
                    {
                        ["title"] = title, ["link"] = LinkOnly(CatalogText.Get(raw, "link")), ["link_text"] = linkText.Length > 0 ? linkText : "See more", ["mode"] = mode,
                    };
                    if (title.Length == 0) throw new ArgumentException("Every card needs a title");
                    if (mode == "tiles")
                    {
                        var tiles = new JsonArray();
                        foreach (var t in Objects(CatalogText.Get(raw, "tiles"), 4))
                        {
                            tiles.Add(new JsonObject
                            {
                                ["image"] = ImageOnly(CatalogText.Get(t, "image")), ["video"] = VideoUrl(CatalogText.Get(t, "video")),
                                ["label"] = CatalogText.PlainText(CatalogText.Get(t, "label"), 30), ["link"] = LinkOnly(CatalogText.Get(t, "link")),
                                ["badge"] = CatalogText.PlainText(CatalogText.Get(t, "badge"), 20),
                            });
                        }
                        if (tiles.Count == 0) throw new ArgumentException($"Add 1 to 4 tiles to '{title}'");
                        card["tiles"] = tiles;
                    }
                    else if (mode == "products")
                    {
                        var src = raw.ContainsKey("source") ? raw["source"] : "deals";
                        var srcText = CatalogText.AsString(src);
                        if (srcText is not ("deals" or "deals_live" or "bestsellers" or "new" or "top_rated" or "category"))
                            throw new ArgumentException("Choose where the card's products come from");
                        card["source"] = srcText;
                        if (srcText == "category")
                        {
                            var slug = CatalogText.Cut(StrGet(raw, "category_slug"), 90);
                            card["category_slug"] = slug;
                            if (slug.Length == 0) throw new ArgumentException($"Choose a category for '{title}'");
                        }
                    }
                    cards.Add(card);
                }
                if (cards.Count == 0) throw new ArgumentException("Add at least one card");
                return new JsonObject { ["cards"] = cards };
            }
            case "deals":
            {
                var k = CatalogText.AsString(CatalogText.Get(c, "kind"));
                var limit = c.ContainsKey("limit") ? c["limit"] : 12;
                return new JsonObject
                {
                    ["limit"] = Clamp(SettingsJson.Truthy(limit) ? CatalogText.PyInt(limit) : 12, 4, 24),
                    ["kind"] = k is "lightning" or "deal_of_day" or "limited" ? k : "",
                };
            }
            case "sponsored" or "inspired" or "buy_again":
            {
                var limit = c.ContainsKey("limit") ? c["limit"] : 10;
                return new JsonObject { ["limit"] = Clamp(SettingsJson.Truthy(limit) ? CatalogText.PyInt(limit) : 10, 4, 20) };
            }
            case "signin":
            {
                var heading = CatalogText.PlainText(CatalogText.Get(c, "heading"), 80);
                return new JsonObject
                {
                    ["heading"] = heading.Length > 0 ? heading : "See personalised recommendations", ["text"] = CatalogText.PlainText(CatalogText.Get(c, "text"), 160),
                };
            }
            case "countdown":
            {
                var text = c.ContainsKey("ends_at") ? CatalogText.Str(c["ends_at"]) : "";
                if (!CatalogText.TryParseIso(text, out var ends, out var aware)) throw new ArgumentException("Choose when the countdown ends");
                if (!aware) ends = new DateTimeOffset(ends.DateTime, TimeSpan.FromMinutes(330));
                var tone = CatalogText.AsString(CatalogText.Get(c, "tone"));
                return new JsonObject
                {
                    ["heading"] = CatalogText.PlainText(CatalogText.Get(c, "heading"), 80), ["text"] = CatalogText.PlainText(CatalogText.Get(c, "text"), 160),
                    ["ends_at"] = CatalogText.PyIso(ends), ["link"] = LinkOnly(CatalogText.Get(c, "link")), ["cta"] = CatalogText.PlainText(CatalogText.Get(c, "cta"), 30),
                    ["image"] = ImageOnly(CatalogText.Get(c, "image")), ["tone"] = tone != null && Tones.Contains(tone) ? tone : "buy",
                };
            }
            case "banner":
                return ImgLink(c);
            case "banner_grid":
            {
                var items = new JsonArray(Objects(CatalogText.Get(c, "items")).Select(s => (JsonNode)ImgLink(s)).Take(4).ToArray());
                if (items.Count < 2) throw new ArgumentException("A banner grid needs 2 to 4 banners");
                return new JsonObject { ["items"] = items };
            }
            case "products":
            {
                var source = c.ContainsKey("source") ? c["source"] : "deals";
                var sourceText = CatalogText.AsString(source);
                if (sourceText == null || !ProductSources.Contains(sourceText)) throw new ArgumentException("Choose where the products come from");
                var outp = new JsonObject
                {
                    ["source"] = sourceText,
                    ["limit"] = Clamp(CatalogText.PyInt(c.ContainsKey("limit") ? c["limit"] : 12), 4, 24),
                    ["layout"] = Is(CatalogText.Get(c, "layout"), "grid") ? "grid" : "row",
                    ["show_add"] = SettingsJson.Truthy(CatalogText.Get(c, "show_add")),
                    ["ranked"] = SettingsJson.Truthy(CatalogText.Get(c, "ranked")),
                    ["see_all"] = LinkOnly(CatalogText.Get(c, "see_all")),
                };
                if (sourceText == "category")
                {
                    var slug = CatalogText.Cut(StrGet(c, "category_slug"), 90);
                    outp["category_slug"] = slug;
                    if (slug.Length == 0) throw new ArgumentException("Choose a category");
                }
                if (sourceText == "manual")
                    outp["product_ids"] = new JsonArray((CatalogText.Get(c, "product_ids") as JsonArray ?? []).Select(x => (JsonNode)CatalogText.Str(x)).Take(24).ToArray());
                return outp;
            }
            case "categories":
            {
                var style = CatalogText.AsString(CatalogText.Get(c, "style"));
                return new JsonObject
                {
                    ["slugs"] = new JsonArray((CatalogText.Get(c, "slugs") as JsonArray ?? []).Select(x => (JsonNode)CatalogText.Cut(CatalogText.Str(x), 90)).Take(16).ToArray()),
                    ["style"] = style != null && CategoryStyles.Contains(style) ? style : "auto",
                };
            }
            case "media":
            {
                var image = ImageOnly(CatalogText.Get(c, "image"));
                var video = VideoUrl(CatalogText.Get(c, "video"));
                if (image.Length == 0 && video.Length == 0) throw new ArgumentException("Add an image or a video");
                var aspect = CatalogText.AsString(CatalogText.Get(c, "aspect"));
                return new JsonObject
                {
                    ["image"] = image, ["video"] = video, ["link"] = LinkOnly(CatalogText.Get(c, "link")),
                    ["heading"] = CatalogText.PlainText(CatalogText.Get(c, "heading"), 80), ["text"] = CatalogText.PlainText(CatalogText.Get(c, "text"), 160),
                    ["cta"] = CatalogText.PlainText(CatalogText.Get(c, "cta"), 30),
                    ["align"] = Is(CatalogText.Get(c, "align"), "center") ? "center" : "left",
                    ["tone"] = Is(CatalogText.Get(c, "tone"), "dark") ? "dark" : "light",
                    ["aspect"] = aspect != null && MediaAspects.Contains(aspect) ? aspect : "16/9",
                    ["width"] = Is(CatalogText.Get(c, "width"), "full") ? "full" : "contained",
                    ["controls"] = CatalogText.Get(c, "controls")?.GetValueKind() == JsonValueKind.True && video.Length > 0,
                };
            }
            case "text":
                return new JsonObject
                {
                    ["markdown"] = CatalogText.Cut(StrGet(c, "markdown"), 8000), ["align"] = Is(CatalogText.Get(c, "align"), "center") ? "center" : "left",
                };
            case "usp":
                return new JsonObject
                {
                    ["items"] = new JsonArray(Objects(CatalogText.Get(c, "items")).Select(i => (JsonNode)new JsonObject
                    {
                        ["icon"] = CatalogText.Cut(StrGet(i, "icon", "check"), 20), ["text"] = CatalogText.Cut(StrGet(i, "text"), 80),
                    }).Take(6).ToArray()),
                };
            default:
                return [];
        }
    }

    /// <summary>The starting home page (kind, title, settings), added when a store has no sections.</summary>
    public static IEnumerable<(string Kind, string Title, JsonObject Config)> DefaultSections()
    {
        JsonObject Card(string title, string link, string linkText, string mode, string? source = null)
        {
            var o = new JsonObject { ["title"] = title, ["link"] = link, ["link_text"] = linkText, ["mode"] = mode };
            if (source != null) o["source"] = source;
            return o;
        }
        JsonObject Row(string source, int limit, string layout) => new() { ["source"] = source, ["limit"] = limit, ["layout"] = layout };
        yield return ("cards", "", new JsonObject
        {
            ["cards"] = new JsonArray(
                Card("Keep shopping for", "", "View your browsing history", "recent"),
                Card("Today's top deals", "/deals", "See all deals", "products", "deals"),
                Card("Bestsellers", "/bestsellers", "See more", "products", "bestsellers"),
                Card("New on the store", "/new-releases", "Explore", "products", "new")),
        });
        yield return ("categories", "Shop by category", new JsonObject { ["slugs"] = new JsonArray(), ["style"] = "auto" });
        yield return ("deals", "Today's deals", new JsonObject { ["limit"] = 12, ["kind"] = "" });
        yield return ("products", "Deals of the day", Row("deals", 12, "row"));
        yield return ("usp", "", new JsonObject
        {
            ["items"] = new JsonArray(
                new JsonObject { ["icon"] = "badge", ["text"] = "Every seller is KYC-verified" },
                new JsonObject { ["icon"] = "wallet", ["text"] = "Cash on delivery available" },
                new JsonObject { ["icon"] = "truck", ["text"] = "Free delivery over {free_delivery_amount} per seller" },
                new JsonObject { ["icon"] = "return", ["text"] = "Easy returns" }),
        });
        yield return ("products", "Bestsellers", Row("bestsellers", 12, "row"));
        yield return ("recent", "Recently viewed", new JsonObject());
        yield return ("products", "Top rated", Row("top_rated", 12, "row"));
        yield return ("sponsored", "Sponsored products", new JsonObject { ["limit"] = 10 });
        yield return ("inspired", "Inspired by your browsing history", new JsonObject { ["limit"] = 12 });
        yield return ("products", "New arrivals", Row("new", 10, "grid"));
        yield return ("signin", "", new JsonObject { ["heading"] = "See personalised recommendations", ["text"] = "" });
    }

    public static readonly IReadOnlyDictionary<string, (string Title, string Body)> DefaultPages = new Dictionary<string, (string, string)>
    {
        ["terms"] = ("Terms of use", "These terms are a placeholder. Ask your lawyer to write the terms of use for your marketplace and paste them here from Admin → Storefront → Pages."),
        ["privacy"] = ("Privacy policy", "This privacy notice is a placeholder. Under the Digital Personal Data Protection Act, 2023 your notice must list the personal data you collect, why, how a person can withdraw consent or ask for erasure, and your grievance contact. Replace this text from Admin → Storefront → Pages."),
        ["returns-policy"] = ("Returns and refunds", "Every product page shows its return window, which starts on the delivery day.\n\n## Cancelling before shipping\nOpen the order and choose **Cancel this package**. Online payments are refunded at once to the original method (5 to 7 working days).\n\n## Returns after delivery\nOpen the order and choose **Return items** while the window is open. Once the seller receives the item, we refund you. Cash-on-delivery refunds are sent to the UPI ID you give us."),
        ["shipping-policy"] = ("Shipping policy", "Sellers ship from their own warehouses. Delivery time is shown on each product page for your PIN code. Delivery is free when a seller's items in your order reach the free-delivery amount."),
        ["about"] = ("About us", "Tell your customers who you are. Edit this page from Admin → Storefront → Pages."),
    };
}
