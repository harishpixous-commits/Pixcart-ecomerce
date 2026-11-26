using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Utils;

namespace API.Infrastructure;

/// <summary>
/// Applies the reference API's sign-in and permission rule for every route BEFORE the request body is read, exactly as
/// the reference does (its auth dependencies run before body validation). Without this, a request that is both
/// unauthorised and invalid would get 422/415 here but 401/403 there.
///
/// The rules come from <c>route-guards.json</c>, generated from the reference code by tools/schema/route_guards.py:
/// public | optional | signed_in | admin | perm:&lt;code&gt; | seller | approved_seller | partner:&lt;rule&gt;.
/// The business layer still checks permissions itself (defence in depth); this filter only makes the order right.
/// </summary>
public sealed partial class RouteGuardFilter : IAsyncAuthorizationFilter
{
    private static readonly Lazy<Dictionary<string, string>> Rules = new(Load);

    [GeneratedRegex(@"\{[^}]*\}")]
    private static partial Regex Param();

    /// <summary>"GET /api/admin/orders/{}" — methods upper case, parameters blanked, no trailing slash, lower case.</summary>
    public static string Key(string method, string template) =>
        method.ToUpperInvariant() + " " + Param().Replace("/" + template.Trim('/'), "{}").ToLowerInvariant();

    private static Dictionary<string, string> Load()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("API.Infrastructure.route-guards.json")
                      ?? throw new InvalidOperationException("route-guards.json is not embedded");
        var rows = JsonSerializer.Deserialize<List<Row>>(s, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
        return rows.GroupBy(r => Key(r.Method, r.Path)).ToDictionary(g => g.Key, g => g.First().Guard);
    }

    /// <summary>The reference rule for a route, or null when the route has no reference counterpart.</summary>
    public static string? RuleFor(string method, string template) => Rules.Value.TryGetValue(Key(method, template), out var g) ? g : null;

    public static IReadOnlyDictionary<string, string> All => Rules.Value;

    private sealed record Row(string Method, string Path, string Guard);

    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        if (context.ActionDescriptor is not ControllerActionDescriptor action) return;
        var template = action.AttributeRouteInfo?.Template;
        if (string.IsNullOrEmpty(template)) return;
        var rule = RuleFor(context.HttpContext.Request.Method, template)
                   ?? action.MethodInfo.GetCustomAttribute<RouteGuardAttribute>()?.Rule;
        if (rule is null or "public") return;

        var services = context.HttpContext.RequestServices;
        var me = services.GetRequiredService<ICurrentUser>();
        if (rule == "optional")
        {
            await me.GetAsync(); // a bad or expired token is refused even where sign-in is optional, like the reference
            return;
        }
        var user = await me.RequireAsync();
        switch (rule)
        {
            case "signed_in":
                return;
            case "admin":
                if (!user.IsAdmin) throw new ForbiddenException("Admin access required");
                return;
            case "seller":
                await me.RequireSellerAsync(approved: false);
                return;
            case "approved_seller":
                await me.RequireSellerAsync(approved: true);
                return;
            case "partner:current_partner":
                await services.GetRequiredService<IDeliveryBAL>().RequirePartnerAsync(user);
                return;
            case "partner:approved_partner":
                await services.GetRequiredService<IDeliveryBAL>().RequireApprovedAsync(user);
                return;
            case "partner:trip_partner":
                var b = await services.GetRequiredService<IDeliveryBAL>().RequirePartnerAsync(user);
                if (b.KycStatus != "approved") throw new ForbiddenException("Your account is not approved yet");
                return;
        }
        if (rule.StartsWith("perm:", StringComparison.Ordinal))
        {
            await services.GetRequiredService<IAccessBAL>().RequireAsync(user, rule[5..]);
        }
    }
}

/// <summary>
/// The guard for a route that has no reference counterpart (so no row in route-guards.json), written in the same
/// words: public | optional | signed_in | admin | perm:&lt;code&gt; | seller | approved_seller | partner:&lt;rule&gt;.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class RouteGuardAttribute(string rule) : Attribute
{
    public string Rule { get; } = rule;
}
