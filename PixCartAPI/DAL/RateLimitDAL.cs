using System.Data;
using Utils.Interface;

namespace DAL;

/// <summary>The <c>rate_limit_events</c> table: one row per counted attempt (fixed-window limits shared by every server).</summary>
public class RateLimitDAL(IMySqlDapperHelper db)
{
    public async Task<long> CountSinceAsync(string key, DateTime since, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM rate_limit_events WHERE `key` = @key AND created_at >= @since", new { key, since }, tx);

    public Task InsertAsync(string key, DateTime at, IDbTransaction? tx = null) =>
        db.ExecuteAsync("INSERT INTO rate_limit_events (`key`, created_at) VALUES (@key, @at)", new { key, at }, tx);

    public Task<int> DeleteBeforeAsync(DateTime before) =>
        db.ExecuteAsync("DELETE FROM rate_limit_events WHERE created_at < @before", new { before });
}
