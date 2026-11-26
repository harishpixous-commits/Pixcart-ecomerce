using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>
/// The route table: no two endpoints answer the same method and path shape (parameters do not tell routes apart:
/// every id is validated by the query rules, after sign-in and permission checks, so a malformed id gets 401/403 and
/// then 422, never 404). Route templates carry no type constraints for the same reason.
/// </summary>
[Collection("api")]
public class RouteTableTests(ApiFactory factory)
{
    [Fact]
    public void Every_method_and_path_shape_has_one_endpoint_and_no_type_constraints()
    {
        var endpoints = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>().ToList();
        Assert.NotEmpty(endpoints);
        var shapes = new Dictionary<string, string>();
        var duplicates = new List<string>();
        var constrained = new List<string>();
        foreach (var e in endpoints)
        {
            var raw = e.RoutePattern.RawText ?? "";
            if (e.RoutePattern.Parameters.Any(p => p.ParameterPolicies.Count > 0) && raw.StartsWith("/api", StringComparison.OrdinalIgnoreCase))
                constrained.Add(raw);
            var shape = "/" + string.Join("/", e.RoutePattern.PathSegments.Select(s =>
                s.IsSimple && s.Parts[0] is Microsoft.AspNetCore.Routing.Patterns.RoutePatternLiteralPart lit ? lit.Content.ToLowerInvariant() : "{}"));
            var methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["*"];
            foreach (var m in methods)
            {
                var key = m + " " + shape;
                if (shapes.TryGetValue(key, out var other)) duplicates.Add($"{key}: {other} and {raw}");
                else shapes[key] = raw;
            }
        }
        Assert.True(duplicates.Count == 0, "routes that only a constraint told apart:\n" + string.Join("\n", duplicates));
        Assert.True(constrained.Count == 0, "API routes with constraints (use the query rules instead):\n" + string.Join("\n", constrained.Distinct()));
    }
}
