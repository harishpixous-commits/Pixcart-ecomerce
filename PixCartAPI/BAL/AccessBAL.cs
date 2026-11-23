using System.Diagnostics;
using System.Text.Json;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Staff roles, cached for a few seconds (every admin request checks one permission). Roles live in admin_roles and are
/// edited in Admin → Staff → Roles; the owner role always has every permission and cannot be edited.
/// </summary>
public class AccessBAL(AccountDAL accounts, SettingsDAL settings, AppSettings app) : IAccessBAL
{
    private static readonly object Gate = new();
    private static Dictionary<string, HashSet<string>> _roles = [];
    private static Dictionary<string, string> _names = [];
    private static long _loadedAt;
    private const double TtlSeconds = 10;

    public void Invalidate()
    {
        lock (Gate) _loadedAt = 0;
    }

    private async Task<Dictionary<string, HashSet<string>>> LoadRolesAsync()
    {
        lock (Gate)
        {
            if (!app.IsTest && _roles.Count > 0 && Stopwatch.GetElapsedTime(_loadedAt).TotalSeconds < TtlSeconds) return _roles;
        }
        var rows = (await accounts.GetRolesAsync()).ToList();
        if (rows.Count == 0)
        {
            var now = DateTimeFunctions.UtcNow();
            foreach (var (code, (name, desc, perms)) in Permissions.DefaultRoles)
            {
                await accounts.InsertRoleAsync(new AdminRoleModel
                {
                    Code = code, Name = name, Description = desc, IsLocked = code == Permissions.Owner,
                    Permissions = JsonSerializer.Serialize(Permissions.All.Where(perms.Contains)), CreatedAt = now, UpdatedAt = now,
                });
            }
            rows = (await accounts.GetRolesAsync()).ToList();
        }
        var roles = rows.ToDictionary(
            r => r.Code,
            r => r.Code == Permissions.Owner
                ? Permissions.All.ToHashSet()
                : (JsonHelper.Deserialize<string[]>(r.Permissions) ?? []).Where(Permissions.All.Contains).ToHashSet());
        roles.TryAdd(Permissions.Owner, Permissions.All.ToHashSet());
        lock (Gate)
        {
            _roles = roles;
            _names = rows.ToDictionary(r => r.Code, r => r.Name);
            _loadedAt = Stopwatch.GetTimestamp();
        }
        return roles;
    }

    public string RoleCode(UserModel user) => string.IsNullOrEmpty(user.AdminRole) ? Permissions.Owner : user.AdminRole;

    public async Task<string> RoleNameAsync(string code)
    {
        await LoadRolesAsync();
        if (_names.TryGetValue(code, out var n)) return n;
        return Permissions.DefaultRoles.TryGetValue(code, out var d) ? d.Name : System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(code.Replace('_', ' '));
    }

    public async Task<HashSet<string>> PermissionsForAsync(UserModel user)
    {
        if (!user.IsAdmin) return [];
        var roles = await LoadRolesAsync();
        return roles.TryGetValue(RoleCode(user), out var p) ? p : []; // a deleted role grants nothing
    }

    public async Task RequireAsync(UserModel user, string permission)
    {
        if (!Permissions.All.Contains(permission)) throw new ArgumentException($"Unknown permission {permission}");
        if (!user.IsAdmin) throw new ForbiddenException("Admin access required");
        if (!(await PermissionsForAsync(user)).Contains(permission)) throw new ForbiddenException($"Your role does not allow this ({permission})");
        if (await TwoStepMissingAsync(user))
            throw new AppException("Turn on two-step sign-in in My account to use the admin panel. The owner requires it for all staff.", "two_step_required", 403);
    }

    public async Task<bool> TwoStepMissingAsync(UserModel user)
    {
        if (user.TotpEnabled) return false;
        var auth = await settings.GetAsync("auth");
        return auth["staff_require_two_step"]?.GetValue<bool>() == true;
    }
}
