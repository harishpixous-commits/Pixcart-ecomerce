using Utils;

namespace API.Middleware;

/// <summary>
/// The answers for API and media paths that no route serves: 404 <c>{"detail":"Not Found"}</c> when nothing has the
/// path, and 405 <c>{"detail":"Method Not Allowed"}</c> (with Allow) when the path exists for other methods. Answers
/// the application wrote itself (errors included) are left alone.
/// </summary>
public sealed class UnmatchedRouteMiddleware(RequestDelegate next, AppSettings settings)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        await next(ctx);
        if (ctx.Response.HasStarted) return;
        var path = ctx.Request.Path;
        if (!path.StartsWithSegments("/api") && !path.StartsWithSegments(settings.MediaBaseUrl)) return;
        if (ctx.Response.StatusCode == StatusCodes.Status405MethodNotAllowed) await DetailAsync(ctx, 405, "Method Not Allowed");
        else if (ctx.Response.StatusCode == StatusCodes.Status404NotFound && ctx.GetEndpoint() is null) await DetailAsync(ctx, 404, "Not Found");
    }

    private static Task DetailAsync(HttpContext ctx, int status, string text)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        return ctx.Response.WriteAsync($$"""{"detail":"{{text}}"}""");
    }
}
