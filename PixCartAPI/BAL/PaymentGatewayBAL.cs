using System.Diagnostics;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

public class PaymentGatewayBAL(IIntegrationBAL integrations, IRazorpayBAL razorpay, SettingsDAL settings, CatalogSupportDAL support, OrdersDAL orders,
    IHttpClientFactory http, IMySqlDapperHelper db, IAccessBAL access, IAuditBAL audit, ILogger<PaymentGatewayBAL> log) : IPaymentGatewayBAL
{
    public const string HttpClientName = "payment-gateways";
    private static readonly IReadOnlyDictionary<string, string> ClientMode = new Dictionary<string, string>
    { ["razorpay"] = "modal", ["cashfree"] = "modal", ["phonepe"] = "redirect", ["payu"] = "form", ["stripe"] = "redirect" };

    private HttpClient Client(double timeout) { var c = http.CreateClient(HttpClientName); c.Timeout = TimeSpan.FromSeconds(timeout + 1); return c; }

    private async Task<List<string>> CandidatesAsync(JsonObject rcfg, Model.DomainModel.Integrations.IntegrationSettings cfg, string currency, string? after = null, string? exclude = null)
    {
        var enabled = PaymentRouting.Gateways.Where(g => GatewayConfig.Enabled(cfg, g)).ToHashSet();
        var events = await PaymentRouting.RecentEventsAsync(db, DateTime.UtcNow);
        var list = PaymentRouting.Eligible(rcfg, enabled, currency, events, DateTime.UtcNow).Where(g => g != exclude).ToList();
        var i = after is null ? -1 : list.IndexOf(after);
        return i >= 0 ? [.. list.Skip(i + 1), .. list.Take(i + 1)] : list;
    }

    public async Task<JsonArray> AlternativesAsync(string currency, string current)
    {
        var cfg = await integrations.GetAsync();
        var list = await CandidatesAsync(await PaymentRouting.GetAsync(settings), cfg, currency, exclude: current);
        return new JsonArray(list.Select(g => (JsonNode)new JsonObject { ["provider"] = g, ["label"] = PaymentRouting.Names[g] }).ToArray());
    }

    public async Task<PaymentModel> StartAsync(OrderModel order, UserModel user, long amount, long? charge, string chargeCurrency, IUnitOfWork uow, string? preferred = null, string? after = null)
    {
        var cfg = await integrations.GetAsync();
        var rcfg = await PaymentRouting.GetAsync(settings);
        List<string> toTry;
        if (preferred is not null)
        {
            if (!(await CandidatesAsync(rcfg, cfg, chargeCurrency)).Contains(preferred)) throw new AppException("That payment method is not available right now.", "gateway_unavailable", 409);
            toTry = [preferred];
        }
        else
        {
            var cands = await CandidatesAsync(rcfg, cfg, chargeCurrency, after);
            if (cands.Count == 0)
            {
                if (chargeCurrency != RegionalBAL.Base) throw new AppException($"Paying in {chargeCurrency} is not available right now. Switch the currency to ₹ (INR) and try again.", "currency_unavailable", 409);
                throw new AppException("Online payment is not available right now. Please choose cash on delivery.", "online_unavailable", 409);
            }
            toTry = PaymentRouting.ToTry(rcfg, cands);
        }
        var n = await orders.PaymentCountAsync(order.Id, uow);
        var receipt = n == 0 ? order.Number : $"{order.Number}-{n}";
        var timeout = (double)rcfg.Int("timeout_seconds");
        Exception? last = null;
        foreach (var code in toTry)
        {
            var sw = Stopwatch.StartNew();
            string reference; string? data = null;
            try
            {
                if (code == "razorpay")
                {
                    var rp = await razorpay.CreateOrderAsync(charge ?? amount, receipt, new Dictionary<string, string> { ["order_number"] = order.Number }, chargeCurrency).WaitAsync(TimeSpan.FromSeconds(timeout));
                    reference = rp["id"]?.GetValue<string>() ?? "";
                }
                else
                {
                    var b = cfg.PublicWebUrl.TrimEnd('/');
                    var cust = new JsonObject { ["id"] = user.Id.ToString(), ["name"] = user.Name, ["contact"] = string.IsNullOrEmpty(user.Phone) ? "" : $"+91{user.Phone}", ["email"] = user.Email ?? "" };
                    var made = await GatewayConfig.Build(Client(timeout), cfg, code).CreateAsync(charge ?? amount, chargeCurrency, receipt, cust, $"{b}/api/payments/{code}/callback", $"{b}/api/payments/{code}/webhook").WaitAsync(TimeSpan.FromSeconds(timeout + 1));
                    reference = made.Reference;
                    var d = new JsonObject { ["mode"] = made.Mode };
                    foreach (var (k, v) in made.Fields) d[k] = v?.DeepClone();
                    data = d.ToJsonString();
                }
            }
            catch (Exception e) when (e is RazorpayBAL.GatewayException or TimeoutException)
            {
                last = e;
                await PaymentRouting.RecordAsync(db, code, false, (int)sw.ElapsedMilliseconds, e.Message.Length > 0 ? e.Message : "time-out");
                continue;
            }
            await PaymentRouting.RecordAsync(db, code, true, (int)sw.ElapsedMilliseconds);
            var now = DateTime.UtcNow;
            var payment = new PaymentModel { Id = Guid.NewGuid(), OrderId = order.Id, Provider = code, ProviderOrderId = reference, AmountPaise = amount, Currency = chargeCurrency, ChargeAmount = charge, Status = "created", ClientData = data, CreatedAt = now, UpdatedAt = now };
            await orders.InsertPaymentAsync(payment, uow);
            return payment;
        }
        var text = last?.Message is { Length: > 0 } m ? m : "the gateway did not answer in time";
        if (chargeCurrency != RegionalBAL.Base) throw new AppException($"Paying in {chargeCurrency} is not available right now ({text}). Switch the currency to ₹ (INR) and try again.", "currency_unavailable", 502);
        throw new AppException($"Could not start the payment: {text}", "gateway_error", 502);
    }

    public Task<JsonObject> PayloadAsync(OrderModel order, PaymentModel payment, UserModel user, string brand)
    {
        var o = new JsonObject
        {
            ["provider"] = payment.Provider, ["amount"] = payment.ChargeAmount ?? payment.AmountPaise, ["currency"] = payment.Currency.Length > 0 ? payment.Currency : "INR", ["name"] = brand,
            ["description"] = $"Order {order.Number}",
            ["prefill"] = new JsonObject { ["name"] = user.Name, ["contact"] = string.IsNullOrEmpty(user.Phone) ? "" : $"+91{user.Phone}", ["email"] = user.Email ?? "" },
            ["expires_at"] = order.PaymentExpiresAt?.ToString("o"),
        };
        var extra = payment.ClientData is { Length: > 0 } s ? JsonNode.Parse(s) as JsonObject ?? new JsonObject { ["mode"] = "redirect" } : new JsonObject { ["mode"] = "redirect" };
        foreach (var (k, v) in extra) o[k] = v?.DeepClone();
        return Task.FromResult(o);
    }

    public async Task<PaymentGateway> AdapterAsync(string code) => GatewayConfig.Build(Client(8), await integrations.GetAsync(), code);

    public async Task<JsonObject> CheckAsync(PaymentModel payment, IUnitOfWork uow, Func<PaymentModel, string, string, long, IUnitOfWork, Task<string>> markPaid)
    {
        if (payment.Status == "captured")
            return new JsonObject { ["result"] = "already_paid", ["attempts"] = new JsonArray(), ["payment"] = new JsonObject { ["id"] = payment.ProviderPaymentId, ["method"] = payment.Method, ["status"] = "captured" }, ["waiting"] = false, ["reason"] = "" };
        var rcfg = await PaymentRouting.GetAsync(settings);
        var adapter = GatewayConfig.Build(Client(rcfg.Int("timeout_seconds")), await integrations.GetAsync(), payment.Provider);
        var sw = Stopwatch.StartNew();
        List<GatewayAttempt> attempts;
        try { attempts = await adapter.AttemptsAsync(payment.ProviderOrderId); }
        catch (RazorpayBAL.GatewayException e) { await PaymentRouting.RecordAsync(db, payment.Provider, false, (int)sw.ElapsedMilliseconds, e.Message); throw; }
        await PaymentRouting.RecordAsync(db, payment.Provider, true, (int)sw.ElapsedMilliseconds);
        var seen = new JsonArray(attempts.Select(a => (JsonNode)new JsonObject { ["id"] = a.Id, ["status"] = a.Status, ["method"] = a.Method, ["error"] = a.Error }).ToArray());
        var done = attempts.FirstOrDefault(a => a.Status is "captured" or "authorized");
        if (done is null)
        {
            var failed = attempts.FirstOrDefault(a => a.Status == "failed");
            var reason = failed is null ? "" : failed.Error.Length > 0 ? failed.Error : "The payment did not go through";
            if (failed is not null && payment.Status != "captured") { payment.Error = reason.Length > 500 ? reason[..500] : reason; await orders.UpdatePaymentAsync(payment, uow); }
            return new JsonObject { ["result"] = "not_paid", ["attempts"] = seen, ["waiting"] = attempts.Any(a => a.Status is "created" or "pending"), ["reason"] = reason };
        }
        var result = await markPaid(payment, done.Id, done.Method, done.Amount, uow);
        return new JsonObject { ["result"] = result, ["attempts"] = seen, ["payment"] = new JsonObject { ["id"] = done.Id, ["method"] = done.Method, ["status"] = "captured" }, ["waiting"] = false, ["reason"] = "" };
    }

    public async Task<GatewayRefund> RefundAsync(PaymentModel payment, string providerPaymentId, long chargePaise, string refundId, string note) =>
        await GatewayConfig.Build(Client(15), await integrations.GetAsync(), payment.Provider).RefundAsync(payment.ProviderOrderId, providerPaymentId, chargePaise, refundId, note);

    // ------------------------------------------------------------------ Admin → Payments

    public async Task<JsonObject> GatewaysAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "settings");
        var cfg = await integrations.GetAsync();
        var rcfg = await PaymentRouting.GetAsync(settings);
        var now = DateTime.UtcNow;
        var rows = (await db.QueryAsync<(string Gateway, bool Ok, int Ms, string Error, DateTime At)>(
            "SELECT gateway AS Gateway, ok AS Ok, ms AS Ms, `error` AS Error, created_at AS At FROM payment_gateway_events WHERE created_at >= @since ORDER BY created_at", new { since = now.AddDays(-1) })).ToList();
        var items = new List<(string Code, JsonObject Row)>();
        foreach (var g in PaymentRouting.Gateways)
        {
            var mine = rows.Where(r => r.Gateway == g).ToList();
            var ev = mine.Select(r => new PaymentRouting.Event(g, r.Ok, DateTime.SpecifyKind(r.At, DateTimeKind.Utc))).ToList();
            var ok = mine.Count(r => r.Ok); var times = mine.Select(r => r.Ms).Order().ToList(); var bad = mine.Where(r => !r.Ok).ToList();
            string mode; bool configured;
            if (g == "razorpay") { mode = cfg.RazorpayKeyId.StartsWith("rzp_live_") ? "live" : cfg.RazorpayKeyId.Length > 0 ? "test" : ""; configured = cfg.RazorpayEnabled; }
            else { configured = GatewayConfig.Configured(cfg, g); mode = configured ? (GatewayConfig.Build(http.CreateClient(HttpClientName), cfg, g).Sandbox ? "test" : "live") : ""; }
            items.Add((g, new JsonObject
            {
                ["code"] = g, ["name"] = PaymentRouting.Names[g], ["configured"] = configured, ["enabled"] = GatewayConfig.Enabled(cfg, g), ["mode"] = mode,
                ["currencies"] = g is "razorpay" or "stripe" ? new JsonArray("any") : new JsonArray("INR"), ["client_mode"] = ClientMode[g],
                ["circuit"] = PaymentRouting.CircuitState(ev, rcfg, now), ["attempts"] = mine.Count, ["ok"] = ok,
                ["success_rate"] = mine.Count == 0 ? null : Math.Round((double)ok / mine.Count, 3), ["avg_ms"] = times.Count == 0 ? null : (int)Math.Round(times.Average()),
                ["p95_ms"] = times.Count == 0 ? null : times[Math.Min(times.Count - 1, (int)(times.Count * 0.95))], ["last_error"] = bad.Count > 0 ? bad[^1].Error : "",
                ["last_error_at"] = bad.Count > 0 ? DateTime.SpecifyKind(bad[^1].At, DateTimeKind.Utc).ToString("o") : null,
            }));
        }
        var order = (rcfg["order"] as JsonArray ?? []).Select(x => x!.GetValue<string>()).ToList();
        var sorted = items.OrderBy(i => order.IndexOf(i.Code) is var ix && ix >= 0 ? ix : 99).Select(i => (JsonNode)i.Row).ToArray();
        return new JsonObject { ["gateways"] = new JsonArray(sorted), ["routing"] = rcfg, ["defaults"] = PaymentRouting.Defaults() };
    }

    public async Task<JsonObject> UpdateRoutingAsync(UserModel admin, JsonObject body)
    {
        await access.RequireAsync(admin, "settings");
        await using var tx = await db.BeginAsync();
        var clean = PaymentRouting.Validate(body);
        await support.MergeSettingsAsync(PaymentRouting.Key, clean, tx);
        var detail = string.Join(", ", body.Select(x => x.Key).Order());
        await audit.AuditAsync(admin, "payments.routing", "settings", PaymentRouting.Key, detail[..Math.Min(200, detail.Length)], tx);
        await tx.CommitAsync();
        var g = await GatewaysAsync(admin);
        return new JsonObject { ["routing"] = g["routing"]!.DeepClone(), ["gateways"] = g["gateways"]!.DeepClone() };
    }

    public async Task<JsonObject> TestAsync(UserModel admin, string code)
    {
        await access.RequireAsync(admin, "settings");
        if (!PaymentRouting.Gateways.Contains(code)) throw new NotFoundException("Gateway");
        var cfg = await integrations.GetAsync();
        var sw = Stopwatch.StartNew();
        try
        {
            if (code == "razorpay")
            {
                if (!cfg.RazorpayEnabled) return new JsonObject { ["ok"] = false, ["ms"] = 0, ["message"] = "Enter the Razorpay keys first." };
                await razorpay.OrderPaymentsAsync("order_pixcart_connection_test");
            }
            else
            {
                if (!GatewayConfig.Configured(cfg, code)) return new JsonObject { ["ok"] = false, ["ms"] = 0, ["message"] = "Enter the keys on Admin → Integrations first." };
                await GatewayConfig.Build(Client(10), cfg, code).PingAsync();
            }
        }
        catch (RazorpayBAL.GatewayException e) when (code != "razorpay" || !e.Message.Contains("does not exist", StringComparison.OrdinalIgnoreCase))
        {
            var ms = (int)sw.ElapsedMilliseconds;
            await PaymentRouting.RecordAsync(db, code, false, ms, e.Message);
            return new JsonObject { ["ok"] = false, ["ms"] = ms, ["message"] = e.Message.Length > 200 ? e.Message[..200] : e.Message };
        }
        var took = (int)sw.ElapsedMilliseconds;
        await PaymentRouting.RecordAsync(db, code, true, took);
        log.LogInformation("payment gateway test {Code} ok in {Ms} ms", code, took);
        return new JsonObject { ["ok"] = true, ["ms"] = took, ["message"] = "Connected." };
    }
}
