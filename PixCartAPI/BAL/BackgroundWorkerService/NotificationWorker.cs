using BAL.Interface;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Utils;
using Utils.Interface;

namespace BAL.BackgroundWorkerService;

/// <summary>
/// Runs <paramref name="work"/> on a new scope only while holding a MySQL named lock, so with several servers one runs it
/// (the reference version's pg advisory locks in jobs.py).
/// </summary>
internal static class LockedJob
{
    public static async Task RunAsync(IServiceScopeFactory scopes, string lockName, ILogger log, Func<IServiceProvider, Task> work)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        await using var holder = await db.BeginAsync();
        if (await holder.ExecuteScalarAsync<long?>("SELECT GET_LOCK(@lockName, 0)", new { lockName }) != 1) return;
        try
        {
            await work(scope.ServiceProvider);
        }
        catch (Exception e)
        {
            log.LogError(e, "job {Job} failed", lockName);
        }
        finally
        {
            await holder.ExecuteScalarAsync<long?>("SELECT RELEASE_LOCK(@lockName)", new { lockName });
        }
    }
}

/// <summary>Sends waiting email, SMS and WhatsApp notifications every 30 seconds (the reference notify_job).</summary>
public class NotificationWorker(IServiceScopeFactory scopes, ILogger<NotificationWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        do
        {
            await LockedJob.RunAsync(scopes, "pixcart_notify", log, async sp =>
            {
                var notify = sp.GetRequiredService<INotifyBAL>();
                await notify.DispatchPendingAsync();
                notify.FlushPush();
            });
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}

/// <summary>
/// Every 6 hours: deletes rate-limit attempts older than a day and one-time codes older than two days (the sign-in part
/// of the reference cleanup_job; other modules add their own cleanup).
/// </summary>
public class AuthCleanupWorker(IServiceScopeFactory scopes, ILogger<AuthCleanupWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(6));
        do
        {
            await LockedJob.RunAsync(scopes, "pixcart_auth_cleanup", log, async sp =>
            {
                await sp.GetRequiredService<IRateLimitBAL>().PruneRateLimitsAsync();
                await sp.GetRequiredService<AccountDAL>().DeleteChallengesBeforeAsync(DateTimeFunctions.UtcNow().AddDays(-2));
            });
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
