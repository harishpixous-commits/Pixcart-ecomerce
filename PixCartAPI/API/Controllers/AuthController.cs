using API.Infrastructure;
using API.Service;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Auth;
using Utils;

namespace API.Controllers;

/// <summary>Sign-in, sessions and the profile (/api/auth): the reference routers/auth.py.</summary>
[ApiController]
public class AuthController(IAuthBAL auth, ICurrentUser me, TokenService tokens, AppSettings settings) : ControllerBase
{
    private string? CookieToken => Request.Cookies[settings.RefreshCookieName];

    /// <summary>The refresh cookie (HttpOnly, SameSite=lax, path /api/auth).</summary>
    private void SetRefreshCookie(string token, int days) =>
        Response.Headers.Append("Set-Cookie",
            $"{settings.RefreshCookieName}={token}; HttpOnly; Max-Age={days * 86400}; Path=/api/auth; SameSite=lax{(settings.CookieSecure ? "; Secure" : "")}");

    private void DeleteRefreshCookie() =>
        Response.Headers.Append("Set-Cookie",
            $"{settings.RefreshCookieName}=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/api/auth; SameSite=lax");

    private Dictionary<string, object?> SessionAnswer(IssuedSession s)
    {
        SetRefreshCookie(s.RefreshToken, s.Days);
        return new Dictionary<string, object?> { ["access_token"] = tokens.CreateAccessToken(s.User.Id, s.User.IsAdmin), ["user"] = s.UserPayload };
    }

    [HttpPost("/api/auth/otp/request")]
    public Task<Dictionary<string, object?>> RequestOtp([FromBody] OtpRequestIn body) => auth.RequestOtpAsync(body);

    [HttpGet("/api/auth/options")]
    public Task<Dictionary<string, object?>> Options() => auth.OptionsAsync();

    [HttpPost("/api/auth/otp/verify")]
    public async Task<Dictionary<string, object?>> VerifyOtp([FromBody] OtpVerifyIn body)
    {
        var (session, isNew) = await auth.VerifyOtpAsync(body);
        var outp = SessionAnswer(session);
        outp["is_new"] = isNew;
        return outp;
    }

    [HttpPost("/api/auth/login")]
    public async Task<Dictionary<string, object?>> Login([FromBody] PasswordLoginIn body) => SessionAnswer(await auth.PasswordLoginAsync(body));

    [HttpPost("/api/auth/password"), SignedIn]
    public async Task<object> ChangePassword([FromBody] PasswordChangeIn body)
    {
        await auth.ChangePasswordAsync(await me.RequireAsync(), body);
        return new { ok = true };
    }

    [HttpPost("/api/auth/totp/setup"), SignedIn]
    public async Task<object> TotpSetup() => await auth.TotpSetupAsync(await me.RequireAsync());

    [HttpPost("/api/auth/totp/enable"), SignedIn]
    public async Task<object> TotpEnable([FromBody] TotpCodeIn body)
    {
        await auth.TotpEnableAsync(await me.RequireAsync(), body);
        return new { ok = true };
    }

    [HttpPost("/api/auth/totp/disable"), SignedIn]
    public async Task<object> TotpDisable([FromBody] TotpCodeIn body)
    {
        await auth.TotpDisableAsync(await me.RequireAsync(), body);
        return new { ok = true };
    }

    [HttpPost("/api/auth/refresh"), RequireCsrfHeader]
    public async Task<IActionResult> Refresh()
    {
        try
        {
            return Ok(SessionAnswer(await auth.RefreshAsync(CookieToken)));
        }
        catch (RefreshRefusedException e)
        {
            // answered here, not by the error middleware, so the response keeps its headers; the cookie stays as it is
            return new ObjectResult(new { error = new { code = e.Code, message = e.Message, fields = new Dictionary<string, string>() } }) { StatusCode = 401 };
        }
    }

    [HttpPost("/api/auth/logout"), RequireCsrfHeader]
    public async Task<object> Logout()
    {
        await auth.LogoutAsync(CookieToken);
        DeleteRefreshCookie();
        return new { ok = true };
    }

    [HttpGet("/api/auth/sessions"), SignedIn]
    public async Task<object> Sessions() => await auth.SessionsAsync(await me.RequireAsync(), CookieToken);

    [HttpPost("/api/auth/sessions/sign-out-others")]
    public async Task<object> SignOutOthers()
    {
        var user = await me.RequireAsync(); // 401 before the header check, like the reference
        RequireCsrfHeaderAttribute.Check(HttpContext);
        return new { signed_out = await auth.SignOutOthersAsync(user, CookieToken) };
    }

    [HttpGet("/api/auth/me"), SignedIn]
    public async Task<object> Me() => await auth.UserPayloadAsync(await me.RequireAsync());

    [HttpPatch("/api/auth/me"), SignedIn]
    public async Task<object> UpdateMe([FromBody] ProfileUpdateIn body) => await auth.UpdateMeAsync(await me.RequireAsync(), body);
}
