using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Utils;

namespace BAL.AI;

public interface ILlmRouterBAL
{
    /// <summary>Streams a request on a route's fallback chain: adapter events, then a final "used" event.</summary>
    Task StreamAsync(string route, IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray? tools, int maxTokens, Func<LlmEvent, Task> emit,
        List<LlmTarget>? chain = null, CancellationToken ct = default);

    /// <summary>One user message, the whole answer: (turn, used).</summary>
    Task<(LlmTurn Turn, LlmUsed Used)> CompleteAsync(string route, IReadOnlyList<SystemBlock> system, string user, int maxTokens, CancellationToken ct = default);

    /// <summary>Sends a tiny prompt with every key of a connection and reports which work: (ok, message, latency ms).</summary>
    Task<(bool Ok, string Message, int LatencyMs)> TestTargetAsync(LlmConnection conn, string model, CancellationToken ct = default);
}

/// <summary>
/// Runs a request on a route's fallback chain. For each target (connection + model) in order, each API key of that
/// connection is tried. A key that is rate-limited, rejected or out of credit cools down for a while and the next key
/// (then the next target) is used; any other provider error skips the rest of that connection's keys. Once text has
/// started streaming to the user, the answer is never switched to another model mid-way; the error is reported instead.
/// </summary>
public class LlmRouterBAL(ILlmConfigBAL config, ILogger<LlmRouterBAL> log) : ILlmRouterBAL
{
    /// <summary>"&lt;connection&gt;:&lt;key id&gt;" → when the key may be used again (Stopwatch ticks).</summary>
    private static readonly ConcurrentDictionary<string, long> Cooldown = new();

    public static readonly Dictionary<int, double> CooldownSeconds = new() { [429] = 30, [401] = 600, [403] = 600, [402] = 1800 };

    /// <summary>Pause before the one quick retry on a transient server error (tests set it to zero).</summary>
    public static TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(1);

    public static void ClearCooldowns() => Cooldown.Clear();

    public static bool CoolingDown(string connectionId, string keyId) =>
        Cooldown.TryGetValue($"{connectionId}:{keyId}", out var until) && until > Stopwatch.GetTimestamp();

    private static List<(string Id, string Key)> KeySlots(LlmConnection conn)
    {
        var slots = conn.KeyIds.Zip(conn.Keys).Select(x => (x.First, x.Second)).ToList();
        if (slots.Count == 0) slots = [("none", "")];
        var now = Stopwatch.GetTimestamp();
        var ready = slots.Where(s => !Cooldown.TryGetValue($"{conn.Id}:{s.Item1}", out var until) || until <= now).ToList();
        return ready.Count > 0 ? ready : slots; // all cooling down: try anyway rather than fail without asking
    }

