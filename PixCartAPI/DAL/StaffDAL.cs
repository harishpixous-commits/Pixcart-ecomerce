using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Staff accounts and roles (Admin → Staff and roles).</summary>
public class StaffDAL(IMySqlDapperHelper db)
{
    public Task<AdminRoleModel?> GetRoleAsync(string code, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<AdminRoleModel>("SELECT * FROM admin_roles WHERE code = @code", new { code }, tx);

    /// <summary>Locked roles first, then by creation and name.</summary>
    public Task<IEnumerable<AdminRoleModel>> ListRolesAsync() =>
        db.QueryAsync<AdminRoleModel>("SELECT * FROM admin_roles ORDER BY is_locked DESC, created_at, name");

    /// <summary>The code of a role with this name (any case), other than <paramref name="except"/>.</summary>
    public Task<string?> RoleCodeByNameAsync(string name, string? except = null) =>
        db.QueryFirstOrDefaultAsync<string>(
            "SELECT code FROM admin_roles WHERE LOWER(name) = LOWER(@name) AND (@except IS NULL OR code <> @except) LIMIT 1", new { name, except });

    public Task InsertRoleAsync(AdminRoleModel r) =>
        db.ExecuteAsync(
            "INSERT INTO admin_roles (code, name, description, permissions, is_locked, created_at, updated_at) " +
            "VALUES (@Code, @Name, @Description, CAST(@Permissions AS JSON), @IsLocked, @CreatedAt, @UpdatedAt)", r);

    public Task UpdateRoleAsync(AdminRoleModel r) =>
        db.ExecuteAsync(
            "UPDATE admin_roles SET name = @Name, description = @Description, permissions = CAST(@Permissions AS JSON), updated_at = @UpdatedAt WHERE code = @Code", r);

    public Task DeleteRoleAsync(string code) => db.ExecuteAsync("DELETE FROM admin_roles WHERE code = @code", new { code });

    /// <summary>Staff per role code ("" counts as the owner role).</summary>
    public async Task<Dictionary<string, int>> RoleCountsAsync(IDbTransaction? tx = null)
    {
        var rows = await db.QueryAsync<(string Role, long N)>(
            "SELECT admin_role AS Role, COUNT(*) AS N FROM users WHERE is_admin = 1 GROUP BY admin_role", null, tx);
        var outp = new Dictionary<string, int>();
        foreach (var (role, n) in rows)
        {
            var code = string.IsNullOrEmpty(role) ? "owner" : role;
            outp[code] = outp.GetValueOrDefault(code) + (int)n;
        }
        return outp;
    }

    /// <summary>Active staff with the owner role (an empty role is the owner role).</summary>
    public async Task<long> ActiveOwnersAsync(IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM users WHERE is_admin = 1 AND is_active = 1 AND COALESCE(NULLIF(admin_role, ''), 'owner') = 'owner'", null, tx);

    public Task<IEnumerable<UserModel>> ListStaffAsync() =>
        db.QueryAsync<UserModel>("SELECT * FROM users WHERE is_admin = 1 ORDER BY created_at");

    /// <summary>Active, not deleted staff (who may be told about events).</summary>
    public Task<IEnumerable<UserModel>> ActiveStaffAsync(IDbTransaction? tx = null) =>
        db.QueryAsync<UserModel>("SELECT * FROM users WHERE is_admin = 1 AND is_active = 1 AND deleted_at IS NULL", null, tx);
}
