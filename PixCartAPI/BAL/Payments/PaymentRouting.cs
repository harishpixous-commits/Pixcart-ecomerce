using System.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using DAL;
using Model.DomainModel.Integrations;
using Utils;

namespace BAL.Payments;

/// <summary>No gateway could start the payment; <see cref="Reason"/> is the last gateway's own message ("" when none was tried).</summary>
public sealed class PaymentStartException(string message, string code, int statusCode, string reason) : AppException(message, code, statusCode)
{
    public string Reason { get; } = reason;
}

/// <summary>
/// Which gateway takes a payment: the admin's order, each gateway's switch, currency and circuit, the strategy, and
/// automatic failover to the next gateway when one is down, slow or failing (docs/PAYMENT_GATEWAYS.md, section 3).
/// </summary>
public sealed class PaymentRouting(SettingsDAL settings, PaymentGateways gateways, PaymentHealth health)
{
    public const string RowKey = "payment_routing";
    public const string Unavailable = "Online payments are not available right now. Choose cash on delivery or try again in a few minutes.";

    public static readonly (string Key, int Min, int Max, string Label)[] Limits =
    [
        ("timeout_seconds", 3, 30, "Time-out"), ("circuit_failures", 1, 20, "Failures before pausing a gateway"),
        ("circuit_cooldown_seconds", 10, 3600, "Pause length"), ("window_minutes", 5, 1440, "Success-rate window"), ("min_samples", 1, 100, "Minimum calls"),
    ];

    public static JsonObject Defaults() => new()
    {
        ["order"] = new JsonArray([.. PaymentGateways.Order.Select(c => (JsonNode)JsonValue.Create(c)!)]), ["failover"] = true, ["strategy"] = "priority",
        ["timeout_seconds"] = 8, ["circuit_failures"] = 3, ["circuit_cooldown_seconds"] = 120, ["window_minutes"] = 15, ["min_samples"] = 5,
    };

    private static bool IsText(JsonNode? n, out string text)
    {
        text = n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : "";
        return n is JsonValue s && s.GetValueKind() == JsonValueKind.String;
    }

    private static bool IsWhole(JsonNode? n, out int value)
    {
        value = 0;
        return n is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue(out value);
    }

