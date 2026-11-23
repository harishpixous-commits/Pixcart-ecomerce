using System.Diagnostics;

namespace API.Middleware;

/// <summary>Gives every request an id (X-Request-ID, echoed back) and logs method, path, status and time taken.</summary>
public class RequestContextMiddleware(RequestDelegate next, ILogger<RequestContextMiddleware> log)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        var id = ctx.Request.Headers["X-Request-ID"].ToString();
        if (string.IsNullOrEmpty(id) || id.Length > 64) id = Guid.NewGuid().ToString("N")[..16];
        ctx.Response.Headers["X-Request-ID"] = id;
        var started = Stopwatch.GetTimestamp();
        using (log.BeginScope(new Dictionary<string, object> { ["RequestId"] = id }))
        {
            await next(ctx);
            if (ctx.Request.Path.StartsWithSegments("/api"))
                log.LogInformation("{Method} {Path} -> {Status} in {Ms} ms", ctx.Request.Method, ctx.Request.Path, ctx.Response.StatusCode,
                    (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
    }
}
