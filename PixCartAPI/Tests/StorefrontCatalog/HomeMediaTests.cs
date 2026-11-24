using System.Text.Json.Nodes;
using BAL;

namespace Tests.StorefrontCatalog;

/// <summary>Reference: tests/test_home_media.py — videos on home sections, the image or video block, category styles (Cms.ValidateSection).</summary>
public class HomeMediaTests
{
    private const string Image = "/media/products/0123456789abcdef.webp";
    private const string Video = "/media/videos/0123456789abcdef.mp4";
    private const string VideoMsg = "Videos must be uploaded through the media library";

    public static readonly TheoryData<string> BadVideos =
    [
        "javascript:alert(1)//x.mp4", "JavaScript:alert(1)", "http://cdn.example.com/clip.mp4", "//cdn.example.com/clip.mp4", "data:video/mp4;base64,AAAA",
        "/media/videos/clip.mov", "/media/videos/clip.mp4.exe", Image, "https://cdn.example.com/page.html?file=.mp4", "/media/videos/\"onerror=alert(1).mp4",
        "/media/videos/" + new string('a', 400) + ".mp4", "https://[cdn.example.com/clip.mp4",
    ];

    private static JsonObject O(string json) => JsonNode.Parse(json)!.AsObject();

    private static JsonObject Slide(string? video = null)
    {
        var s = O($$"""{"image": "{{Image}}", "heading": "Silk week", "text": "Handloom sarees", "cta": "Shop now", "link": "/c/fashion"}""");
        s["video"] = video;
        return s;
    }

    private static JsonObject V(string kind, JsonObject cfg) => Cms.ValidateSection(kind, cfg);

