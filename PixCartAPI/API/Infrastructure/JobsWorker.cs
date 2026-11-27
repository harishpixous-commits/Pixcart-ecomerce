namespace API.Infrastructure;

using BAL;
using BAL.Interface;
using DAL;
using Utils;
using Utils.Interface;

/// <summary>
/// Scheduled background jobs (reference: jobs.py) with the same cadences. Each run takes a MySQL named lock so a
/// second instance skips instead of double-running; a failed run is logged and the next one still happens. Every
/// provider call a job makes goes through the same fail-closed gateway clients as request handling, so jobs stay
/// on the local mock in this environment.
/// </summary>
public sealed class JobsWorker(IServiceScopeFactory scopes, AppSettings app, ILogger<JobsWorker> log) : BackgroundService
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    private sealed record Job(string Name, Func<IServiceProvider, Task<int>> Run, Func<DateTime, DateTime> Next);

    private static Func<DateTime, DateTime> Every(TimeSpan interval) => now => now + interval;

    private static Func<DateTime, DateTime> DailyAtUtc(int hour, int minute) => now =>
    {
        var next = now.Date.AddHours(hour).AddMinutes(minute);
        return next <= now ? next.AddDays(1) : next;
    };

    private static Func<DateTime, DateTime> DailyAtIst(int hour, int minute) => now =>
    {
        var ist = now + Ist;
        var next = ist.Date.AddHours(hour).AddMinutes(minute);
        if (next <= ist) next = next.AddDays(1);
        return next - Ist;
    };

    private static Func<DateTime, DateTime> WeeklyAtIst(DayOfWeek day, int hour, int minute) => now =>
    {
        var next = DailyAtIst(hour, minute)(now);
        var add = ((int)day - (int)(next + Ist).DayOfWeek + 7) % 7;
        return next.AddDays(add);
    };

    private static List<Job> Jobs() =>
    [
        new("delivery_sweep", async sp => { await sp.GetRequiredService<IDeliveryFleetBAL>().SweepExpiredAsync(); return 0; },
            Every(TimeSpan.FromSeconds(10))),
        new("delivery_alerts", async sp => await sp.GetRequiredService<IDeliveryFleetBAL>().StuckCheckAsync(),
            Every(TimeSpan.FromMinutes(1))),
        new("expire_unpaid", async sp => await sp.GetRequiredService<IOrdersBAL>().ExpireUnpaidOrdersAsync(),
            Every(TimeSpan.FromMinutes(2))),
        new("retry_refunds", async sp =>
        {
            var ids = await sp.GetRequiredService<IOrdersBAL>().PendingRefundIdsAsync();
            if (ids.Count > 0) sp.GetRequiredService<IRefundQueue>().Enqueue(ids);
            return ids.Count;
        }, Every(TimeSpan.FromMinutes(5))),
        new("cleanup", async sp =>
        {
            await sp.GetRequiredService<RateLimitBAL>().PruneRateLimitsAsync();
            var n = await sp.GetRequiredService<AccountDAL>().DeleteOldOtpsAsync(DateTimeFunctions.UtcNow().AddDays(-2));
            // Reference: cleanup_job — sponsored-product impressions whose click links have expired (48h),
            // AI assistant uploads kept 7 days, stale pending action proposals expire after an hour.
            var db = sp.GetRequiredService<IMySqlDapperHelper>();
            await db.ExecuteAsync("DELETE FROM ad_impressions WHERE created_at < UTC_TIMESTAMP(6) - INTERVAL 48 HOUR");
            await db.ExecuteAsync("DELETE FROM assistant_uploads WHERE expires_at < UTC_TIMESTAMP(6)");
            n += await db.ExecuteAsync(
                "UPDATE assistant_actions SET status = 'expired' WHERE status = 'pending' AND created_at < UTC_TIMESTAMP(6) - INTERVAL 1 HOUR");
            return n;
        }, Every(TimeSpan.FromHours(6))),
        new("unconfirmed", async sp => await sp.GetRequiredService<IOrdersBAL>().CancelUnconfirmedAsync(),
            Every(TimeSpan.FromMinutes(30))),
        new("payouts", async sp => await sp.GetRequiredService<IPayoutsBAL>().RunScheduledAsync(),
            DailyAtIst(10, 0)),
        new("low_stock", async sp => await sp.GetRequiredService<IInventoryBAL>().LowStockNotifyAsync(),
            DailyAtUtc(3, 0)),
        new("deals", async sp => await sp.GetRequiredService<IDealSync>().SyncAsync(),
            Every(TimeSpan.FromMinutes(1))),
        // Reference: jobs.notify_job (every 30 seconds) — the email/SMS/WhatsApp outbox dispatcher.
        new("notify", async sp => await sp.GetRequiredService<INotifyDispatchBAL>().DispatchPendingAsync(),
            Every(TimeSpan.FromSeconds(30))),
        // Reference: jobs.ads_billing_job (hourly).
        new("ads_billing", async sp => await sp.GetRequiredService<IAdsBAL>().BillAsync(),
            Every(TimeSpan.FromHours(1))),
        // Reference: jobs.alerts_job (every 10 minutes) — back-in-stock and wishlist price-drop alerts.
        new("alerts", async sp =>
            await sp.GetRequiredService<IEngagementBAL>().SendStockAlertsAsync() +
            await sp.GetRequiredService<IEngagementBAL>().SendPriceDropsAsync(),
            Every(TimeSpan.FromMinutes(10))),
        // Abandoned-cart reminders (Admin → Growth; off unless switched on).
        new("cart_reminders", async sp => await CartReminders.SendDueAsync(sp.GetRequiredService<IMySqlDapperHelper>(), sp.GetRequiredService<ICatalogNotifyBAL>()),
            Every(TimeSpan.FromMinutes(30))),
        // Scheduled segment campaigns (Admin → Growth; sent when their time comes).
        new("campaigns", async sp => await SegmentCampaigns.SendDueAsync(sp.GetRequiredService<IMySqlDapperHelper>(), sp.GetRequiredService<ICatalogNotifyBAL>()),
            Every(TimeSpan.FromMinutes(5))),
        // Review reminders: one in-app note per delivered package after a few days (Admin → Growth; off unless switched on).
        new("review_reminders", async sp => await ReviewReminders.SendDueAsync(sp.GetRequiredService<IMySqlDapperHelper>(), sp.GetRequiredService<ICatalogNotifyBAL>()),
            Every(TimeSpan.FromHours(1))),
        // Saved searches: tell shoppers about new matching products (Admin → Growth; off unless switched on).
        new("saved_searches", async sp => await SavedSearches.SendMatchesAsync(sp.GetRequiredService<IMySqlDapperHelper>(), sp.GetRequiredService<ICatalogNotifyBAL>()),
            Every(TimeSpan.FromMinutes(30))),
        // Seller scorecard auto-suspend (Admin → Growth; needs the scorecard and auto_suspend both switched on).
        new("seller_auto_suspend", async sp => await sp.GetRequiredService<IGrowthBAL>().AutoSuspendAsync(sp.GetRequiredService<ICatalogNotifyBAL>()),
            Every(TimeSpan.FromHours(1))),
        new("delivery_payouts", async sp => await sp.GetRequiredService<DeliveryAdminBAL>().GenerateScheduledAsync(),
            WeeklyAtIst(DayOfWeek.Monday, 10, 15)),
        // Reference: jobs.review_summary_job (hourly). Summaries are published on product pages, so they are written
        // only by the real model — ReviewSummariesAsync is a no-op while the AI mode is "sandbox" (always, here).
        new("review_summaries", async sp => await sp.GetRequiredService<IAiBAL>().ReviewSummariesAsync(),
            Every(TimeSpan.FromHours(1))),
    ];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var jobs = Jobs();
        log.LogInformation("jobs worker started: {Count} jobs (run at startup: {RunAtStartup})", jobs.Count, app.JobsRunAtStartup);
        await Task.WhenAll(jobs.Select(j => LoopAsync(j, stoppingToken)));
    }

    private async Task LoopAsync(Job job, CancellationToken token)
    {
        var due = app.JobsRunAtStartup ? DateTime.UtcNow : job.Next(DateTime.UtcNow);
        while (!token.IsCancellationRequested)
        {
            var delay = due - DateTime.UtcNow;
            if (delay > TimeSpan.Zero)
            {
                try { await Task.Delay(delay, token); } catch (OperationCanceledException) { break; }
            }
            if (token.IsCancellationRequested) break;
            await RunOnceAsync(job);
            due = job.Next(DateTime.UtcNow);
        }
    }

    private async Task RunOnceAsync(Job job)
    {
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var sp = scope.ServiceProvider;
            var db = sp.GetRequiredService<IMySqlDapperHelper>();
            var lockName = $"pixcart_job_{job.Name}";
            await using var lockUow = await db.BeginAsync();
            var got = await lockUow.ExecuteScalarAsync<long?>("SELECT GET_LOCK(@lockName, 0)", new { lockName });
            if (got != 1) return;
            try
            {
                var n = await job.Run(sp);
                log.LogInformation("job {Name}: {Count} item(s)", job.Name, n);
            }
            finally
            {
                await lockUow.ExecuteAsync("SELECT RELEASE_LOCK(@lockName)", new { lockName });
            }
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "job {Name} failed", job.Name);
        }
    }
}
