using BAL.Interface;
using Microsoft.AspNetCore.Mvc.Filters;
using Utils;

namespace API.Infrastructure;

/// <summary>The endpoint needs a signed-in user (any kind). Same as the reference version's CurrentUser.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public class SignedInAttribute : Attribute, IAsyncAuthorizationFilter
{
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context) =>
        await context.HttpContext.RequestServices.GetRequiredService<ICurrentUser>().RequireAsync();
}

/// <summary>
/// The endpoint needs staff with this permission (Admin → Staff → Roles), and two-step sign-in when the owner requires
/// it. <c>[Perm("orders")]</c> is the reference version's <c>Perm("orders")</c>.
/// </summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public class PermAttribute(string permission) : Attribute, IAsyncAuthorizationFilter
{
    public string Permission { get; } = permission;

    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        var services = context.HttpContext.RequestServices;
        var user = await services.GetRequiredService<ICurrentUser>().RequireAsync();
        await services.GetRequiredService<IAccessBAL>().RequireAsync(user, Permission);
    }
}

/// <summary>The endpoint needs any staff account (no particular permission).</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public class AdminOnlyAttribute : Attribute, IAsyncAuthorizationFilter
{
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        var user = await context.HttpContext.RequestServices.GetRequiredService<ICurrentUser>().RequireAsync();
        if (!user.IsAdmin) throw new ForbiddenException("Admin access required");
    }
}

/// <summary>The endpoint needs a seller account: approved by default, or any status with Approved = false (onboarding).</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public class SellerAttribute : Attribute, IAsyncAuthorizationFilter
{
    public bool Approved { get; set; } = true;

    public async Task OnAuthorizationAsync(AuthorizationFilterContext context) =>
        await context.HttpContext.RequestServices.GetRequiredService<ICurrentUser>().RequireSellerAsync(Approved);
}

/// <summary>
/// Cookie-authenticated endpoints (refresh, sign out) need the "X-Requested-With" header, which a cross-site form cannot
/// send: protection against cross-site request forgery.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public class RequireCsrfHeaderAttribute : Attribute, IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext context)
    {
        Check(context.HttpContext);
    }

    /// <summary>The same check, for endpoints that must first resolve the signed-in user (401 before 403).</summary>
    public static void Check(HttpContext ctx)
    {
        // same rule and error as the reference version: the header must be "pixcart"
        if (ctx.Request.Headers["X-Requested-With"].ToString() != "pixcart")
            throw new ForbiddenException("Missing request header");
    }
}
