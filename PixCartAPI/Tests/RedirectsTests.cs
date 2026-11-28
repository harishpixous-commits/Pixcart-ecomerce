using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Tests;

/// <summary>URL redirects: staff map an old address to a new one; the shop's page-not-found screen asks and sends the visitor on.</summary>
public class RedirectsTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Redirects_are_tidied_checked_counted_and_can_be_switched_off()
    {
        var admin = await Admin(); var visitor = Factory.CreateClient();
        var r = await admin.Post("/api/admin/redirects", new { from_path = "/Old-Shirt/", to_path = "/p/new-shirt" });
        Assert.Equal(201, r.Status);
        var rule = r.Json; Assert.Equal("/old-shirt", rule["from_path"]!.GetValue<string>()); Assert.Equal(301, rule["status_code"]!.GetValue<int>());
        foreach (var path in new[] { "/old-shirt", "/OLD-shirt/" })
        {
            var got = await visitor.GetAsync("/api/catalog/redirect?path=" + Uri.EscapeDataString(path));
            Assert.Equal(200, (int)got.StatusCode);
            var j = (await got.Content.ReadFromJsonAsync<JsonObject>())!; Assert.Equal("/p/new-shirt", j["to"]!.GetValue<string>()); Assert.Equal(301, j["status"]!.GetValue<int>());
        }
        Assert.Equal(404, (int)(await visitor.GetAsync("/api/catalog/redirect?path=%2Fnothing-here")).StatusCode);
        Assert.Equal(2, (await admin.Get("/api/admin/redirects")).Json["items"]![0]!["hits"]!.GetValue<int>());
        var bad = new object[]
        {
            new { from_path = "old", to_path = "/x" }, new { from_path = "/", to_path = "/x" }, new { from_path = "/admin/orders", to_path = "/x" },
            new { from_path = "/a", to_path = "//evil.example" }, new { from_path = "/a", to_path = "http://plain.example" }, new { from_path = "/a", to_path = "/a/" },
            new { from_path = "/a", to_path = "/x", status_code = 307 }, new { from_path = "/p/new-shirt", to_path = "/old-shirt" },
        };
        foreach (var b in bad) Assert.Equal(422, (await admin.Post("/api/admin/redirects", b)).Status);
        Assert.Equal(409, (await admin.Post("/api/admin/redirects", new { from_path = "/old-shirt", to_path = "/y" })).Status);
        var id = rule["id"]!.GetValue<string>();
        var e = await admin.Put($"/api/admin/redirects/{id}", new { from_path = "/old-shirt", to_path = "https://example.com/shirt", status_code = 302 });
        Assert.Equal(200, e.Status); Assert.Equal(302, e.Json["status_code"]!.GetValue<int>());
        var again = (await (await visitor.GetAsync("/api/catalog/redirect?path=%2Fold-shirt")).Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("https://example.com/shirt", again["to"]!.GetValue<string>());
        await admin.Put($"/api/admin/redirects/{id}", new { from_path = "/old-shirt", to_path = "/p/new-shirt", is_active = false });
        Assert.Equal(404, (int)(await visitor.GetAsync("/api/catalog/redirect?path=%2Fold-shirt")).StatusCode);
        Assert.Equal(200, (await admin.Delete($"/api/admin/redirects/{id}")).Status);
        Assert.Empty((await admin.Get("/api/admin/redirects")).Json["items"]!.AsArray());
    }
}
