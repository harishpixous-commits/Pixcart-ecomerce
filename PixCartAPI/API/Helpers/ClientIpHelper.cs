using Utils;

namespace API.Helpers;

/// <summary>
/// Spoof-resistant client IP. X-Forwarded-For is trusted only when TrustProxyHeaders is on (behind IIS ARR or a load
/// balancer), and then the client is read TrustedProxyCount entries from the right.
/// </summary>
public static class ClientIpHelper
{
    public static string Get(HttpContext ctx, AppSettings settings)
    {
        var peer = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (!settings.TrustProxyHeaders) return Trim(peer);
        var parts = ctx.Request.Headers["X-Forwarded-For"].ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) return Trim(peer);
        var idx = Math.Max(0, parts.Length - Math.Max(1, settings.TrustedProxyCount));
        return Trim(string.IsNullOrEmpty(parts[idx]) ? peer : parts[idx]);
    }

    private static string Trim(string ip) => ip.Length > 64 ? ip[..64] : ip;
}
