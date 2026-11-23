using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>The <c>addresses</c> table (customers' saved delivery addresses; deleted ones are kept, marked is_deleted).</summary>
public class AddressDAL(IMySqlDapperHelper db)
{
    public Task<AddressModel?> GetAsync(Guid id, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<AddressModel>("SELECT * FROM addresses WHERE id = @id", new { id }, tx);

    /// <summary>The user's addresses: the default first, then the newest.</summary>
    public Task<IEnumerable<AddressModel>> ListAsync(Guid userId) =>
        db.QueryAsync<AddressModel>(
            "SELECT * FROM addresses WHERE user_id = @userId AND is_deleted = 0 ORDER BY is_default DESC, created_at DESC", new { userId });

    /// <summary>The user's addresses for staff screens: the default first, then the oldest.</summary>
    public Task<IEnumerable<AddressModel>> ListOldestFirstAsync(Guid userId) =>
        db.QueryAsync<AddressModel>(
            "SELECT * FROM addresses WHERE user_id = @userId AND is_deleted = 0 ORDER BY is_default DESC, created_at", new { userId });

    public async Task<long> CountAsync(Guid userId, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM addresses WHERE user_id = @userId AND is_deleted = 0", new { userId }, tx);

    public Task ClearDefaultAsync(Guid userId, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE addresses SET is_default = 0 WHERE user_id = @userId", new { userId }, tx);

    public Task InsertAsync(AddressModel a, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO addresses (user_id, full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default, is_deleted, lat, lng, " +
            "label, instructions, id, created_at, updated_at) VALUES (@UserId, @FullName, @Phone, @Line1, @Line2, @Landmark, @City, @StateCode, @Pincode, " +
            "@Kind, @IsDefault, @IsDeleted, @Lat, @Lng, @Label, @Instructions, @Id, @CreatedAt, @UpdatedAt)", a, tx);

    public Task UpdateAsync(AddressModel a, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE addresses SET full_name = @FullName, phone = @Phone, line1 = @Line1, line2 = @Line2, landmark = @Landmark, city = @City, " +
            "state_code = @StateCode, pincode = @Pincode, kind = @Kind, is_default = @IsDefault, is_deleted = @IsDeleted, lat = @Lat, lng = @Lng, " +
            "label = @Label, instructions = @Instructions, updated_at = @UpdatedAt WHERE id = @Id", a, tx);

    public Task<AddressModel?> NewestAsync(Guid userId, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<AddressModel>(
            "SELECT * FROM addresses WHERE user_id = @userId AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1", new { userId }, tx);

    /// <summary>Right to erasure: every address of the user is blanked and marked deleted.</summary>
    public Task AnonymiseAllAsync(Guid userId, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE addresses SET is_deleted = 1, full_name = 'Deleted', phone = '0000000000', line1 = 'Deleted', line2 = '', landmark = '', updated_at = UTC_TIMESTAMP(6) " +
            "WHERE user_id = @userId", new { userId }, tx);
}
