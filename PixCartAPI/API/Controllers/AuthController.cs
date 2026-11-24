using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using API.Service;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
using Utils;

namespace API.Controllers;

/// <summary>Sign-in and account security (reference: routers/auth.py).</summary>
[ApiController]
[Route("api/auth")]
public class AuthController(IAuthBAL bal, ICurrentUser current, TokenService tokens, AppSettings app) : ControllerBase
{
    private void SetRefreshCookie(string token, int days) =>
        Response.Cookies.Append(app.RefreshCookieName, token, new CookieOptions
        {
            MaxAge = TimeSpan.FromDays(days), HttpOnly = true, Secure = app.CookieSecure,
            SameSite = SameSiteMode.Lax, Path = "/api/auth",
        });

    private void DeleteRefreshCookie() => Response.Cookies.Delete(app.RefreshCookieName, new CookieOptions { Path = "/api/auth" });

    private async Task<JsonObject> SessionBodyAsync(UserModel user)
    {
        var body = await bal.UserPayloadAsync(user);
        return new JsonObject { ["access_token"] = tokens.CreateAccessToken(user.Id, user.IsAdmin), ["user"] = body };
    }

    /// <summary>Reference: POST /api/auth/otp/request.</summary>
    [HttpPost("otp/request")]
    [Consumes("application/json")]
    public async Task<JsonObject> RequestOtp([FromBody] OtpRequestIn body) =>
        await bal.RequestOtpAsync(body.Phone, body.Purpose, body.ForSeller, current.IpAddress);

    /// <summary>Reference: GET /api/auth/options.</summary>
    [HttpGet("options")]
    public async Task<JsonObject> Options() => await bal.OptionsAsync();

    /// <summary>Reference: POST /api/auth/otp/verify.</summary>
    [HttpPost("otp/verify")]
    [Consumes("application/json")]
    public async Task<JsonObject> VerifyOtp([FromBody] OtpVerifyIn body)
    {
        var (user, token, days, isNew) = await bal.VerifyOtpAsync(body.Phone, body.Code, body.Purpose, body.Name,
            body.Email, body.AcceptTerms, body.MarketingOptIn, body.ForSeller, current.UserAgent);
        SetRefreshCookie(token, days);
        var result = await SessionBodyAsync(user);
        result["is_new"] = isNew;
        return result;
    }

    /// <summary>Reference: POST /api/auth/login.</summary>
    [HttpPost("login")]
    [Consumes("application/json")]
    public async Task<JsonObject> Login([FromBody] PasswordLoginIn body)
    {
        var (user, token, days) = await bal.PasswordLoginAsync(body.Email, body.Password, body.Totp,
            current.IpAddress, current.UserAgent);
        SetRefreshCookie(token, days);
        return await SessionBodyAsync(user);
    }

    /// <summary>Reference: POST /api/auth/password.</summary>
    [HttpPost("password")]
    [Consumes("application/json")]
    public async Task<JsonObject> ChangePassword([FromBody] PasswordChangeIn body)
    {
        await bal.ChangePasswordAsync(await current.RequireAsync(), body.CurrentPassword, body.NewPassword);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: POST /api/auth/totp/setup.</summary>
    [HttpPost("totp/setup")]
    public async Task<JsonObject> TotpSetup() => await bal.TotpSetupAsync(await current.RequireAsync());

    /// <summary>Reference: POST /api/auth/totp/enable.</summary>
    [HttpPost("totp/enable")]
    [Consumes("application/json")]
    public async Task<JsonObject> TotpEnable([FromBody] TotpCodeIn body)
    {
        await bal.TotpEnableAsync(await current.RequireAsync(), body.Code);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: POST /api/auth/totp/disable.</summary>
    [HttpPost("totp/disable")]
    [Consumes("application/json")]
    public async Task<JsonObject> TotpDisable([FromBody] TotpCodeIn body)
    {
        await bal.TotpDisableAsync(await current.RequireAsync(), body.Code, body.Password);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: POST /api/auth/refresh.</summary>
    [HttpPost("refresh")]
    [RequireCsrfHeader]
    public async Task<JsonObject> Refresh()
    {
        var raw = Request.Cookies[app.RefreshCookieName] ?? "";
        try
        {
            var (user, token, days) = await bal.RefreshAsync(raw, current.UserAgent);
            SetRefreshCookie(token, days);
            return await SessionBodyAsync(user);
        }
        catch (UnauthorizedException)
        {
            DeleteRefreshCookie();
            throw;
        }
    }

    /// <summary>Reference: POST /api/auth/logout.</summary>
    [HttpPost("logout")]
    [RequireCsrfHeader]
    public async Task<JsonObject> Logout()
    {
        await bal.LogoutAsync(Request.Cookies[app.RefreshCookieName]);
        DeleteRefreshCookie();
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: GET /api/auth/sessions.</summary>
    [HttpGet("sessions")]
    public async Task<JsonObject> Sessions() =>
        await bal.SessionsAsync(await current.RequireAsync(), Request.Cookies[app.RefreshCookieName]);

    /// <summary>Reference: POST /api/auth/sessions/sign-out-others.</summary>
    [HttpPost("sessions/sign-out-others")]
    [RequireCsrfHeader]
    public async Task<JsonObject> SignOutOthers() =>
        await bal.SignOutOthersAsync(await current.RequireAsync(), Request.Cookies[app.RefreshCookieName]);

    /// <summary>Reference: GET /api/auth/me.</summary>
    [HttpGet("me")]
    public async Task<JsonObject> Me() => await bal.UserPayloadAsync(await current.RequireAsync());

    /// <summary>Reference: PATCH /api/auth/me.</summary>
    [HttpPatch("me")]
    [Consumes("application/json")]
    public async Task<JsonObject> UpdateMe([FromBody] ProfileUpdateIn body) =>
        await bal.UpdateMeAsync(await current.RequireAsync(), body.Name, body.Email);
}

/// <summary>Reference: OtpRequest (purpose: signin | signup | any).</summary>
public record OtpRequestIn(
    [param: Required] string Phone,
    [param: RegularExpression("^(signin|signup|any)$")] string Purpose = "any",
    bool ForSeller = false);

/// <summary>Reference: OtpVerify.</summary>
public record OtpVerifyIn(
    [param: Required] string Phone,
    [param: Required, MinLength(4), MaxLength(8)] string Code,
    [param: RegularExpression("^(signin|signup|any)$")] string Purpose = "any",
    [param: MaxLength(120)] string Name = "",
    [param: EmailAddress] string? Email = null,
    bool AcceptTerms = false,
    bool MarketingOptIn = false,
    bool ForSeller = false);

/// <summary>Reference: PasswordLogin.</summary>
public record PasswordLoginIn(
    [param: Required, EmailAddress] string Email,
    [param: Required, MinLength(1), MaxLength(200)] string Password,
    [param: MaxLength(8)] string Totp = "");

/// <summary>Reference: PasswordChange.</summary>
public record PasswordChangeIn(
    [param: Required, MinLength(1), MaxLength(200)] string CurrentPassword,
    [param: Required, MinLength(8), MaxLength(200)] string NewPassword);

/// <summary>Reference: TotpCode.</summary>
public record TotpCodeIn(
    [param: Required, MinLength(6), MaxLength(8)] string Code,
    [param: MaxLength(200)] string Password = "");

/// <summary>Reference: ProfileUpdate.</summary>
public record ProfileUpdateIn(
    [param: MinLength(1), MaxLength(120)] string? Name,
    [param: EmailAddress] string? Email);
