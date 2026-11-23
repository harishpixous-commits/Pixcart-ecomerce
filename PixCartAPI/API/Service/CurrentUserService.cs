using API.Helpers;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace API.Service;

/// <summary>The person behind the current request, resolved once per request from the bearer token.</summary>
public class CurrentUserService(IHttpContextAccessor http, TokenService tokens, AccountDAL accounts, AppSettings settings) : ICurrentUser
{
    private bool _resolved;
    private UserModel? _user;
    private SellerModel? _seller;

    private HttpContext Ctx => http.HttpContext ?? throw new InvalidOperationException("No request");

    public string IpAddress => ClientIpHelper.Get(Ctx, settings);

    public string UserAgent
    {
        get
        {
            var ua = Ctx.Request.Headers.UserAgent.ToString();
            return ua.Length > 300 ? ua[..300] : ua;
        }
    }

    public async Task<UserModel?> GetAsync()
    {
        if (_resolved) return _user;
        var auth = Ctx.Request.Headers.Authorization.ToString();
        if (!auth.StartsWith("bearer ", StringComparison.OrdinalIgnoreCase))
        {
            _resolved = true;
            return null;
        }
        var payload = tokens.Validate(auth[7..].Trim()) ?? throw new UnauthorizedException("Your session has expired. Please sign in again.");
        var user = await accounts.GetUserAsync(payload.UserId);
        if (user is null || !user.IsActive) throw new UnauthorizedException("This account is not active");
        // signed out of other devices after this token was issued: this device must sign in again
        if (user.SessionsValidAfter is { } after && payload.IssuedAt < new DateTimeOffset(DateTime.SpecifyKind(after, DateTimeKind.Utc)).ToUnixTimeSeconds())
            throw new UnauthorizedException("Your session has expired. Please sign in again.");
        _user = user;
        _resolved = true;
        return user;
    }

    public async Task<UserModel> RequireAsync() => await GetAsync() ?? throw new UnauthorizedException();

    public async Task<SellerModel> RequireSellerAsync(bool approved = true)
    {
        var user = await RequireAsync();
        _seller ??= await accounts.GetSellerByUserAsync(user.Id) ?? throw new ForbiddenException("Register as a seller first");
        if (approved && _seller.Status != "approved") throw new ForbiddenException("Your seller account is not approved yet");
        return _seller;
    }
}
