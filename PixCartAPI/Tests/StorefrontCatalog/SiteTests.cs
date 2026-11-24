using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace Tests.StorefrontCatalog;

/// <summary>
/// Reference: tests/test_themes.py, test_list_settings.py, test_maintenance.py, test_gallery.py (storefront side) and
/// test_home_media.py: /api/site, /api/home and the settings behind them.
/// </summary>
public class SiteTests(CatalogFactory factory) : CatalogTestBase(factory)
{
    private Task<JsonObject> SaveTheme(string theme, string? settings = null) =>
        With<ISiteBAL, JsonObject>(s => s.SaveThemeAsync(theme, settings == null ? null : JsonNode.Parse(settings)!.AsObject()));

    private Task<JsonObject> SaveSite(string json) => With<ISiteBAL, JsonObject>(s => s.SaveSiteAsync(JsonNode.Parse(json)!.AsObject()));

    private async Task<JsonObject> Site() => (await Visitor.Get("/api/site")).Body!.AsObject();

    // ------------------------------------------------------------------------- themes

    [Fact]
    public async Task Default_theme_is_classic()
    {
        var site = await Site();
        Assert.Equal("classic", site["theme"]!.GetValue<string>());
        Assert.Empty(site["theme_settings"]!.AsObject());
        Assert.Equal("PixCart", site["brand_name"]!.GetValue<string>());
        Assert.True(site["features"]!["qa"]!.GetValue<bool>());
        Assert.True(site["features"]!["ai"]!.GetValue<bool>()); // outside production: sandbox
        Assert.True(site["online_payments"]!.GetValue<bool>());
        Assert.Equal("return", site["payment_return"]!.GetValue<string>());
        Assert.Equal(2.5, site["gallery"]!["zoom_level"]!.GetValue<double>());
    }

