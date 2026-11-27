using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Which payment gateway takes a new payment, and when the next takes over (docs/PAYMENT_GATEWAYS.md sections 2 and 3).
/// Mirror of services/payment_routing.py. Pure rules plus the health events table; the gateway adapters come later.</summary>
public static class PaymentRouting
{
    public const string Key = "payment_routing";
    public static readonly string[] Gateways = ["razorpay", "cashfree", "phonepe", "payu", "stripe"];
    public static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string>
    { ["razorpay"] = "Razorpay", ["cashfree"] = "Cashfree Payments", ["phonepe"] = "PhonePe Payment Gateway", ["payu"] = "PayU", ["stripe"] = "Stripe" };
    private static readonly Dictionary<string, string[]?> Currencies = new() { ["razorpay"] = null, ["cashfree"] = ["INR"], ["phonepe"] = ["INR"], ["payu"] = ["INR"], ["stripe"] = null };
    private static readonly Dictionary<string, (int Lo, int Hi)> Limits = new()
    { ["timeout_seconds"] = (3, 30), ["circuit_failures"] = (1, 20), ["circuit_cooldown_seconds"] = (10, 3600), ["window_minutes"] = (5, 1440), ["min_samples"] = (1, 100) };

    public sealed record Event(string Gateway, bool Ok, DateTime At);

    public static JsonObject Defaults() => new()
    {
        ["order"] = new JsonArray(Gateways.Select(g => (JsonNode)g).ToArray()), ["failover"] = true, ["strategy"] = "priority", ["timeout_seconds"] = 8,
        ["circuit_failures"] = 3, ["circuit_cooldown_seconds"] = 120, ["window_minutes"] = 15, ["min_samples"] = 5,
    };

    public static JsonObject Validate(JsonObject data)
    {
        var clean = new JsonObject();
        var defaults = Defaults();
        try
        {
            foreach (var (k, v) in data)
            {
                if (!defaults.ContainsKey(k)) throw new ArgumentException($"Unknown setting: {k}");
                if (Limits.TryGetValue(k, out var r))
                {
                    if (!SettingsJson.IsWholeNumber(v, out var n) || n < r.Lo || n > r.Hi) throw new ArgumentException($"{k} must be a whole number between {r.Lo} and {r.Hi}");
                    clean[k] = n;
                }
                else if (k == "failover")
                {
                    if (v?.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)) throw new ArgumentException("failover must be on or off");
                    clean[k] = v.GetValueKind() == JsonValueKind.True;
                }
                else if (k == "strategy")
                {
                    var s = v?.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : "";
                    if (s is not ("priority" or "success_rate")) throw new ArgumentException("strategy must be priority or success_rate");
                    clean[k] = s;
                }
                else
                {
                    var list = (v as JsonArray)?.Select(x => x?.GetValueKind() == JsonValueKind.String ? x.GetValue<string>() : "").ToList();
                    if (list == null || list.Any(x => !Gateways.Contains(x)) || list.Distinct().Count() != list.Count) throw new ArgumentException("order must list known gateways without repeats");
                    clean[k] = new JsonArray(list.Select(x => (JsonNode)x).ToArray());
                }
            }
        }
        catch (ArgumentException e) { throw new AppException(e.Message, "invalid_setting"); }
        return clean;
    }

    public static async Task<JsonObject> GetAsync(SettingsDAL settings) => SettingsDAL.Merge(Defaults(), await settings.GetAsync(Key));

    public static async Task<JsonObject> UpdateAsync(SettingsDAL settings, CatalogSupportDAL support, JsonObject data)
    {
        await support.MergeSettingsAsync(Key, Validate(data));
        return await GetAsync(settings);
    }

    public static string CircuitState(IEnumerable<Event> events, JsonObject cfg, DateTime now)
    {
        var n = cfg.Int("circuit_failures");
        var last = events.OrderByDescending(e => e.At).Take(n).ToList();
        if (last.Count < n || last.Any(e => e.Ok)) return "closed";
        return now - last[0].At < TimeSpan.FromSeconds(cfg.Int("circuit_cooldown_seconds")) ? "open" : "half_open";
    }

    public static double SuccessRate(IEnumerable<Event> events, JsonObject cfg, DateTime now)
    {
        var recent = events.Where(e => now - e.At <= TimeSpan.FromMinutes(cfg.Int("window_minutes"))).ToList();
        return recent.Count < cfg.Int("min_samples") ? 1.0 : (double)recent.Count(e => e.Ok) / recent.Count;
    }

    public static List<string> Eligible(JsonObject cfg, ISet<string> enabled, string currency, IReadOnlyList<Event> events, DateTime now)
    {
        var order = (cfg["order"] as JsonArray ?? []).Select(x => x!.GetValue<string>()).Where(Gateways.Contains).ToList();
        var ordered = order.Concat(Gateways.Where(g => !order.Contains(g))).ToList();
        var outp = new List<string>();
        foreach (var g in ordered)
        {
            if (!enabled.Contains(g)) continue;
            var cur = Currencies[g];
            if (cur != null && !cur.Contains(currency)) continue;
            if (CircuitState(events.Where(e => e.Gateway == g), cfg, now) == "open") continue;
            outp.Add(g);
        }
        if (cfg.Str("strategy") == "success_rate")
        {
            var rate = outp.ToDictionary(g => g, g => SuccessRate(events.Where(e => e.Gateway == g), cfg, now));
            outp = outp.OrderByDescending(g => rate[g]).ToList(); // LINQ OrderBy is stable: ties keep the priority order
        }
        return outp;
    }

    public static List<string> ToTry(JsonObject cfg, List<string> candidates) => cfg.Bool("failover") ? candidates : candidates.Take(1).ToList();

    public static async Task<List<Event>> RecentEventsAsync(IMySqlDapperHelper db, DateTime now) =>
        (await db.QueryAsync<(string Gateway, bool Ok, DateTime At)>("SELECT gateway AS Gateway, ok AS Ok, created_at AS At FROM payment_gateway_events WHERE created_at >= @since", new { since = now.AddDays(-1) }))
        .Select(r => new Event(r.Gateway, r.Ok, DateTime.SpecifyKind(r.At, DateTimeKind.Utc))).ToList();

    public static async Task RecordAsync(IMySqlDapperHelper db, string gateway, bool ok, int ms, string error = "")
    {
        var now = DateTime.UtcNow;
        await db.ExecuteAsync("INSERT INTO payment_gateway_events (id, gateway, ok, ms, `error`, created_at) VALUES (@id, @gateway, @ok, @ms, @error, @now)",
            new { id = Guid.NewGuid(), gateway, ok, ms = Math.Max(0, ms), error = error.Length > 300 ? error[..300] : error, now });
        await db.ExecuteAsync("DELETE FROM payment_gateway_events WHERE created_at < @cut", new { cut = now.AddDays(-7) });
    }
}
