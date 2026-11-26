using System.Diagnostics;
using System.Text.RegularExpressions;
using Utils;

namespace API.Middleware;

/// <summary>
/// Gives every request an id (X-Request-ID: the caller's when it is 8-64 letters, digits or hyphens, otherwise a new
/// one), adds the security headers and logs method, path, status and time taken. The headers are added when the
/// response starts, so error answers (which clear the response first) carry them too.
/// API and media answers: the request id, nosniff, no framing, the referrer policy and, in production, HSTS.
/// Website pages: nosniff, framing by this site only (the admin's theme preview shows the shop in a frame), the
/// referrer policy and the permissions policy (microphone for the assistant's dictation, location for the delivery
/// partner app and "use my location").
/// </summary>
public partial class RequestContextMiddleware(RequestDelegate next, ILogger<RequestContextMiddleware> log, AppSettings settings)
{
    [GeneratedRegex("^[A-Za-z0-9-]{8,64}$")]
    private static partial Regex RequestIdRx();

    public async Task InvokeAsync(HttpContext ctx)
    {
        var id = ctx.Request.Headers["X-Request-ID"].ToString();
        if (!RequestIdRx().IsMatch(id)) id = Guid.NewGuid().ToString("N");
        var api = ctx.Request.Path.StartsWithSegments("/api") || ctx.Request.Path.StartsWithSegments("/media");
        ctx.Response.OnStarting(() =>
        {
            var h = ctx.Response.Headers;
            void Default(string name, string value)
            {
                if (!h.ContainsKey(name)) h[name] = value;
            }
            Default("X-Content-Type-Options", "nosniff");
            Default("Referrer-Policy", "strict-origin-when-cross-origin");
            if (api)
            {
                h["X-Request-ID"] = id;
                Default("X-Frame-Options", "DENY");
                if (settings.IsProduction) Default("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
            }
            else
            {
                Default("X-Frame-Options", "SAMEORIGIN");
                Default("Content-Security-Policy", "frame-ancestors 'self'");
                Default("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self)");
            }
            return Task.CompletedTask;
        });
        var started = Stopwatch.GetTimestamp();
        using (log.BeginScope(new Dictionary<string, object> { ["RequestId"] = id }))
        {
            await next(ctx);
            if (ctx.Request.Path.StartsWithSegments("/api") && !ctx.Request.Path.StartsWithSegments("/api/health"))
                log.LogInformation("{Method} {Path} -> {Status} in {Ms} ms", ctx.Request.Method, ctx.Request.Path, ctx.Response.StatusCode,
                    (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
    }
}