    [Fact]
    public void Videos_on_slides_banners_grids_and_tiles()
    {
        var hero = V("hero", new JsonObject { ["slides"] = new JsonArray(Slide(Video), Slide()), ["style"] = "fade" });
        Assert.Equal(Video, hero["slides"]![0]!["video"]!.GetValue<string>());
        Assert.Equal(Image, hero["slides"]![0]!["image"]!.GetValue<string>()); // the image stays as the poster
        Assert.Equal("", hero["slides"]![1]!["video"]!.GetValue<string>());
        Assert.Equal("", hero["slides"]![0]!["image_mobile"]!.GetValue<string>());
        Assert.Equal("light", hero["slides"]![0]!["theme"]!.GetValue<string>());
        Assert.Equal("fade", hero["style"]!.GetValue<string>());

        const string httpsVideo = "https://cdn.example.com/home/loop.webm?v=2";
        var banner = V("banner", Slide(httpsVideo));
        Assert.True(JsonNode.DeepEquals(O($$"""{"image": "{{Image}}", "video": "{{httpsVideo}}", "link": "/c/fashion", "heading": "Silk week", "text": "Handloom sarees", "cta": "Shop now"}"""), banner));
        Assert.Equal("", V("banner", Slide())["video"]!.GetValue<string>());

        var grid = V("banner_grid", new JsonObject { ["items"] = new JsonArray(Slide(Video), Slide(" /media/videos/loop.WEBM ")) });
        Assert.Equal([Video, "/media/videos/loop.WEBM"], grid["items"]!.AsArray().Select(i => i!["video"]!.GetValue<string>()));

        var cards = V("cards", O($$"""{"cards": [{"title": "Top picks", "mode": "tiles", "tiles": [{"image": "{{Image}}", "video": "{{Video}}", "label": "Sarees", "link": "/c/sarees"}, {"label": "Kurtas"}]}]}"""));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse($$"""[{"image": "{{Image}}", "video": "{{Video}}", "label": "Sarees", "link": "/c/sarees", "badge": ""}, {"image": "", "video": "", "label": "Kurtas", "link": "", "badge": ""}]"""),
            cards["cards"]![0]!["tiles"]));
    }

    [Theory]
    [MemberData(nameof(BadVideos))]
    public void Video_addresses_are_checked_everywhere(string bad)
    {
        var tile = new JsonObject { ["image"] = Image, ["video"] = bad };
        var cases = new (string Kind, JsonObject Cfg)[]
        {
            ("hero", new JsonObject { ["slides"] = new JsonArray(Slide(bad)) }),
            ("banner", Slide(bad)),
            ("banner_grid", new JsonObject { ["items"] = new JsonArray(Slide(), Slide(bad)) }),
            ("cards", new JsonObject { ["cards"] = new JsonArray(new JsonObject { ["title"] = "Top picks", ["mode"] = "tiles", ["tiles"] = new JsonArray(tile.DeepClone()) }) }),
            ("media", new JsonObject { ["image"] = Image, ["video"] = bad }),
        };
        foreach (var (kind, cfg) in cases)
            Assert.Equal(VideoMsg, Assert.Throws<ArgumentException>(() => V(kind, cfg)).Message);
    }

    [Fact]
    public void Image_or_video_block()
    {
        var full = V("media", O($$"""
            {"image": "{{Image}}", "video": "{{Video}}", "link": "/deals", "heading": "{{new string('H', 200)}}", "text": "{{new string('T', 400)}}", "cta": "{{new string('C', 50)}}",
             "align": "center", "tone": "dark", "aspect": "4/5", "width": "full", "controls": true, "onclick": "alert(1)"}
            """));
        Assert.True(JsonNode.DeepEquals(O($$"""
            {"image": "{{Image}}", "video": "{{Video}}", "link": "/deals", "heading": "{{new string('H', 80)}}", "text": "{{new string('T', 160)}}", "cta": "{{new string('C', 30)}}",
             "align": "center", "tone": "dark", "aspect": "4/5", "width": "full", "controls": true}
            """), full));
        var loose = V("media", O($$"""{"image": "{{Image}}", "align": "right", "tone": "neon", "aspect": "3/1", "width": "huge", "controls": true}"""));
        Assert.True(JsonNode.DeepEquals(O($$"""
            {"image": "{{Image}}", "video": "", "link": "", "heading": "", "text": "", "cta": "", "align": "left", "tone": "light", "aspect": "16/9", "width": "contained", "controls": false}
            """), loose));
        Assert.Equal(Cms.MediaAspects, Cms.MediaAspects.Select(a => V("media", new JsonObject { ["image"] = Image, ["aspect"] = a })["aspect"]!.GetValue<string>()));
        Assert.False(V("media", O($$"""{"video": "{{Video}}", "controls": "yes"}"""))["controls"]!.GetValue<bool>()); // only a real true counts
        var videoOnly = V("media", O($$"""{"video": "{{Video}}", "controls": true}"""));
        Assert.Equal("", videoOnly["image"]!.GetValue<string>());
        Assert.True(videoOnly["controls"]!.GetValue<bool>());
        Assert.Equal("Silk week", V("media", O($$"""{"image": "{{Image}}", "heading": "Silk\u0000 week\u001b"}"""))["heading"]!.GetValue<string>());
        foreach (var empty in new[] { "{}", """{"heading": "Nothing to show"}""", """{"image": "", "video": "  "}""" })
            Assert.Equal("Add an image or a video", Assert.Throws<ArgumentException>(() => V("media", O(empty))).Message);
        Assert.Equal("Links must start with / or https://", Assert.Throws<ArgumentException>(() => V("media", O($$"""{"image": "{{Image}}", "link": "javascript:alert(1)"}"""))).Message);
        foreach (var badImage in new[] { "javascript:alert(1)", "http://cdn.example.com/a.png" })
            Assert.Equal("Images must be uploaded through the media library",
                Assert.Throws<ArgumentException>(() => V("media", new JsonObject { ["image"] = badImage, ["video"] = Video })).Message);
    }

    [Fact]
    public void Category_style()
    {
        string Style(JsonNode? value) => V("categories", new JsonObject { ["slugs"] = new JsonArray("fashion"), ["style"] = value })["style"]!.GetValue<string>();
        foreach (var kept in new[] { "auto", "circles", "cards", "squares", "chips" }) Assert.Equal(kept, Style(kept));
        // "tiles" (saved by earlier versions) and anything unknown follow the theme
        foreach (var old in new JsonNode?[] { "tiles", "grid", "", null, new JsonArray("chips"), 3 }) Assert.Equal("auto", Style(old));
        Assert.True(JsonNode.DeepEquals(O("""{"slugs": [], "style": "auto"}"""), V("categories", [])));
        Assert.Equal("Unknown section type", Assert.Throws<ArgumentException>(() => V("carousel", [])).Message);
        Assert.Equal("A banner grid needs 2 to 4 banners", Assert.Throws<ArgumentException>(() => V("banner_grid", new JsonObject { ["items"] = new JsonArray(Slide()) })).Message);
    }

    [Fact]
    public void Countdown_without_offset_is_india_time()
    {
        var c = V("countdown", O("""{"heading": "Sale", "ends_at": "2026-12-01T18:00"}"""));
        Assert.Equal("2026-12-01T18:00:00+05:30", c["ends_at"]!.GetValue<string>());
        Assert.Equal("buy", c["tone"]!.GetValue<string>());
        Assert.Equal("Choose when the countdown ends", Assert.Throws<ArgumentException>(() => V("countdown", O("""{"ends_at": "soon"}"""))).Message);
    }
}
