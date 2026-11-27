using System.Diagnostics;
using System.Text.Json.Nodes;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;

namespace BAL.Payments;

/// <summary>
/// Each gateway's health from its recent calls (payment_gateway_events): the circuit breaker, success rates and the
/// figures on Admin → Payments. Events are written on their own connection, so a call that failed is remembered even when
/// the order it was made for is rolled back.
/// </summary>
public sealed class PaymentHealth(PaymentEventsDAL events, ILogger<PaymentHealth> log)
{
    public const int KeepDays = 7;

    /// <summary>Stores one event. Never throws: a payment must not fail because its health could not be written down.</summary>
    public async Task RecordAsync(string gateway, bool ok, long ms, string error = "")
    {
        try
        {
            await events.InsertAsync(new PaymentGatewayEventModel
            {
                Id = Guid.NewGuid(), Gateway = gateway, Ok = ok, Ms = (int)Math.Max(0, ms), Error = PaymentText.Cut(error, 300), CreatedAt = DateTimeFunctions.UtcNow(),
            });
        }
        catch (Exception e)
        {
            log.LogError(e, "could not record a {Gateway} gateway event", gateway);
        }
    }

    /// <summary>Runs one call to a gateway, records how it went and returns its answer. A failure, a time-out or an answer the
    /// adapter could not read is recorded and thrown as PaymentGatewayException; NotApplicableException (this gateway cannot
    /// take this payment) is thrown without counting against the gateway.</summary>
    public async Task<T> ObserveAsync<T>(IPaymentGateway gateway, Func<CancellationToken, Task<T>> call, double? timeoutSeconds = null)
    {
        var watch = Stopwatch.StartNew();
        using var cts = new CancellationTokenSource();
        if (timeoutSeconds is { } limit) cts.CancelAfter(TimeSpan.FromSeconds(limit));
        T result;
        try
        {
            var task = call(cts.Token);
            result = timeoutSeconds is { } secs ? await task.WaitAsync(TimeSpan.FromSeconds(secs)) : await task;
        }
        catch (NotApplicableException)
        {
            throw;
        }
        catch (Exception e) when (e is TimeoutException || (e is OperationCanceledException && cts.IsCancellationRequested))
        {
            await RecordAsync(gateway.Code, false, watch.ElapsedMilliseconds, "Did not answer in time");
            throw new PaymentGatewayException($"{gateway.Name} did not answer in time");
        }
        catch (PaymentGatewayException e)
        {
            await RecordAsync(gateway.Code, false, watch.ElapsedMilliseconds, e.Message);
            throw;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "{Gateway} answered something unexpected", gateway.Name);
            await RecordAsync(gateway.Code, false, watch.ElapsedMilliseconds, "Answered something unexpected");
            throw new PaymentGatewayException($"{gateway.Name} answered something unexpected");
        }
        await RecordAsync(gateway.Code, true, watch.ElapsedMilliseconds);
        return result;
    }

    /// <summary>closed, open or half_open. Open when the last circuit_failures events all failed and the newest is younger
    /// than the cool-down; after the cool-down one attempt goes through (half-open) and its outcome closes or reopens it.</summary>
    public async Task<string> CircuitAsync(string code, JsonObject rules, DateTime? now = null)
    {
        var n = (int)rules["circuit_failures"]!;
        var rows = (await events.LatestAsync(code, n)).ToList();
        if (rows.Count < n || rows.Any(r => r.Ok)) return "closed";
        var age = (now ?? DateTimeFunctions.UtcNow()) - rows[0].CreatedAt;
        return age < TimeSpan.FromSeconds((int)rules["circuit_cooldown_seconds"]!) ? "open" : "half_open";
    }

    /// <summary>ok events / all events over the last window_minutes; fewer than min_samples events counts as 1.0.</summary>
    public async Task<Dictionary<string, double>> SuccessRatesAsync(IReadOnlyList<string> codes, JsonObject rules, DateTime? now = null)
    {
        var since = (now ?? DateTimeFunctions.UtcNow()).AddMinutes(-(int)rules["window_minutes"]!);
        var totals = (await events.TotalsAsync(codes, since)).ToDictionary(t => t.Gateway, StringComparer.Ordinal);
        var min = (int)rules["min_samples"]!;
        return codes.ToDictionary(c => c, c => totals.TryGetValue(c, out var t) && t.Attempts >= min ? (double)t.Good / t.Attempts : 1.0);
    }

    /// <summary>The 95th percentile by nearest rank: the ceil(0.95 n)-th smallest value.</summary>
    public static int RankP95(long count) => (int)((95 * count + 99) / 100);

    /// <summary>The last 24 hours for Admin → Payments: attempts, ok, success rate, average and p95 time, last error and when.</summary>
    public async Task<Dictionary<string, JsonObject>> StatsAsync(IReadOnlyList<string> codes, DateTime? now = null)
    {
        var since = (now ?? DateTimeFunctions.UtcNow()).AddHours(-24);
        var totals = (await events.TotalsAsync(codes, since)).ToDictionary(t => t.Gateway, StringComparer.Ordinal);
        var outp = new Dictionary<string, JsonObject>();
        foreach (var code in codes)
        {
            totals.TryGetValue(code, out var t);
            long attempts = t?.Attempts ?? 0, good = t?.Good ?? 0, totalMs = t?.TotalMs ?? 0;
            var slowest = attempts > 0 ? await events.MsAtAsync(code, since, RankP95(attempts)) : 0;
            var last = await events.LastErrorAsync(code, since);
            outp[code] = new JsonObject
            {
                ["attempts"] = attempts,
                ["ok"] = good,
                // half-up to 4 decimals with whole numbers, so every version shows the same figure
                ["success_rate"] = attempts > 0 ? JsonValue.Create((good * 20000 + attempts) / (2 * attempts) / 10000.0) : null,
                ["avg_ms"] = attempts > 0 ? (totalMs + attempts / 2) / attempts : 0,
                ["p95_ms"] = slowest,
                ["last_error"] = last?.Error ?? "",
                ["last_error_at"] = last is null ? null : DateTimeFunctions.Iso(last.CreatedAt),
            };
        }
        return outp;
    }

    /// <summary>Drops events older than a week (the daily cleanup).</summary>
    public Task<int> PruneAsync() => events.PruneAsync(DateTimeFunctions.UtcNow().AddDays(-KeepDays));
}
