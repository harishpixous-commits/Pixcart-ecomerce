using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Who may do what: staff roles and permissions, and the owner's two-step sign-in rule for staff.</summary>
public interface IAccessBAL
{
    /// <summary>The permissions of a staff member (empty for customers and sellers).</summary>
    Task<HashSet<string>> PermissionsForAsync(UserModel user);

    /// <summary>The role's code ("owner" for admins created before roles existed).</summary>
    string RoleCode(UserModel user);

    Task<string> RoleNameAsync(string code);

    /// <summary>Throws 403 unless the user is staff with the permission (and two-step sign-in when the owner requires it).</summary>
    Task RequireAsync(UserModel user, string permission);

    /// <summary>True when the owner requires two-step sign-in for staff and this person has not set it up.</summary>
    Task<bool> TwoStepMissingAsync(UserModel user);

    /// <summary>Forget cached roles (after a role is edited).</summary>
    void Invalidate();
}

/// <summary>The person making the current request (from the "Authorization: Bearer" access token).</summary>
public interface ICurrentUser
{
    /// <summary>The signed-in user, or null for visitors. Throws 401 when the token is expired or revoked.</summary>
    Task<UserModel?> GetAsync();

    /// <summary>The signed-in user; throws 401 for visitors.</summary>
    Task<UserModel> RequireAsync();

    /// <summary>The caller's seller account in any status; throws 403 when they have none.</summary>
    Task<SellerModel> RequireSellerAsync(bool approved = true);

    /// <summary>The client's IP address (rate limits, audit).</summary>
    string IpAddress { get; }

    string UserAgent { get; }
}
