using System.Text.Json;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Model.DomainModel.Auth;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Admin → Staff: staff accounts, roles and the permission matrix (the reference version's routers/staff.py). Guards
/// against privilege escalation and lock-out: only an owner gives out the owner role or changes owners; a non-owner can
/// only grant permissions they hold and cannot edit their own role; the owner role always has every permission; at least
/// one active owner remains; a role that still has staff cannot be deleted.
/// </summary>
public interface IStaffBAL
{
    object PermissionCatalog();
    Task<object> ListRolesAsync();
    Task<Dictionary<string, object?>> CreateRoleAsync(UserModel admin, RoleIn body);
    Task<Dictionary<string, object?>> UpdateRoleAsync(UserModel admin, string code, RoleIn body);
    Task DeleteRoleAsync(UserModel admin, string code);
    Task<object> ListStaffAsync(UserModel admin);
    Task<object> AddStaffAsync(UserModel admin, StaffIn body);
    Task EditStaffAsync(UserModel admin, Guid userId, StaffPatchIn body);
}

/// <inheritdoc cref="IStaffBAL"/>
public partial class StaffBAL(
    StaffDAL dal, AccountDAL accounts, IAccessBAL access, IAuthSettingsBAL authSettings, IAuditBAL audit, IMySqlDapperHelper db) : IStaffBAL
{
    private const string Owner = Permissions.Owner;

    private bool IsOwner(UserModel u) => access.RoleCode(u) == Owner;

    private static string Collapse(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>The role with exactly this code: "Support" or "suppórt" is not the role "support".</summary>
    private async Task<AdminRoleModel> RoleAsync(string code) =>
        await dal.GetRoleAsync(code) is { } role && string.Equals(role.Code, code, StringComparison.Ordinal)
            ? role
            : throw new NotFoundException("Role");

    private static List<string> PermsOf(AdminRoleModel r)
    {
        if (r.Code == Owner) return [.. Permissions.All];
        var set = (JsonHelper.Deserialize<string[]>(r.Permissions) ?? []).ToHashSet();
        return Permissions.All.Where(set.Contains).ToList();
    }

    private static Dictionary<string, object?> RoleOut(AdminRoleModel r, IReadOnlyDictionary<string, int> counts) => new()
    {
        ["code"] = r.Code, ["name"] = r.Name, ["description"] = r.Description, ["permissions"] = PermsOf(r), ["is_locked"] = r.IsLocked || r.Code == Owner,
        ["staff_count"] = counts.GetValueOrDefault(r.Code, 0), ["updated_at"] = DateTimeFunctions.Iso(r.UpdatedAt),
    };

    public object PermissionCatalog() => new
    {
        items = Permissions.Catalog.Select(p => new { code = p.Code, label = p.Label, group = p.Group, description = p.Description, sensitive = p.Sensitive }),
    };

    public async Task<object> ListRolesAsync()
    {
        var counts = await dal.RoleCountsAsync();
        return new { items = (await dal.ListRolesAsync()).Select(r => RoleOut(r, counts)).ToList() };
    }

    private async Task<List<string>> CleanPermissionsAsync(UserModel admin, List<string> wanted)
    {
        var unknown = wanted.Where(p => !Permissions.All.Contains(p)).ToList();
        if (unknown.Count > 0) throw new AppException($"Unknown permission: {string.Join(", ", unknown)}", "unknown_permission");
        if (!IsOwner(admin))
        {
            var mine = await access.PermissionsForAsync(admin);
            var extra = wanted.Where(p => !mine.Contains(p)).ToList();
            if (extra.Count > 0) throw new ForbiddenException($"You can only give permissions you have yourself (not: {string.Join(", ", extra)})");
        }
        if (!wanted.Contains("dashboard")) wanted = ["dashboard", .. wanted]; // every staff member needs the overview to sign in
        var set = wanted.ToHashSet();
        return Permissions.All.Where(set.Contains).ToList();
    }

    [GeneratedRegex("[^a-z0-9]+")] private static partial Regex NonSlug();

    private static string Slug(string name)
    {
        var s = NonSlug().Replace(name.ToLowerInvariant(), "_").Trim('_');
        if (s.Length > 32) s = s[..32];
        return s.Length > 0 ? s : "role";
    }

    public async Task<Dictionary<string, object?>> CreateRoleAsync(UserModel admin, RoleIn body)
    {
        var perms = await CleanPermissionsAsync(admin, body.Permissions);
        var name = Collapse(body.Name!);
        if (await dal.RoleCodeByNameAsync(name) is not null) throw new ConflictException("A role with this name already exists", "role_exists");
        var code = Slug(name);
        var n = 2;
        while (await dal.GetRoleAsync(code) is not null)
        {
            var b = Slug(name);
            code = $"{(b.Length > 30 ? b[..30] : b)}_{n}";
            n++;
        }
        var now = DateTimeFunctions.UtcNow();
        var role = new AdminRoleModel
        {
            Code = code, Name = name, Description = body.Description.Trim(), Permissions = JsonSerializer.Serialize(perms), IsLocked = false, CreatedAt = now, UpdatedAt = now,
        };
        await dal.InsertRoleAsync(role);
        await audit.AuditAsync(admin, "role.create", "role", code, string.Join(",", perms));
        access.Invalidate();
        return RoleOut(role, new Dictionary<string, int>());
    }

    public async Task<Dictionary<string, object?>> UpdateRoleAsync(UserModel admin, string code, RoleIn body)
    {
        var role = await RoleAsync(code);
        if (role.IsLocked || role.Code == Owner) throw new ConflictException("The owner role always has every permission and cannot be edited", "role_locked");
        if (access.RoleCode(admin) == code && !IsOwner(admin)) throw new ForbiddenException("You cannot change your own role's permissions");
        var perms = await CleanPermissionsAsync(admin, body.Permissions);
        var name = Collapse(body.Name!);
        if (await dal.RoleCodeByNameAsync(name, code) is not null) throw new ConflictException("A role with this name already exists", "role_exists");
        var before = (JsonHelper.Deserialize<string[]>(role.Permissions) ?? []).ToHashSet();
        role.Name = name;
        role.Description = body.Description.Trim();
        role.Permissions = JsonSerializer.Serialize(perms);
        role.UpdatedAt = DateTimeFunctions.UtcNow();
        var added = perms.Where(p => !before.Contains(p)).Order(StringComparer.Ordinal);
        var removed = before.Where(p => !perms.Contains(p)).Order(StringComparer.Ordinal);
        await dal.UpdateRoleAsync(role);
        await audit.AuditAsync(admin, "role.update", "role", code, $"+{string.Join(",", added)} -{string.Join(",", removed)}");
        access.Invalidate();
        return RoleOut(role, await dal.RoleCountsAsync());
    }

    public async Task DeleteRoleAsync(UserModel admin, string code)
    {
        var role = await RoleAsync(code);
        if (role.IsLocked || role.Code == Owner) throw new ConflictException("The owner role cannot be deleted", "role_locked");
        var count = (await dal.RoleCountsAsync()).GetValueOrDefault(code, 0);
        if (count > 0) throw new ConflictException($"{count} staff member(s) still have this role. Move them to another role first.", "role_in_use");
        await dal.DeleteRoleAsync(code);
        await audit.AuditAsync(admin, "role.delete", "role", code, role.Name);
        access.Invalidate();
    }

    public async Task<object> ListStaffAsync(UserModel admin)
    {
        access.Invalidate();
        await access.PermissionsForAsync(admin); // loads (and seeds) the roles
        var roles = (await accounts.GetRolesAsync()).ToList();
        var names = roles.ToDictionary(r => r.Code, r => r.Name);
        var codes = roles.Select(r => r.Code).ToList();
        if (!codes.Contains(Owner)) codes.Add(Owner);
        var rows = await dal.ListStaffAsync();
        return new
        {
            can_manage_owners = IsOwner(admin),
            roles = codes.Select(c => new { code = c, name = names.GetValueOrDefault(c, c) }).ToList(),
            items = rows.Select(u => new
            {
                id = u.Id.ToString(), name = u.Name, email = u.Email, role = access.RoleCode(u), role_name = names.GetValueOrDefault(access.RoleCode(u), "Missing role"),
                is_active = u.IsActive, is_you = u.Id == admin.Id, totp_enabled = u.TotpEnabled, last_login_at = DateTimeFunctions.Iso(u.LastLoginAt),
                created_at = DateTimeFunctions.Iso(u.CreatedAt),
            }).ToList(),
        };
    }

    private async Task CheckAssignableAsync(UserModel admin, string code)
    {
        var role = await RoleAsync(code);
        if (code == Owner && !IsOwner(admin)) throw new ForbiddenException("Only an owner can make someone an owner");
        if (!IsOwner(admin))
        {
            var mine = await access.PermissionsForAsync(admin);
            if (PermsOf(role).Any(p => !mine.Contains(p))) throw new ForbiddenException("You can only give a role whose permissions you have yourself");
        }
    }

    public async Task<object> AddStaffAsync(UserModel admin, StaffIn body)
    {
        await authSettings.RequireStrongPasswordAsync(body.Password!);
        await CheckAssignableAsync(admin, body.Role!);
        var email = body.Email!.ToLowerInvariant();
        if (await accounts.EmailTakenAsync(email)) throw new ConflictException("An account with this email already exists", "email_taken");
        var now = DateTimeFunctions.UtcNow();
        var u = new UserModel
        {
            Id = Guid.NewGuid(), Email = email, Name = body.Name!.Trim(), PasswordHash = EncryptDecrypt.HashPassword(body.Password!), IsAdmin = true, IsActive = true,
            AdminRole = body.Role!, UiPrefs = "{}", CreatedAt = now, UpdatedAt = now,
        };
        await using var uow = await db.BeginAsync();
        await accounts.InsertUserAsync(u, uow.Transaction);
        await audit.AuditAsync(admin, "staff.create", "user", u.Id, $"{email} as {body.Role}", uow);
        await uow.CommitAsync();
        return new { id = u.Id.ToString() };
    }

    public async Task EditStaffAsync(UserModel admin, Guid userId, StaffPatchIn body)
    {
        var u = await accounts.GetUserAsync(userId);
        if (u is null || !u.IsAdmin) throw new NotFoundException("Staff member");
        if (access.RoleCode(u) == Owner && !IsOwner(admin)) throw new ForbiddenException("Only an owner can change another owner");
        if (u.Id == admin.Id && (body.IsActive == false || (!string.IsNullOrEmpty(body.Role) && body.Role != access.RoleCode(admin))))
            throw new ConflictException("You cannot change your own role or deactivate yourself", "self_lockout");
        var before = u.Copy();
        var changes = new List<string>();
        if (!string.IsNullOrEmpty(body.Role) && body.Role != access.RoleCode(u))
        {
            await CheckAssignableAsync(admin, body.Role);
            changes.Add($"role {access.RoleCode(u)}→{body.Role}");
            u.AdminRole = body.Role;
        }
        if (!string.IsNullOrEmpty(body.Name))
        {
            u.Name = body.Name.Trim();
            changes.Add("name");
        }
        if (body.ResetTwoStep)
        {
            if (!IsOwner(admin)) throw new ForbiddenException("Only an owner can reset two-step sign-in");
            u.TotpEnabled = false;
            u.TotpSecretEnc = null;
            changes.Add("two-step reset");
        }
        if (body.IsActive is { } active && active != u.IsActive)
        {
            u.IsActive = active;
            changes.Add(active ? "activated" : "deactivated");
        }
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        // sign them out everywhere; role changes need no sign-out: permissions are read on every request
        if (body.IsActive == false || body.ResetTwoStep) await accounts.RevokeAllSessionsAsync(u.Id, now, uow.Transaction);
        await accounts.SaveUserChangesAsync(before, u, now, uow.Transaction);
        if (await dal.ActiveOwnersAsync(uow.Transaction) == 0) throw new ConflictException("At least one active owner is needed", "last_owner");
        await audit.AuditAsync(admin, "staff.update", "user", u.Id, changes.Count > 0 ? string.Join("; ", changes) : "no change", uow);
        await uow.CommitAsync();
    }
}
