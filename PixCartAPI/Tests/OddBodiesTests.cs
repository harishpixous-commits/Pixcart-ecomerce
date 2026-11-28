using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>Odd bodies (empty, huge text, NUL characters, wrong types, absurd numbers) never end as a server error on any
/// staff or customer route. Same sweep as the Python version's test_odd_bodies.</summary>
public class OddBodiesTests(ApiFactory f) : ApiTest(f)
{
    private static readonly string[] Skip = ["logout", "backup", "restore", "purge", "import", "webhook", "/api/auth/"];

    private static readonly object[] Bodies =
    [
        new { },
        new { name = new string('x', 100_000), title = "a\u0000b", value = "z", code = "\u0000\u0000", reason = new string('r', 50_000) },
        new object[] { },
        new { id = (string?)null, value = (string?)null, enabled = "maybe", amount_paise = -100_000_000_000_000_000L },
    ];

    private async Task<(int Sent, List<string> Bad)> Sweep(Api who, bool admin)
    {
        var routes = Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Where(m => m is "POST" or "PUT" or "PATCH").Select(m => (Method: m, Path: "/" + (e.RoutePattern.RawText ?? "").TrimStart('/'))))
            .Where(r => r.Path.StartsWith("/api", StringComparison.OrdinalIgnoreCase) && r.Path.Contains("/admin", StringComparison.OrdinalIgnoreCase) == admin && !Skip.Any(s => r.Path.Contains(s, StringComparison.OrdinalIgnoreCase)))
            .Distinct().ToList();
        int sent = 0; var bad = new List<string>();
        foreach (var (method, path) in routes)
        {
            var url = System.Text.RegularExpressions.Regex.Replace(path, @"\{[^}]+\}", "00000000-0000-0000-0000-000000000000");
            foreach (var body in Bodies)
            {
                try
                {
                    var r = await who.B.SendAsync(new HttpMethod(method), url, body, who.Token);
                    sent++;
                    if (r.Status >= 500) bad.Add($"{method} {path} {r.Status}");
                }
                catch (Exception e) { bad.Add($"{method} {path} EXC {e.GetType().Name}"); }
            }
        }
        return (sent, bad);
    }

    [Fact]
    public async Task Staff_routes_never_server_error_on_odd_bodies()
    {
        var (sent, bad) = await Sweep(await Admin(), true);
        Assert.True(sent > 300, $"only {sent} requests");
        Assert.True(bad.Count == 0, string.Join("; ", bad.Take(30)));
    }

    [Fact]
    public async Task Customer_routes_never_server_error_on_odd_bodies()
    {
        var (sent, bad) = await Sweep(await LoginPhone("9880000124", "Fuzz Customer"), false);
        Assert.True(sent > 300, $"only {sent} requests");
        Assert.True(bad.Count == 0, string.Join("; ", bad.Take(30)));
    }
}
