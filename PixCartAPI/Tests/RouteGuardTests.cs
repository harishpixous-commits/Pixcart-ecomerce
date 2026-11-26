using System.Text.RegularExpressions;
using API.Infrastructure;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>
/// The sign-in and permission rule of every route matches the reference API (route-guards.json, generated from its
/// FastAPI dependencies by tools/schema/route_guards.py) and is applied before the request is read, so a visitor always
/// gets 401 and a customer 403, never a 404/415/422 that would reveal the route's input rules first.
/// </summary>
public partial class RouteGuardTests(ApiFactory f) : ApiTest(f)
{
    [GeneratedRegex(@"\{[^}]+\}")]
    private static partial Regex Param();

    private List<(string Method, string Template, ControllerActionDescriptor Action)> Routes() =>
        Factory.Services.GetRequiredService<IActionDescriptorCollectionProvider>().ActionDescriptors.Items
            .OfType<ControllerActionDescriptor>()
            .Where(a => a.AttributeRouteInfo?.Template is { Length: > 0 })
            .SelectMany(a => (a.ActionConstraints ?? []).OfType<Microsoft.AspNetCore.Mvc.ActionConstraints.HttpMethodActionConstraint>()
                .SelectMany(c => c.HttpMethods).Select(m => (m, a.AttributeRouteInfo!.Template!, a)))
            .ToList();

    [Fact]
    public void Every_route_has_its_rule_and_every_rule_has_a_route()
    {
        var routes = Routes();
        Assert.NotEmpty(routes);
        var unguarded = routes
            .Where(r => RouteGuardFilter.RuleFor(r.Method, r.Template) is null
                        && r.Action.MethodInfo.GetCustomAttributes(typeof(RouteGuardAttribute), false).Length == 0)
            .Select(r => r.Method + " /" + r.Template).ToList();
        Assert.True(unguarded.Count == 0, "routes without a rule:\n" + string.Join("\n", unguarded));

        var ours = routes.Select(r => RouteGuardFilter.Key(r.Method, r.Template)).ToHashSet();
        var missing = RouteGuardFilter.All.Keys.Where(k => !ours.Contains(k)).ToList();
        Assert.True(missing.Count == 0, "rules whose route is missing here:\n" + string.Join("\n", missing));
    }

    [Fact]
    public async Task Visitors_get_401_and_customers_403_on_every_guarded_route_before_any_input_check()
    {
        var customer = await LoginPhone("9765000001", "Guard Probe");
        var visitor = Factory.Browser();
        var wrong = new List<string>();
        foreach (var (key, rule) in RouteGuardFilter.All)
        {
            if (rule is "public" or "optional") continue;
            var method = key[..key.IndexOf(' ')];
            var path = key[(key.IndexOf(' ') + 1)..].Replace("{}", Guid.NewGuid().ToString());
            var http = new HttpMethod(method);
            var anon = await visitor.SendAsync(http, path, method is "POST" or "PUT" or "PATCH" ? new { } : null);
            if (anon.Status != 401) wrong.Add($"visitor {anon.Status} {key} ({rule})");
            // a plain customer: staff, seller and delivery-partner routes refuse; signed-in routes may answer
            if (rule == "signed_in") continue;
            var cust = await visitor.SendAsync(http, path, method is "POST" or "PUT" or "PATCH" ? new { } : null, customer.Token);
            // the reference answers 404 "Register as a delivery partner first" to a customer on partner routes
            var refused = rule.StartsWith("partner:") ? cust.Status == 404 && cust.ErrorCode == "not_registered" : cust.Status is 401 or 403;
            if (!refused) wrong.Add($"customer {cust.Status} {key} ({rule}) {cust.Text[..Math.Min(100, cust.Text.Length)]}");
        }
        Assert.True(wrong.Count == 0, string.Join("\n", wrong));
    }

    [Fact]
    public async Task Upload_routes_refuse_visitors_before_checking_the_upload()
    {
        var visitor = Factory.Browser();
        foreach (var path in new[] { "/api/admin/media", "/api/admin/products/images", "/api/admin/shop-app", "/api/admin/delivery/app" })
        {
            var r = await visitor.Post(path, new { });
            Assert.True(r.Status == 401, $"{path}: {r}");
        }
    }

    [Fact]
    public async Task An_ai_draft_action_outside_apply_or_discard_is_a_422_after_sign_in()
    {
        var visitor = Factory.Browser();
        var path = $"/api/admin/ai/runs/{Guid.NewGuid()}/zzz";
        Assert.Equal(401, (await visitor.Post(path, new { })).Status);
        var admin = await Admin();
        var r = await admin.Post(path, new { });
        Assert.True(r.Status == 422, r.ToString());
        Assert.Equal("validation_error", r.ErrorCode);
        Assert.Equal("Action: must be one of: 'apply' or 'discard'", r.ErrorMessage);
        Assert.Equal("must be one of: 'apply' or 'discard'", r.Json["error"]!["fields"]!["action"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_extra_return_assign_route_needs_the_delivery_permission()
    {
        var customer = await LoginPhone("9765000002", "Guard Probe");
        var r = await customer.Post("/api/admin/delivery/returns/assign", new { });
        Assert.True(r.Status == 403, r.ToString());
    }
}
