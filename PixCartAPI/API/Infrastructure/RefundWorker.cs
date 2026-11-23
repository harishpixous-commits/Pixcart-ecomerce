using System.Threading.Channels;
using BAL.Interface;

namespace API.Infrastructure;

/// <summary>
/// Reliable background work, the company-stack equivalent of the reference's FastAPI BackgroundTasks: endpoints
/// enqueue ids and respond; this worker does the slow provider calls afterwards. A crash between commit and send is
/// covered by the refund retry job (jobs module), exactly like the reference.
/// </summary>
public sealed class RefundQueue : IRefundQueue
{
    private readonly Channel<Guid> channel = Channel.CreateUnbounded<Guid>();

    public void Enqueue(IEnumerable<Guid> refundIds)
    {
        foreach (var id in refundIds) channel.Writer.TryWrite(id);
    }

    public ChannelReader<Guid> Reader => channel.Reader;
}

/// <summary>Runs queued refunds one by one (reference: run_refunds as a BackgroundTasks entry).</summary>
public sealed class RefundWorker(RefundQueue queue, IServiceScopeFactory scopes, ILogger<RefundWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var orders = scope.ServiceProvider.GetRequiredService<IOrdersBAL>();
                await orders.ProcessRefundAsync(id);
            }
            catch (Exception ex) // the retry job picks it up
            {
                log.LogWarning("refund {Id} failed: {Message}", id, ex.Message);
            }
        }
    }
}
