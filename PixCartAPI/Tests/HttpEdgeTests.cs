using System.Text.RegularExpressions;

namespace Tests;

/// <summary>
/// Answers at the edges of the API: malformed ids, paths and methods nobody serves, the headers every answer carries,
/// role codes that differ only in case, and search texts used as patterns.
/// </summary>
public class HttpEdgeTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task A_malformed_id_is_checked_after_sign_in_and_named_in_a_422()
    {
        var visitor = Factory.Browser();
        Assert.Equal(401, (await visitor.Get("/api/admin/customers/not-an-id")).Status);
        var admin = await Admin();
        var r = await admin.Get("/api/admin/customers/not-an-id");
        Assert.Equal(422, r.Status);
        Assert.Equal("validation_error", r.ErrorCode);
        Assert.NotNull(r.Json["error"]!["fields"]!["user_id"]);
        Assert.Equal(404, (await admin.Get($"/api/admin/customers/{Guid.NewGuid()}")).Status);
    }

    [Fact]
    public async Task Paths_and_methods_nobody_serves_get_the_plain_answers()
    {
        var b = Factory.Browser();
        var missing = await b.Get("/api/no/such/path");
        Assert.Equal(404, missing.Status);
        Assert.Equal("""{"detail":"Not Found"}""", missing.Text);
        var wrongMethod = await b.Delete("/api/catalog/products");
        Assert.Equal(405, wrongMethod.Status);
        Assert.Equal("""{"detail":"Method Not Allowed"}""", wrongMethod.Text);
        // the application's own errors keep their shape
        Assert.Equal("not_found", (await b.Get("/api/catalog/products/no-such-product")).ErrorCode);
    }

    [Fact]
    public async Task Every_answer_carries_the_request_id_and_security_headers()
    {
        using var http = Factory.CreateClient();
        foreach (var url in new[] { "/api/catalog/categories", "/api/catalog/products/no-such-product", "/api/no/such/path" })
        {
            using var resp = await http.GetAsync(url);
            Assert.Matches("^[0-9a-f]{32}$", resp.Headers.GetValues("X-Request-ID").Single());
            Assert.Equal("nosniff", resp.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal("DENY", resp.Headers.GetValues("X-Frame-Options").Single());
            Assert.Equal("strict-origin-when-cross-origin", resp.Headers.GetValues("Referrer-Policy").Single());
        }
        using var traced = new HttpRequestMessage(HttpMethod.Get, "/api/catalog/categories");
        traced.Headers.Add("X-Request-ID", "trace-1234-abcd");
        Assert.Equal("trace-1234-abcd", (await http.SendAsync(traced)).Headers.GetValues("X-Request-ID").Single());
        using var tooShort = new HttpRequestMessage(HttpMethod.Get, "/api/catalog/categories");
        tooShort.Headers.Add("X-Request-ID", "abc");
        Assert.Matches("^[0-9a-f]{32}$", (await http.SendAsync(tooShort)).Headers.GetValues("X-Request-ID").Single());
    }

    [Fact]
    public async Task Role_codes_match_exactly()
    {
        var admin = await Admin();
        var support = await Staff(admin, "sup.edge@kadai.in", "support");
        // another letter case is another (unknown) role: nothing is deleted, assigned or changed
        Assert.Equal(404, (await admin.Delete("/api/admin/roles/Support")).Status);
        Assert.Equal(404, (await admin.Patch($"/api/admin/staff/{support.Id}", new { role = "SUPPORT" })).Status);
        Assert.Equal(404, (await admin.Post("/api/admin/staff", new { email = "x.edge@kadai.in", name = "Xavier", role = "Finance", password = "Staff@2026xyz" })).Status);
        Assert.Equal(200, (await support.Get("/api/auth/me")).Status);
        var role = await ApiFactory.DbScalarAsync<string>("SELECT admin_role FROM users WHERE id = @id", new { id = support.Id });
        Assert.Equal("support", role);
    }

    [Fact]
    public async Task Translation_search_treats_the_text_as_a_pattern()
    {
        var admin = await Admin();
        foreach (var (src, text) in new[] { ("e-mail", "ई-मेल"), ("e mail", "ई मेल"), ("50% off", "50% छूट") })
            await ApiFactory.DbExecAsync(
                "INSERT INTO translations (id, lang, source_hash, source, text, origin) VALUES (@id, 'hi', @hash, @src, @text, 'ai')",
                new { id = Guid.NewGuid().ToString(), hash = Guid.NewGuid().ToString("N"), src, text });
        async Task<long> Total(string q) =>
            (await admin.Get($"/api/admin/translations?lang=hi&q={Uri.EscapeDataString(q)}")).Json["total"]!.GetValue<long>();
        Assert.Equal(2, await Total("e_mail")); // _ matches any one character
        Assert.Equal(1, await Total("50%"));
        Assert.Equal(3, await Total("_"));
    }
}
