using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using Utils;

namespace API.Service;

/// <summary>
/// Access tokens: short-lived HS256 JWTs with sub (user id), adm (staff), iat, exp and typ = "access", the same claims as
/// the reference version. The long-lived refresh token is an opaque HttpOnly cookie (see AccountBAL).
/// </summary>
public class TokenService(AppSettings settings)
{
    private SymmetricSecurityKey Key => new(Encoding.UTF8.GetBytes(settings.JwtSecret));

    public string CreateAccessToken(Guid userId, bool isAdmin)
    {
        var now = DateTimeOffset.UtcNow;
        var claims = new[]
        {
            new Claim("sub", userId.ToString()),
            new Claim("adm", isAdmin ? "true" : "false", ClaimValueTypes.Boolean),
            new Claim("iat", now.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
            new Claim("typ", "access"),
        };
        var token = new JwtSecurityToken(claims: claims, expires: now.AddMinutes(settings.AccessTokenMinutes).UtcDateTime,
            signingCredentials: new SigningCredentials(Key, SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    /// <summary>The token's (user id, issued at) when valid and not expired, else null.</summary>
    public (Guid UserId, long IssuedAt)? Validate(string token)
    {
        try
        {
            var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
            var principal = handler.ValidateToken(token, new TokenValidationParameters
            {
                ValidateIssuer = false,
                ValidateAudience = false,
                ValidateLifetime = true,
                ClockSkew = TimeSpan.Zero,
                IssuerSigningKey = Key,
                ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
            }, out _);
            if (principal.FindFirst("typ")?.Value != "access") return null;
            if (!Guid.TryParse(principal.FindFirst("sub")?.Value, out var id)) return null;
            long.TryParse(principal.FindFirst("iat")?.Value, out var iat);
            return (id, iat);
        }
        catch (Exception e) when (e is SecurityTokenException or ArgumentException)
        {
            return null;
        }
    }
}
