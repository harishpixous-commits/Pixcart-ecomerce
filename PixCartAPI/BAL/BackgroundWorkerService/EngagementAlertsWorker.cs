using BAL.Interface;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BAL.BackgroundWorkerService;

/// <summary>
/// Every 10 minutes: back-in-stock alerts and wishlist price-drop alerts (the reference scheduler's "alerts" job).
/// </summary>
public class EngagementAlertsWorker(IServiceScopeFactory scopes, ILogger<EngagementAlertsWorker> log) : BackgroundService
{
    public static readonly TimeSpan Every = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Every);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var svc = scope.ServiceProvider.GetRequiredService<IEngagementBAL>();
                var n = await svc.SendStockAlertsAsync() + await svc.SendPriceDropsAsync();
                if (n > 0) log.LogInformation("alerts: {Count} sent", n);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log.LogError(e, "alerts job failed");
            }
        }
    }
}
