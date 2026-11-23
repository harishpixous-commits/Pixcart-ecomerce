using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Users, staff roles and seller accounts (the parts every request needs). The auth module adds the rest.</summary>
public partial class AccountDAL(IMySqlDapperHelper db)
{
    public Task<UserModel?> GetUserAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id });

    public Task<SellerModel?> GetSellerByUserAsync(Guid userId) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE user_id = @userId", new { userId });

    public Task<IEnumerable<AdminRoleModel>> GetRolesAsync() =>
        db.QueryAsync<AdminRoleModel>("SELECT * FROM admin_roles ORDER BY created_at");

    public Task InsertRoleAsync(AdminRoleModel r) =>
        db.ExecuteAsync(
            "INSERT IGNORE INTO admin_roles (code, name, description, permissions, is_locked, created_at, updated_at) " +
            "VALUES (@Code, @Name, @Description, CAST(@Permissions AS JSON), @IsLocked, @CreatedAt, @UpdatedAt)", r);
}
