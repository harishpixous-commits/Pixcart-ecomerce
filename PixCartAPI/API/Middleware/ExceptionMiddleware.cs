using System.Text.Json;
using Utils;

namespace API.Middleware;

/// <summary>
/// Turns errors into the API's error shape: {"error": {"code", "message", "fields"}}. Expected failures
/// (<see cref="AppException"/>) keep their status and code; anything else is logged and answered with 500 "server_error"
/// (no internal details are sent).
/// </summary>
public class ExceptionMiddleware(RequestDelegate next, ILogger<ExceptionMiddleware> log)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        try
        {
            await next(ctx);
        }
        catch (AppException e)
        {
            await Write(ctx, e.StatusCode, e.Code, e.Message, e.Fields);
        }
        catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested)
        {
            // the browser went away
        }
        catch (BadHttpRequestException e)
        {
            await Write(ctx, e.StatusCode, "bad_request", "The request could not be read", null);
        }
        catch (Exception e)
        {
            log.LogError(e, "Unhandled error on {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            await Write(ctx, 500, "server_error", "Something went wrong. Please try again.", null);
        }
    }

    public static async Task Write(HttpContext ctx, int status, string code, string message, IDictionary<string, string>? fields)
    {
        if (ctx.Response.HasStarted) return;
        ctx.Response.Clear();
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        var body = new { error = new { code, message, fields = fields ?? new Dictionary<string, string>() } };
        await ctx.Response.WriteAsync(JsonSerializer.Serialize(body, JsonHelper.Options));
    }
}
