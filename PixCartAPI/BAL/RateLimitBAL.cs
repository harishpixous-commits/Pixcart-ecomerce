using BAL.Interface;
using DAL;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IRateLimitBAL"/>
public class RateLimitBAL(RateLimitDAL dal) : IRateLimitBAL
{
    public async Task RateLimitAsync(string key, int limit, int windowSeconds, IUnitOfWork? uow = null)
    {
        var now = DateTimeFunctions.UtcNow();
        var since = now.AddSeconds(-windowSeconds);
        if (await dal.CountSinceAsync(key, since, uow?.Transaction) >= limit) throw new TooManyRequestsException();
        await dal.InsertAsync(key, now, uow?.Transaction);
    }

    public async Task<bool> IsOverAsync(string key, int limit, int windowSeconds) =>
        await dal.CountSinceAsync(key, DateTimeFunctions.UtcNow().AddSeconds(-windowSeconds), null) >= limit;

    public Task CountAsync(string key) => dal.InsertAsync(key, DateTimeFunctions.UtcNow(), null);

    public Task PruneRateLimitsAsync() => dal.DeleteBeforeAsync(DateTimeFunctions.UtcNow().AddDays(-1));
}
