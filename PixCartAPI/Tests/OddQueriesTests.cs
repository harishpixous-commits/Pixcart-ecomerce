using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>Odd query strings (huge page sizes, NUL characters, wrong types, odd sort values) never end as a server error on
/// any read route. Same sweep as the Python version's test_odd_queries.</summary>
public class OddQueriesTests(ApiFactory f) : ApiTest(f)
{
    private static readonly string[] Skip = ["webhook", "/api/auth/", "download", "export"];
    private static readonly string[] Odd = ["-1", "0", "99999999999999999999", new string('x', 3000), "a%00b", "%00", "abc", "1.5e9", "null", "[]", "2026-13-45", "' OR 1=1 --"];
    private static readonly string[] Names = ["q", "limit", "page", "sort", "status", "days", "from", "to", "id", "category", "min_price", "max_price", "per_page", "offset", "order"];

    private async Task<(int Sent, List<string> Bad)> Sweep(Api who, bool admin)
    {
        var routes = Factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Where(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Contains("GET"))
            .Select(e => "/" + (e.RoutePattern.RawText ?? "").TrimStart('/'))
            .Where(p => p.StartsWith("/api", StringComparison.OrdinalIgnoreCase) && p.Contains("/admin", StringComparison.OrdinalIgnoreCase) == admin && !Skip.Any(s => p.Contains(s, StringComparison.OrdinalIgnoreCase)))
            .Distinct().ToList();
        int sent = 0; var bad = new List<string>();
        foreach (var path in routes)
        {
            var url = System.Text.RegularExpressions.Regex.Replace(path, @"\{[^}]+\}", "00000000-0000-0000-0000-000000000000");
            foreach (var v in Odd)
            {
                var qs = string.Join("&", Names.Select(n => $"{n}={(v.Length > 100 ? v : Uri.EscapeDataString(v).Replace("%2500", "%00"))}"));
                try
                {
                    var r = await who.B.Get($"{url}?{qs}", who.Token);
                    sent++;
                    if (r.Status >= 500) bad.Add($"GET {path} {r.Status} [{(v.Length > 12 ? v[..12] : v)}]");
                }
                catch (Exception e) { bad.Add($"GET {path} EXC {e.GetType().Name}"); }
            }
        }
        return (sent, bad.Distinct().ToList());
    }

    [Fact]
    public async Task Staff_read_routes_never_server_error_on_odd_queries()
    {
        var (sent, bad) = await Sweep(await Admin(), true);
        Assert.True(sent > 300, $"only {sent} requests");
        Assert.True(bad.Count == 0, string.Join("; ", bad.Take(40)));
    }

    [Fact]
    public async Task Customer_read_routes_never_server_error_on_odd_queries()
    {
        var (sent, bad) = await Sweep(await LoginPhone("9880000126", "Query Fuzz"), false);
        Assert.True(sent > 300, $"only {sent} requests");
        Assert.True(bad.Count == 0, string.Join("; ", bad.Take(40)));
    }
}
