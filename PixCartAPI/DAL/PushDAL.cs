using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>The <c>push_tokens</c> table: devices (phones and browsers) that receive push notifications.</summary>
public class PushDAL(IMySqlDapperHelper db)
{
    public Task<PushTokenModel?> GetByTokenAsync(string token) =>
        db.QueryFirstOrDefaultAsync<PushTokenModel>("SELECT * FROM push_tokens WHERE token = @token", new { token });

    public Task InsertAsync(PushTokenModel t) =>
        db.ExecuteAsync(
            "INSERT INTO push_tokens (user_id, token, platform, app, created_at, last_seen_at, id) VALUES (@UserId, @Token, @Platform, @App, @CreatedAt, @LastSeenAt, @Id)", t);

    public Task UpdateAsync(PushTokenModel t) =>
        db.ExecuteAsync("UPDATE push_tokens SET user_id = @UserId, platform = @Platform, app = @App, last_seen_at = @LastSeenAt WHERE id = @Id", t);

    public async Task<long> CountForUserAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM push_tokens WHERE user_id = @userId", new { userId });

    /// <summary>Removes the user's least recently seen devices.</summary>
    public Task<int> DeleteOldestAsync(Guid userId, long count) =>
        db.ExecuteAsync(
            "DELETE FROM push_tokens WHERE id IN (SELECT id FROM (SELECT id FROM push_tokens WHERE user_id = @userId ORDER BY last_seen_at LIMIT @count) AS old)",
            new { userId, count });

    public Task<int> DeleteForUserAsync(Guid userId, string token) =>
        db.ExecuteAsync("DELETE FROM push_tokens WHERE token = @token AND user_id = @userId", new { userId, token });

    public Task<IEnumerable<string>> TokensForUserAsync(Guid userId) =>
        db.QueryAsync<string>("SELECT token FROM push_tokens WHERE user_id = @userId", new { userId });

    public Task<int> DeleteTokensAsync(IEnumerable<string> tokens) =>
        db.ExecuteAsync("DELETE FROM push_tokens WHERE token IN @tokens", new { tokens });

    public Task<IEnumerable<PushTokenModel>> AllAsync() => db.QueryAsync<PushTokenModel>("SELECT * FROM push_tokens");
}