    [Fact]
    public async Task Switch_theme_with_preset_and_colours()
    {
        var r = await SaveTheme("bazaar", """{"bazaar": {"preset": "crimson", "colors": {"primary": "#9b1b30", "page": "#F7F1F2", "evil": "#000000"}}}""");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"theme": "bazaar", "theme_settings": {"bazaar": {"preset": "crimson", "colors": {"primary": "#9B1B30", "page": "#F7F1F2"}}}}"""), r));
        var site = await Site();
        Assert.Equal("bazaar", site["theme"]!.GetValue<string>());
        Assert.Equal("crimson", site["theme_settings"]!["bazaar"]!["preset"]!.GetValue<string>());
        // another theme's settings are added without losing Bazaar's
        await SaveTheme("luxe", """{"luxe": {"preset": "emerald"}}""");
        var settings = (await Site())["theme_settings"]!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"preset": "emerald"}"""), settings["luxe"]));
        Assert.Equal("crimson", settings["bazaar"]!["preset"]!.GetValue<string>());
        // switching back keeps every theme's settings for next time
        await SaveTheme("classic");
        site = await Site();
        Assert.Equal("classic", site["theme"]!.GetValue<string>());
        Assert.Equal(new HashSet<string> { "bazaar", "luxe" }, site["theme_settings"]!.AsObject().Select(kv => kv.Key).ToHashSet());
    }

    [Fact]
    public async Task Theme_values_are_validated()
    {
        async Task Bad(string theme, string? settings = null) =>
            Assert.Equal("invalid_theme", (await Assert.ThrowsAsync<AppException>(() => SaveTheme(theme, settings))).Code);
        await Bad("neon");
        await Bad("fresh", """{"fresh": {"colors": {"primary": "green"}}}""");
        await Bad("fresh", """{"fresh": {"colors": {"accent": "#FFF"}}}""");
        await Bad("fresh", """{"fresh": {"preset": "<script>"}}""");
        // unknown themes in the settings are dropped, not stored
        var r = await SaveTheme("fresh", """{"neon": {"preset": "x"}, "fresh": {"preset": "berry"}}""");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"fresh": {"preset": "berry"}}"""), r["theme_settings"]));
    }

    [Fact]
    public async Task Theme_change_keeps_other_site_settings()
    {
        await SaveSite("""{"brand_name": "Kadai", "colors": {"primary": "#123456"}}""");
        await SaveTheme("fresh");
        var site = await Site();
        Assert.Equal("Kadai", site["brand_name"]!.GetValue<string>());
        Assert.Equal("#123456", site["colors"]!["primary"]!.GetValue<string>());
        Assert.Equal("fresh", site["theme"]!.GetValue<string>());
        // saving the whole site (other tabs) keeps the theme and its settings
        await SaveTheme("fresh", """{"fresh": {"preset": "citrus"}}""");
        var full = await With<ISiteBAL, JsonObject>(s => s.GetSiteAsync());
        full["tagline"] = "Fresh every day";
        await With<ISiteBAL, JsonObject>(s => s.SaveSiteAsync(full));
        site = await Site();
        Assert.Equal("Fresh every day", site["tagline"]!.GetValue<string>());
        Assert.Equal("fresh", site["theme"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"fresh": {"preset": "citrus"}}"""), site["theme_settings"]));
    }

    [Fact]
    public async Task Layout_changes_per_theme()
    {
        var r = await SaveTheme("classic", """{"classic": {"layout": {"productGrid": "cards", "gridColumns": "4", "pdp": "gallery", "filters": "", "evil": "x"}}}""");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"layout": {"productGrid": "cards", "gridColumns": 4, "pdp": "gallery"}}"""), r["theme_settings"]!["classic"]));
        Assert.Equal("gallery", (await Site())["theme_settings"]!["classic"]!["layout"]!["pdp"]!.GetValue<string>());
        foreach (var bad in new[] { """{"productGrid": "masonry"}""", """{"gridColumns": 7}""", """{"gridColumns": true}""", """{"cart": "<script>"}""" })
            await Assert.ThrowsAsync<AppException>(() => SaveTheme("classic", "{\"classic\": {\"layout\": " + bad + "}}"));
        // an empty layout goes back to the theme's own
        r = await SaveTheme("classic", """{"classic": {"layout": {}}}""");
        Assert.False(r["theme_settings"]!.AsObject().ContainsKey("classic"));
    }

    [Fact]
    public async Task A_removed_theme_reads_as_classic()
    {
        await SaveSite("""{"brand_name": "Kadai"}""");
        await Sql("UPDATE platform_settings SET value = JSON_SET(value, '$.theme', 'retired', '$.theme_settings', CAST(@ts AS JSON)) WHERE `key` = 'site'",
            new { ts = """{"retired": {"preset": "x"}, "luxe": {"colors": {"primary": "bad"}}}""" });
        var site = await Site();
        Assert.Equal("classic", site["theme"]!.GetValue<string>());
        Assert.Empty(site["theme_settings"]!.AsObject());
    }

    [Fact]
    public async Task Site_validation_messages()
    {
        async Task<string> Bad(string json) => (await Assert.ThrowsAsync<AppException>(() => SaveSite(json))).Message;
        Assert.Equal("Colour 'primary' must be a hex value like #0B5563", await Bad("""{"colors": {"primary": "red"}}"""));
        Assert.Equal("Corner style must be rounded, soft or square", await Bad("""{"radius": "round"}"""));
        Assert.Equal("Enter a valid 15-character GSTIN", await Bad("""{"business": {"gstin": "12345"}}"""));
        Assert.Equal("The copyright line can use {year}, {legal_name} and {brand} only", await Bad("""{"footer": {"copyright": "© {owner}"}}"""));
        Assert.Equal("The link for Insta must be a full address starting with https://",
            await Bad("""{"social": {"links": [{"label": "Insta", "url": "http://x.com", "icon": "instagram"}]}}"""));
        var saved = await SaveSite("""{"contact": {"items": [{"type": "email", "label": "Email", "value": "help@kadai.in"}]}, "header_links": [{"label": "Bad", "href": "javascript:x"}, {"label": "Sell", "href": "/sell"}]}""");
        Assert.Single(saved["header_links"]!.AsArray());
        var b = await With<ISiteBAL, JsonObject>(async s => s.PublicBusiness(await s.GetSiteAsync()));
        Assert.Equal("help@kadai.in", b["support_email"]!.GetValue<string>());
        Assert.Equal("PixCart", b["legal_name"]!.GetValue<string>());
    }

    // ------------------------------------------------------------------------- lists

    private static readonly Dictionary<string, int> ListDefaults = new()
    {
        ["search_page_size"] = 24, ["search_suggestions"] = 8, ["recent_searches_max"] = 8, ["brand_filter_max"] = 30, ["similar_products"] = 12,
        ["sponsored_on_product"] = 10, ["highlights_shown"] = 5, ["customer_photos_shown"] = 6, ["reviews_page_size"] = 10, ["questions_page_size"] = 10,
        ["bestseller_badge_top"] = 10, ["recently_viewed_max"] = 12, ["compare_max"] = 4, ["checkout_suggestions"] = 10,
    };

    [Fact]
    public async Task List_defaults_reach_the_storefront()
    {
        var lists = (await Site())["lists"]!.AsObject();
        Assert.Equal(ListDefaults.Keys.ToList(), lists.Select(kv => kv.Key).ToList());
        foreach (var (k, v) in ListDefaults) Assert.Equal(v, lists[k]!.GetValue<int>());
    }

    [Fact]
    public async Task List_ranges_are_validated()
    {
        foreach (var (key, bad) in new (string, int)[] { ("search_page_size", 7), ("search_page_size", 61), ("compare_max", 1), ("compare_max", 7),
                     ("reviews_page_size", 4), ("similar_products", -1), ("highlights_shown", 0), ("recent_searches_max", 21) })
        {
            var e = await Assert.ThrowsAsync<AppException>(() => SetSettings(new Dictionary<string, int> { [key] = bad }));
            Assert.Equal(400, e.StatusCode);
        }
        await SetSettings(new { similar_products = 0, recent_searches_max = 0, checkout_suggestions = 0 });
        var lists = (await Site())["lists"]!;
        Assert.Equal(0, lists["similar_products"]!.GetValue<int>());
        Assert.Equal(0, lists["recent_searches_max"]!.GetValue<int>());
        Assert.Equal(0, lists["checkout_suggestions"]!.GetValue<int>());
        Assert.Equal("search_page_size must be a whole number between 8 and 60",
            (await Assert.ThrowsAsync<AppException>(() => SetSettings(new { search_page_size = 7 }))).Message);
        Assert.Equal("Unknown setting: nope", (await Assert.ThrowsAsync<AppException>(() => SetSettings(new { nope = 1 }))).Message);
        Assert.Equal("payment_return_mode must be one of: return, window",
            (await Assert.ThrowsAsync<AppException>(() => SetSettings(new { payment_return_mode = "x" }))).Message);
        Assert.Equal("shop_play_store_url must be a link starting with https://",
            (await Assert.ThrowsAsync<AppException>(() => SetSettings(new { shop_play_store_url = "ftp://x" }))).Message);
    }

    [Fact]
    public async Task Lists_obey_their_settings()
    {
        var cats = await Seed.CategoriesAsync();
        var seller = await Seed.SellerAsync("9400000011", "Lists Test Store");
        var made = new List<P>();
        for (var i = 0; i < 6; i++)
            made.Add(await Seed.ProductAsync(seller, cats["shirts"], $"Cotton Shirt Style {i}", [new($"LS-{i}", 120000, 99900, 5)]));
        await SetSettings(new { search_page_size = 8, search_suggestions = 2, compare_max = 2 });
        Assert.Equal(8, (await Visitor.Get("/api/catalog/products?q=cotton shirt"))["page_size"].GetValue<int>());
        Assert.Equal(3, (await Visitor.Get("/api/catalog/products?q=cotton shirt&page_size=3"))["page_size"].GetValue<int>());
        var sugg = (await Visitor.Get("/api/catalog/suggest?q=cotton")).Body!;
        Assert.True(sugg["products"]!.AsArray().Count <= 2);
        Assert.True(sugg["categories"]!.AsArray().Count <= 2);
        var ids = string.Join(",", made.Take(3).Select(p => p.Id));
        Assert.Equal(2, (await Visitor.Get($"/api/catalog/compare?ids={ids}"))["items"].AsArray().Count);
        var slug = made[0].Slug;
        Assert.NotEmpty((await Visitor.Get($"/api/catalog/products/{slug}"))["similar"].AsArray()); // siblings in the same category
        await SetSettings(new { similar_products = 0 });
        Assert.Empty((await Visitor.Get($"/api/catalog/products/{slug}"))["similar"].AsArray());
    }

    // ------------------------------------------------------------------------- maintenance and error pages

    private const string DefaultMessage = "We are making a few improvements and will be back shortly. Thank you for your patience.";

    [Fact]
    public async Task Maintenance_off_by_default_switch_on_and_validation()
    {
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse($$"""{"on": false, "message": "{{DefaultMessage}}"}"""), (await Site())["maintenance"]));
        var r = await SetSettings(new { maintenance_mode = true, maintenance_message = "  Back at  6 pm   after a stock update. " });
        Assert.Equal("Back at 6 pm after a stock update.", r.Str("maintenance_message")); // spaces tidied
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"on": true, "message": "Back at 6 pm after a stock update."}"""), (await Site())["maintenance"]));
        foreach (var body in new[] { """{"maintenance_mode": "yes"}""", """{"maintenance_mode": 1}""", """{"maintenance_message": "short"}""",
                     $$"""{"maintenance_message": "{{new string('x', 301)}}"}""", """{"maintenance_message": 42}""", """{"maintenance_message": null}""" })
        {
            var e = await Assert.ThrowsAsync<AppException>(() => With<IPlatformSettingsBAL, JsonObject>(s => s.UpdateAsync(JsonNode.Parse(body)!.AsObject())));
            Assert.Equal("invalid_setting", e.Code);
        }
    }

    [Fact]
    public async Task Error_pages_are_editable()
    {
        var pages = (await Site())["error_pages"]!;
        Assert.True(pages["not_found_search"]!.GetValue<bool>());
        Assert.True(pages["not_found_suggestions"]!.GetValue<bool>());
        Assert.Equal("We couldn't find that page", pages["not_found_title"]!.GetValue<string>());
        Assert.Equal("Something went wrong on our side", pages["error_title"]!.GetValue<string>());
        await SetSettings(new { not_found_title = "Lost?", not_found_suggestions = false, error_message = "Our team has been told. Please try again in a minute." });
        pages = (await Site())["error_pages"]!;
        Assert.Equal("Lost?", pages["not_found_title"]!.GetValue<string>());
        Assert.False(pages["not_found_suggestions"]!.GetValue<bool>());
        Assert.Equal("Our team has been told. Please try again in a minute.", pages["error_message"]!.GetValue<string>());
        foreach (var body in new[] { """{"not_found_title": "ab"}""", $$"""{"error_title": "{{new string('x', 81)}}"}""", """{"not_found_search": "no"}""", """{"error_message": ""}""" })
            await Assert.ThrowsAsync<AppException>(() => With<IPlatformSettingsBAL, JsonObject>(s => s.UpdateAsync(JsonNode.Parse(body)!.AsObject())));
    }

    // ------------------------------------------------------------------------- gallery

    [Fact]
    public async Task Product_videos_and_gallery_settings()
    {
        var (_, _, shirt, _, _) = await SetupAsync();
        await Sql("INSERT INTO product_videos (id, product_id, url, poster_url, title, duration_s, position) VALUES " +
                  "(@a, @p, '/media/videos/a.mp4', '/media/products/poster.webp', 'How it fits', 42, 0), (@b, @p, '/media/videos/b.webm', '', 'Fabric close-up', 0, 1)",
            new { a = Guid.NewGuid(), b = Guid.NewGuid(), p = shirt.Id });
        var page = (await Visitor.Get($"/api/catalog/products/{shirt.Slug}")).Body!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"url": "/media/videos/a.mp4", "poster_url": "/media/products/poster.webp", "title": "How it fits", "duration_s": 42}"""),
            page["videos"]![0]));
        Assert.Equal("Fabric close-up", page["videos"]![1]!["title"]!.GetValue<string>());
        await SetSettings(new { feature_product_videos = false, gallery_zoom = false, gallery_zoom_level = 30 });
        Assert.Empty((await Visitor.Get($"/api/catalog/products/{shirt.Slug}"))["videos"].AsArray());
        var site = await Site();
        Assert.False(site["gallery"]!["zoom"]!.GetValue<bool>());
        Assert.Equal(3.0, site["gallery"]!["zoom_level"]!.GetValue<double>());
        Assert.False(site["features"]!["product_videos"]!.GetValue<bool>());
        await Assert.ThrowsAsync<AppException>(() => SetSettings(new { gallery_zoom_level = 99 }));
        await Assert.ThrowsAsync<AppException>(() => SetSettings(new { max_video_mb = 1 }));
    }

    // ------------------------------------------------------------------------- home page and pages

    private async Task AddSection(string kind, string title, string config)
    {
        var cfg = await With<ISiteBAL, JsonObject>(s => Task.FromResult(s.ValidateSection(kind, JsonNode.Parse(config)!.AsObject())));
        await With<CmsDAL, bool>(async c =>
        {
            var now = DateTimeFunctions.UtcNow();
            await c.InsertSectionAsync(new HomeSectionModel
            {
                Id = Guid.NewGuid(), Kind = kind, Title = title, Config = cfg.ToJsonString(), Position = await c.MaxPositionAsync() + 10, IsActive = true,
                Device = "all", CreatedAt = now, UpdatedAt = now,
            });
            return true;
        });
    }

    [Fact]
    public async Task Home_sections_default_and_media_blocks()
    {
        var (_, _, shirt, phone, _) = await SetupAsync();
        var home = (await Visitor.Get("/api/home")).Body!;
        var kinds = home["sections"]!.AsArray().Select(s => s!["kind"]!.GetValue<string>()).ToList();
        Assert.Contains("categories", kinds);
        Assert.DoesNotContain("deals", kinds); // no deal is running: the empty row is left out
        var rows = home["sections"]!.AsArray().Where(s => s!["kind"]!.GetValue<string>() == "products").ToList();
        Assert.Contains(rows, r => r!["title"]!.GetValue<string>() == "Deals of the day" && r["products"]!.AsArray().Count == 2);
        var cards = home["sections"]!.AsArray().First(s => s!["kind"]!.GetValue<string>() == "cards")!;
        Assert.Equal(4, cards["config"]!["cards"]!.AsArray().Count); // bestsellers card has products (sold_count 0 sorts too)
        Assert.Equal(2, home["categories"]!.AsArray().Count);
        var listing = await With<CmsDAL, List<HomeSectionModel>>(async c => (await c.AllSectionsAsync()).ToList());
        Assert.Equal(12, listing.Count);
        var categories = listing.First(s => s.Kind == "categories");
        Assert.Equal("auto", JsonNode.Parse(categories.Config)!["style"]!.GetValue<string>());
        Assert.Equal("Categories", (await With<ISiteBAL, JsonObject>(s => Task.FromResult(s.SectionOut(categories))))["kind_label"]!.GetValue<string>());

        await AddSection("media", "See it in use", """{"image": "/media/products/0123456789abcdef.webp", "video": "/media/videos/0123456789abcdef.mp4", "heading": "Brass lamps", "link": "/c/home", "aspect": "21/9", "controls": true}""");
        await AddSection("categories", "Pick", """{"slugs": ["mobiles", "fashion", "nope"]}""");
        await AddSection("countdown", "Ended", """{"heading": "Sale", "ends_at": "2020-01-01T10:00"}""");
        await AddSection("products", "Picked", $$"""{"source": "manual", "product_ids": ["{{phone.Id}}", "bad", "{{shirt.Id}}"]}""");
        var sections = (await Visitor.Get("/api/home"))["sections"].AsArray();
        var media = sections.First(s => s!["kind"]!.GetValue<string>() == "media")!;
        Assert.Equal("See it in use", media["title"]!.GetValue<string>());
        Assert.True(media["config"]!["controls"]!.GetValue<bool>());
        Assert.Equal("/media/videos/0123456789abcdef.mp4", media["config"]!["video"]!.GetValue<string>());
        var pick = sections.First(s => s!["title"]!.GetValue<string>() == "Pick")!;
        Assert.Equal(["mobiles", "fashion"], pick["categories"]!.AsArray().Select(c => c!["slug"]!.GetValue<string>()));
        Assert.DoesNotContain(sections, s => s!["kind"]!.GetValue<string>() == "countdown");
        var picked = sections.First(s => s!["title"]!.GetValue<string>() == "Picked")!;
        Assert.Equal([phone.Slug, shirt.Slug], picked["products"]!.AsArray().Select(p => p!["slug"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Pages()
    {
        var terms = (await Visitor.Get("/api/pages/terms")).Body!;
        Assert.Equal("Terms of use", terms["title"]!.GetValue<string>());
        Assert.Null(terms["updated_at"]);
        Assert.Equal(404, (await Visitor.Get("/api/pages/nope")).Status);
        Assert.Equal("Page not found", (await Visitor.Get("/api/pages/nope"))["error"]["message"]!.GetValue<string>());
        await Sql("INSERT INTO cms_pages (id, slug, title, body, meta_description, is_published, created_at, updated_at) VALUES " +
                  "(@a, 'terms', 'Our terms', 'Be nice', 'Terms', 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)), (@b, 'draft', 'Draft', '', '', 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            new { a = Guid.NewGuid(), b = Guid.NewGuid() });
        terms = (await Visitor.Get("/api/pages/terms")).Body!;
        Assert.Equal("Our terms", terms["title"]!.GetValue<string>());
        Assert.EndsWith("+00:00", terms["updated_at"]!.GetValue<string>());
        Assert.Equal(404, (await Visitor.Get("/api/pages/draft")).Status);
    }
}