    public async Task StreamAsync(string route, IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray? tools, int maxTokens,
        Func<LlmEvent, Task> emit, List<LlmTarget>? chain = null, CancellationToken ct = default)
    {
        chain ??= await config.TargetsAsync(route);
        if (chain.Count == 0)
            throw new AppException("No AI model is connected. Add one in Admin → AI providers (or the Claude key in Integrations).", "ai_not_configured", 400);
        var errors = new List<string>();
        var attempt = 0;
        var plan = new List<(LlmTarget Target, string KeyId, string Key, bool MayRetry)>();
        foreach (var t in chain)
            foreach (var (id, key) in KeySlots(t.Connection))
                plan.Add((t, id, key, chain.Count == 1));
        var skip = new HashSet<string>();
        foreach (var (t, keyId, key, mayRetry) in plan)
        {
            if (skip.Contains(t.Connection.Id + t.Model)) continue;
            for (var retry = 0; retry < (mayRetry ? 2 : 1); retry++)
            {
                var started = false;
                try
                {
                    await LlmAdapters.For(t.Connection).StreamAsync(t.Connection, key, t.Model, system, messages, tools ?? [], maxTokens, async ev =>
                    {
                        if (ev.Kind is "text" or "tool") started = true;
                        await emit(ev);
                    }, ct);
                    await emit(new LlmEvent("used", Used: new LlmUsed(t.Connection.Id, t.Connection.Name, t.Connection.Type, t.Model, attempt)));
                    return;
                }
                catch (ProviderException exc)
                {
                    if (started) throw new AppException("The AI stopped part-way through. Please ask again.", "ai_interrupted", 502);
                    if (retry == 0 && mayRetry && exc.Status is 500 or 502 or 503 or 529)
                    {
                        if (RetryDelay > TimeSpan.Zero) await Task.Delay(RetryDelay, ct); // one quick retry on the same key for a transient server error
                        continue;
                    }
                    errors.Add($"{t.Connection.Name} / {t.Model}: {exc.Message}");
                    log.LogWarning("llm {Connection} {Model} key {Key} failed: {Error}", t.Connection.Name, t.Model, keyId, exc.Message);
                    if (exc.KeyProblem && CooldownSeconds.TryGetValue(exc.Status, out var secs))
                        Cooldown[$"{t.Connection.Id}:{keyId}"] = Stopwatch.GetTimestamp() + (long)(secs * Stopwatch.Frequency);
                    if (!exc.KeyProblem) skip.Add(t.Connection.Id + t.Model); // other keys would fail the same way
                    attempt++;
                    break;
                }
                catch (LlmNetworkException exc)
                {
                    if (started) throw new AppException("The AI connection dropped part-way through. Please ask again.", "ai_interrupted", 502);
                    errors.Add($"{t.Connection.Name} / {t.Model}: network ({exc.Kind})");
                    skip.Add(t.Connection.Id + t.Model);
                    attempt++;
                    break;
                }
            }
        }
        log.LogError("llm route {Route} failed on every target: {Errors}", route, string.Join("; ", errors));
        throw new AppException("None of the connected AI models answered. Check Admin → AI providers. " + (errors.Count > 0 ? errors[^1] : ""), "ai_unavailable", 502);
    }

    public async Task<(LlmTurn Turn, LlmUsed Used)> CompleteAsync(string route, IReadOnlyList<SystemBlock> system, string user, int maxTokens, CancellationToken ct = default)
    {
        LlmTurn? turn = null;
        LlmUsed? used = null;
        await StreamAsync(route, system, new JsonArray(J.O(("role", "user"), ("content", user))), null, maxTokens, ev =>
        {
            if (ev.Kind == "turn") turn = ev.Turn;
            else if (ev.Kind == "used") used = ev.Used;
            return Task.CompletedTask;
        }, null, ct);
        return (turn!, used!);
    }

    public async Task<(bool Ok, string Message, int LatencyMs)> TestTargetAsync(LlmConnection conn, string model, CancellationToken ct = default)
    {
        var results = new List<string>();
        var okAny = false;
        var latency = 0;
        var slots = conn.KeyIds.Zip(conn.Keys).Select(x => (x.First, x.Second)).ToList();
        if (slots.Count == 0) slots = [("none", "")];
        foreach (var (keyId, key) in slots)
        {
            var sw = Stopwatch.StartNew();
            var id = J.Cut(keyId, 6);
            try
            {
                await LlmAdapters.For(conn).StreamAsync(conn, key, model, [new SystemBlock("Reply with the single word OK.")],
                    new JsonArray(J.O(("role", "user"), ("content", "ping"))), [], 16, _ => Task.CompletedTask, ct);
                latency = (int)sw.ElapsedMilliseconds;
                okAny = true;
                results.Add($"key {id}: OK in {latency} ms");
            }
            catch (ProviderException exc)
            {
                results.Add($"key {id}: {exc.Message}");
            }
            catch (LlmNetworkException exc)
            {
                results.Add($"key {id}: cannot reach the server ({exc.Kind})");
            }
        }
        return (okAny, $"{model}: " + string.Join("; ", results), latency);
    }
}
