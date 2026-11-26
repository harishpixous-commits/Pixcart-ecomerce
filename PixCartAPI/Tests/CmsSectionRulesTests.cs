namespace Tests;

/// <summary>Home sections: every item sent is checked, also those beyond the number a section keeps.</summary>
public class CmsSectionRulesTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Every_banner_and_promise_is_checked_then_the_first_ones_kept()
    {
        var admin = await Admin();
        var banners = Enumerable.Range(1, 5).Select(i => (object)new { image = "", link = $"/c/cat-{i}" }).ToList();
        var r = await admin.Post("/api/admin/storefront/sections", new { kind = "banner_grid", title = "Grid", config = new { items = banners } });
        Assert.Equal(201, r.Status);
        Assert.Equal(4, r.Json["config"]!["items"]!.AsArray().Count); // the first four are kept

        banners[4] = new { image = "", link = "javascript:alert(1)" }; // the fifth is not kept but still checked
        r = await admin.Post("/api/admin/storefront/sections", new { kind = "banner_grid", title = "Grid", config = new { items = banners } });
        Assert.Equal("invalid_section", r.ErrorCode);
        Assert.Equal("Links must start with / or https://", r.ErrorMessage);

        var promises = Enumerable.Range(1, 6).Select(i => (object)new { icon = "check", text = $"Promise {i}" }).ToList();
        promises.Add("not an item");
        r = await admin.Post("/api/admin/storefront/sections", new { kind = "usp", title = "Promises", config = new { items = promises } });
        Assert.Equal("invalid_section", r.ErrorCode);
    }
}
