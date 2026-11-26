using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Tests;

/// <summary>
/// The one-site hosting (the Angular build in wwwroot next to the API): page paths get the website, files are files,
/// and API and media paths keep the API's answers (404 with detail, 405 with Allow for a wrong method).
/// </summary>
[Collection("api")]
public sealed class WebsiteHostTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "pixcart-test-website", Guid.NewGuid().ToString("N"));
    private readonly WebsiteFactory factory;

    public WebsiteHostTests()
    {
        Directory.CreateDirectory(Path.Combine(root, "wwwroot"));
        File.WriteAllText(Path.Combine(root, "wwwroot", "index.html"), "<!doctype html><title>shop</title>");
        File.WriteAllText(Path.Combine(root, "wwwroot", "main-ABCDEFGH.js"), "console.log(1)");
        factory = new WebsiteFactory(root);
    }

    [Fact]
    public async Task Pages_get_the_website_and_api_paths_keep_the_api_answers()
    {
        using var http = factory.CreateClient();
        foreach (var page in new[] { "/", "/admin/orders", "/p/some-product" })
        {
            using var r = await http.GetAsync(page);
            Assert.Equal(200, (int)r.StatusCode);
            Assert.Contains("<title>shop</title>", await r.Content.ReadAsStringAsync());
            Assert.Equal("SAMEORIGIN", r.Headers.GetValues("X-Frame-Options").Single());
        }
        Assert.Equal("console.log(1)", await http.GetStringAsync("/main-ABCDEFGH.js"));
        Assert.Equal(404, (int)(await http.GetAsync("/missing.js")).StatusCode);

        using var missing = await http.GetAsync("/api/no/such/path");
        Assert.Equal(404, (int)missing.StatusCode);
        Assert.Equal("""{"detail":"Not Found"}""", await missing.Content.ReadAsStringAsync());
        using var wrongMethod = await http.DeleteAsync("/api/catalog/products");
        Assert.Equal(405, (int)wrongMethod.StatusCode);
        Assert.Contains("GET", wrongMethod.Content.Headers.Allow);
        Assert.Equal(404, (int)(await http.GetAsync("/media/nope.jpg")).StatusCode);
    }

    public void Dispose()
    {
        factory.Dispose();
        try { Directory.Delete(root, recursive: true); } catch (IOException) { }
    }
}

/// <summary>The API with a website build in its content root.</summary>
public sealed class WebsiteFactory : WebApplicationFactory<Program>
{
    private readonly string root;

    public WebsiteFactory(string root)
    {
        this.root = root;
        _ = ApiFactory.ConnectionString; // the tests' API settings (environment variables), before the host is built
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.UseContentRoot(root);
    }
}