    private static bool IsFlag(JsonNode? n, out bool value)
    {
        value = false;
        if (n is not JsonValue v || v.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)) return false;
        value = v.GetValueKind() == JsonValueKind.True;
        return true;
    }

    /// <summary>The saved routing with defaults for anything missing or no longer valid (a gateway that was removed, say).</summary>
    public static JsonObject Normalize(JsonNode? value)
    {
        var raw = value as JsonObject ?? [];
        var outp = Defaults();
        if (raw["order"] is JsonArray order)
        {
            var seen = new List<string>();
            foreach (var item in order)
                if (IsText(item, out var code) && PaymentGateways.Order.Contains(code) && !seen.Contains(code)) seen.Add(code);
            outp["order"] = new JsonArray([.. seen.Select(c => (JsonNode)JsonValue.Create(c)!)]);
        }
        if (IsFlag(raw["failover"], out var failover)) outp["failover"] = failover;
        if (IsText(raw["strategy"], out var strategy) && strategy is "priority" or "success_rate") outp["strategy"] = strategy;
        foreach (var (key, min, max, _) in Limits)
            if (IsWhole(raw[key], out var v) && v >= min && v <= max) outp[key] = v;
        return outp;
    }

    /// <summary>The admin's routing form, checked against the limits; 422 invalid_routing naming every field that is wrong.</summary>
    public static JsonObject Validate(JsonObject body)
    {
        var fields = new Dictionary<string, string>();
        var order = new List<string>();
        if (body["order"] is not JsonArray list || list.Any(i => !IsText(i, out _))) fields["order"] = "A list of gateways";
        else
        {
            order = list.Select(i => i!.GetValue<string>()).ToList();
            var unknown = order.FirstOrDefault(c => !PaymentGateways.Order.Contains(c));
            if (unknown is not null) fields["order"] = $"Unknown gateway: {unknown}";
            else if (order.Distinct().Count() != order.Count) fields["order"] = "Each gateway only once";
        }
        if (!IsFlag(body["failover"], out var failover)) fields["failover"] = "Choose on or off";
        if (!IsText(body["strategy"], out var strategy) || strategy is not ("priority" or "success_rate")) fields["strategy"] = "Choose priority or success rate";
        var values = new Dictionary<string, int>();
        foreach (var (key, min, max, label) in Limits)
        {
            if (IsWhole(body[key], out var v) && v >= min && v <= max) values[key] = v;
            else fields[key] = $"{label}: a whole number from {min} to {max}";
        }
        if (fields.Count > 0) throw new AppException("Check the routing settings", "invalid_routing", 422, fields);
        var outp = new JsonObject
        {
            ["order"] = new JsonArray([.. order.Select(c => (JsonNode)JsonValue.Create(c)!)]), ["failover"] = failover, ["strategy"] = strategy,
        };
        foreach (var (key, _, _, _) in Limits) outp[key] = values[key];
        return outp;
    }

    public async Task<JsonObject> GetAsync() => Normalize(await settings.GetAsync(RowKey));

    public async Task<JsonObject> SaveAsync(JsonObject value, IDbTransaction? tx = null)
    {
        await settings.SaveAsync(RowKey, value.DeepClone(), tx);
        return Normalize(value);
    }

    /// <summary>Every gateway in routing order: the admin's list, then the rest in their standard order.</summary>
    public IReadOnlyList<IPaymentGateway> Ordered(JsonObject rules)
    {
        var listed = (rules["order"] as JsonArray ?? []).Select(n => n!.GetValue<string>()).ToList();
        return [.. listed.Concat(PaymentGateways.Order.Where(c => !listed.Contains(c))).Select(gateways.Get)];
    }

    public static bool CanCharge(IPaymentGateway g, IntegrationSettings cfg, string currency) => g.Currencies(cfg) is not { } allowed || allowed.Contains(currency);

    /// <summary>The gateways that may take a new payment in this currency, best first: enabled, able to charge it, circuit not
    /// open; then by success rate when that strategy is chosen (a stable sort, so ties keep the routing order).</summary>
    public async Task<List<IPaymentGateway>> EligibleAsync(IntegrationSettings cfg, string currency, JsonObject? rules = null)
    {
        rules ??= await GetAsync();
        var now = DateTimeFunctions.UtcNow();
        var outp = new List<IPaymentGateway>();
        foreach (var g in Ordered(rules))
            if (g.Enabled(cfg) && CanCharge(g, cfg, currency) && await health.CircuitAsync(g.Code, rules, now) != "open") outp.Add(g);
        if ((string)rules["strategy"]! == "success_rate" && outp.Count > 1)
        {
            var rates = await health.SuccessRatesAsync(outp.Select(g => g.Code).ToList(), rules, now);
            outp = [.. outp.OrderByDescending(g => rates[g.Code])];
        }
        return outp;
    }

    /// <summary>Tries the candidates in order (only the first when failover is off), each within the time-out; the first that
    /// creates the payment wins. Throws PaymentStartException: 409 payments_unavailable or 502 gateway_error.</summary>
    public async Task<(IPaymentGateway Gateway, CreatedPayment Created)> StartAsync(IntegrationSettings cfg, IReadOnlyList<IPaymentGateway> candidates,
        JsonObject rules, long amount, string currency, string receipt, PaymentCustomer customer)
    {
        if (candidates.Count == 0) throw new PaymentStartException(Unavailable, "payments_unavailable", 409, "");
        var baseUrl = cfg.PublicWebUrl.TrimEnd('/');
        var last = "";
        var tried = 0;
        foreach (var g in candidates)
        {
            if (tried > 0 && !(bool)rules["failover"]!) break;
            try
            {
                var created = await health.ObserveAsync(g, ct => g.CreateAsync(cfg, amount, currency, receipt, customer,
                    $"{baseUrl}/api/payments/{g.Code}/callback", $"{baseUrl}/api/payments/{g.Code}/webhook", ct), (int)rules["timeout_seconds"]!);
                return (g, created);
            }
            catch (NotApplicableException e)
            {
                last = e.Message; // does not use up the one try allowed without failover
            }
            catch (PaymentGatewayException e)
            {
                last = e.Message;
                tried++;
            }
        }
        if (tried == 0) throw new PaymentStartException(last.Length > 0 ? $"{Unavailable} ({last})" : Unavailable, "payments_unavailable", 409, last);
        throw new PaymentStartException($"Could not start the payment: {last}", "gateway_error", 502, last);
    }

    /// <summary>The other ways to pay, for "Pay another way".</summary>
    public static JsonArray Alternatives(IEnumerable<IPaymentGateway> candidates, string current) =>
        new([.. candidates.Where(g => g.Code != current).Select(g => (JsonNode)new JsonObject { ["provider"] = g.Code, ["label"] = g.Name })]);
}
