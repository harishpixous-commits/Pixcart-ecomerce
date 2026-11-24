using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using BAL.AI;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Model.DomainModel.AI;
using Utils;

namespace BAL;

/// <summary>
/// AI studio: one path for every AI draft. request → task registry (what may run, for whom) → AI settings (switches,
/// budget, model, brand voice) → subject snapshot (only the facts the task needs) → layered prompt (frozen rules | brand |
/// request) → the "studio" route (any provider, with fallbacks), or the sandbox when no model is connected → parse and
/// validate → AI run record (tokens, cost, latency, status) → a person applies, edits, sends or discards it.
/// Also the deterministic risk briefs for sellers and orders.
/// </summary>
public class AiBAL(AiDAL dal, ILlmConfigBAL llmConfig, ILlmRouterBAL router, IAccessBAL access, AppSettings env, ILogger<AiBAL> log) : IAiBAL
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    // ---------------------------------------------------------------- mode

    public async Task<bool> ConfiguredAsync(string route = "studio") => (await llmConfig.TargetsAsync(route)).Count > 0;

    /// <summary>live when a model is connected (and, in tests, providers are faked); otherwise sandbox, which returns marked placeholder text.</summary>
    public async Task<string> ModeAsync()
    {
        if (env.IsTest && LlmTransport.TestHandler is null) return "sandbox";
        return await ConfiguredAsync() ? "live" : "sandbox";
    }

    public async Task<bool> AvailableAsync(string task)
    {
        var cfg = await AiSettings.GetAsync(dal, env);
        return J.Truthy(cfg["enabled"]) && AiSettings.Task(cfg, task).Enabled;
    }

    public async Task<JsonObject> UsageThisMonthAsync()
    {
        var u = await dal.UsageSinceAsync(AiShared.MonthStartUtc());
        return J.O(("runs", u.Runs), ("input_tokens", u.Input), ("output_tokens", u.Output), ("cache_read_tokens", u.CacheRead));
    }

    // ---------------------------------------------------------------- subject snapshots (only the facts a task needs; no phone, email or address)

    private static string Money2(long paise) => "₹" + (paise / 100.0).ToString("#,##0.00", Inv);

    private static string PyFloat(double v) => v == Math.Floor(v) && Math.Abs(v) < 1e15 ? v.ToString("0.0", Inv) : v.ToString("0.0###############", Inv);

    private async Task<JsonObject?> LoadAsync(string subject, string sid, Guid? sellerId)
    {
        Guid.TryParse(sid, out var id);
        switch (subject)
        {
            case "product":
            {
                var p = id != Guid.Empty ? await dal.GetProductAsync(id) : null;
                if (p is null || (sellerId.HasValue && p.SellerId != sellerId)) return null;
                var cat = await dal.GetCategoryAsync(p.CategoryId);
                var snap = J.O(("title", p.Title), ("brand", p.Brand), ("description", p.Description), ("highlights", J.Arr(p.Highlights)),
                    ("specs", J.Obj(p.Specs)), ("hsn_code", p.HsnCode), ("gst_bps", p.GstBps), ("category_name", cat?.Name ?? ""));
                snap["variants"] = J.A((await dal.VariantsAsync(p.Id)).Select(v => (object?)J.O(("mrp", v.MrpPaise / 100.0), ("price", v.PricePaise / 100.0))));
                snap["reviews"] = J.A((await dal.PublishedReviewsAsync(p.Id, 60)).Select(r => (object?)J.A([r.Rating, r.Body])));
                return snap;
            }
            case "ticket":
            {
                var t = id != Guid.Empty ? await dal.GetTicketAsync(id) : null;
                if (t is null) return null;
                var user = await dal.GetUserAsync(t.UserId);
                var msgs = await dal.PublicTicketMessagesAsync(t.Id);
                string? orderLine = null;
                if (t.OrderId is { } oid && await dal.GetOrderAsync(oid) is { } order)
                {
                    var subs = await dal.OrderPackagesAsync(order.Id);
                    orderLine = $"{order.Number}, payment {order.PaymentMethod} ({order.PaymentStatus}); packages: " + string.Join(", ", subs.Select(s => $"{s.Number} {s.Status}"));
                }
                return J.O(("number", t.Number), ("subject", t.Subject), ("category", t.Category), ("first_name", (user?.Name ?? "").Split(' ')[0]),
                    ("order", orderLine), ("messages", J.A(msgs.Select(m => (object?)J.O(("who", m.AuthorRole == "staff" ? "Support" : "Customer"), ("body", m.Body))))));
            }
            case "order":
            {
                var o = id != Guid.Empty ? await dal.GetOrderAsync(id) : null;
                if (o is null) return null;
                var user = await dal.GetUserAsync(o.UserId);
                var subs = await dal.OrderPackagesAsync(o.Id);
                return J.O(("number", o.Number), ("first_name", (user?.Name ?? "").Split(' ')[0]), ("placed", o.PlacedAt is { } pa ? DateTimeFunctions.ToIst(pa).ToString("dd MMM yyyy", Inv) : ""),
                    ("total", Money2(o.GrandTotal)), ("payment", $"{o.PaymentMethod} ({o.PaymentStatus})"), ("link", $"{env.PublicWebUrl}/orders/{o.Id}"),
                    ("packages", J.A(subs.Select(s => (object?)J.O(("number", s.Number), ("seller", s.SellerName), ("status", s.Status), ("tracking", s.TrackingNumber))))),
                    ("_user_id", o.UserId.ToString()));
            }
            case "review":
            {
                var r = id != Guid.Empty ? await dal.GetReviewAsync(id) : null;
                if (r is null) return null;
                var p = await dal.GetProductAsync(r.ProductId);
                if (sellerId.HasValue && p?.SellerId != sellerId) return null;
                return J.O(("product", p?.Title ?? ""), ("rating", r.Rating), ("title", r.Title), ("body", r.Body));
            }
            case "kpis":
            {
                var days = int.TryParse(sid, out var d) && sid.All(char.IsDigit) && d is >= 7 and <= 365 ? d : 7;
                var today = DateOnly.FromDateTime(DateTimeFunctions.ToIst(DateTimeFunctions.UtcNow()));
                var startDay = today.AddDays(-(days - 1));
                var start = DateTimeFunctions.IstToUtc(startDay.ToDateTime(TimeOnly.MinValue));
                var end = DateTimeFunctions.IstToUtc(today.AddDays(1).ToDateTime(TimeOnly.MinValue));
                var k = await dal.KpisAsync(start, end, start - (end - start), startDay, today);
                string Rs(long paise) => "₹" + (paise / 100.0).ToString("#,##0", Inv);
                var gmv = (long)k["gmv"]!;
                var prev = (long)k["gmv_prev"]!;
                var change = prev != 0 ? Math.Round((gmv - prev) * 100.0 / prev, MidpointRounding.ToEven).ToString("0", Inv) + "%" : "no earlier data";
                var top = (List<string>)k["top_products"]!;
                return J.O(("period", $"last {days} days"), ("sales", Rs(gmv)), ("sales_change", change), ("orders", (long)k["orders"]!), ("average_order", Rs((long)k["aov"]!)),
                    ("commission", Rs((long)k["commission"]!)), ("coupon_cost", Rs((long)k["discounts"]!)), ("cancelled_packages", PyFloat((double)k["cancellation_rate"]!) + "%"),
                    ("returns_after_delivery", PyFloat((double)k["return_rate"]!) + "%"), ("average_hours_to_ship", k["avg_hours_to_ship"] is double h ? h : null),
                    ("product_views", (long)k["views"]!), ("view_to_order", PyFloat((double)k["conversion_rate"]!) + "%"), ("new_customers", (long)k["new_customers"]!),
                    ("repeat_buyers", PyFloat((double)k["repeat_buyer_rate"]!) + "%"), ("tickets_past_reply_limit", (long)k["tickets_ack_overdue"]!),
                    ("top_products", top.Count > 0 ? string.Join(", ", top.Take(3)) : "none"));
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- running a task

    private static string BrandBlock(JsonObject site, JsonObject cfg, string instructions)
    {
        var b = AiShared.Business(site);
        var voice = J.S(cfg["brand_voice"]);
        var lines = new List<string>
        {
            $"Marketplace: {b.Brand} (operated by {b.LegalName}).",
            "Market: India. Currency INR (₹). Dates as DD Month YYYY.",
            $"Brand voice: {(voice.Length > 0 ? voice : "clear and respectful")}",
        };
        if (b.SupportEmail.Length > 0 || b.SupportPhone.Length > 0)
            lines.Add($"Customer care: {string.Join(", ", new[] { b.SupportEmail, b.SupportPhone }.Where(x => x.Length > 0))}");
        if (instructions.Length > 0)
            lines.Add($"Extra instructions from the marketplace team (follow them unless they conflict with the rules above): {instructions}");
        return string.Join("\n", lines);
    }

    public async Task<(AiRunModel Run, JsonObject Output)> RunAsync(string taskKey, UserModel? actor, JsonObject inputs, string subjectId = "", Guid? sellerId = null)
    {
        if (!AiTasks.All.TryGetValue(taskKey, out var task)) throw new NotFoundException("AI task");
        var cfg = await AiSettings.GetAsync(dal, env);
        var tcfg = AiSettings.Task(cfg, taskKey);
        if (!J.Truthy(cfg["enabled"])) throw new AppException("AI help is switched off in AI studio", "ai_off", 409);
        if (!tcfg.Enabled) throw new AppException($"{task.Label} is switched off in AI studio", "ai_task_off", 409);
        if (actor != null) await dal.RateLimitAsync($"ai:{actor.Id}", 40, 3600);

        var snap = new JsonObject();
        if (task.Subject.Length > 0)
        {
            snap = await LoadAsync(task.Subject, subjectId, sellerId) ?? [];
            if (snap.Count == 0) throw new NotFoundException(char.ToUpperInvariant(task.Subject[0]) + task.Subject[1..]);
        }
        var current = await ModeAsync();
        var budget = J.Long(cfg["monthly_token_budget"]) ?? 0;
        if (current == "live" && budget > 0)
        {
            var used = await dal.UsageSinceAsync(AiShared.MonthStartUtc());
            if (used.Input + used.Output >= budget)
                throw new AppException("This month's AI budget is used up. Raise it in AI studio or wait for next month.", "ai_budget", 429);
        }
        var modelInputs = new JsonObject();
        foreach (var (k, v) in snap) if (!k.StartsWith('_')) modelInputs[k] = v?.DeepClone();
        var record = new AiRunModel
        {
            Id = Guid.NewGuid(), Task = taskKey, SubjectType = task.Subject, SubjectId = J.Cut(subjectId, 40), SellerId = sellerId, Inputs = J.Dumps(inputs),
            Output = "{}", Status = "draft", Mode = current, CreatedBy = actor?.Id, CreatedAt = DateTimeFunctions.UtcNow(),
        };
        JsonObject parsed;
        try
        {
            if (current == "live")
            {
                var site = await AiShared.SiteAsync(dal, env);
                var sw = Stopwatch.StartNew();
                var (turn, used) = await router.CompleteAsync("studio",
                    [new SystemBlock(task.Rules, true), new SystemBlock(BrandBlock(site, cfg, tcfg.Instructions), true)],
                    task.Build(inputs, modelInputs), task.MaxTokens);
                parsed = task.Parse(turn.Text.Trim());
                record.Model = J.Cut(string.IsNullOrEmpty(turn.Model) ? used.Model : turn.Model, 80);
                record.LatencyMs = (int)sw.ElapsedMilliseconds;
                record.InputTokens = turn.InputTokens;
                record.OutputTokens = turn.OutputTokens;
                record.CacheCreationTokens = turn.CacheCreationTokens;
                record.CacheReadTokens = turn.CacheReadTokens;
            }
            else
            {
                parsed = task.Parse(task.Sandbox(inputs, modelInputs));
                record.Model = "sandbox";
            }
        }
        catch (AppException exc)
        {
            // keep a record of failures (for the AI studio log) even though the request fails
            record.Status = "failed";
            record.Error = J.Cut(exc.Message, 300);
            await dal.InsertRunAsync(record);
            throw;
        }
        if (taskKey == "listing_check")
        {
            // rule-based findings are always included, whatever the model says
            var rules = AiTasks.RuleCheck(modelInputs);
            var issues = (parsed["issues"] as JsonArray ?? []).Select(J.S).Concat((rules["issues"] as JsonArray ?? []).Select(J.S)).Distinct();
            parsed["issues"] = J.Strings(issues);
            var rr = J.S(rules["risk"]);
            if (rr == "high" || (rr == "medium" && J.S(parsed["risk"]) == "low")) parsed["risk"] = rr;
        }
        record.Output = J.Dumps(parsed);
        await dal.InsertRunAsync(record);
        if (actor != null) await dal.AuditAsync(actor.Id, $"ai.{taskKey}", "ai_run", record.Id, $"{current} {record.Model}");
        return (record, parsed);
    }

    public JsonObject RunOut(AiRunModel r, JsonObject? cfg = null) => J.O(
        ("id", r.Id.ToString()), ("task", r.Task), ("task_label", AiTasks.All.TryGetValue(r.Task, out var t) ? t.Label : r.Task), ("subject_type", r.SubjectType),
        ("subject_id", r.SubjectId), ("status", r.Status), ("mode", r.Mode), ("model", r.Model), ("output", J.Parse(r.Output)), ("final_text", r.FinalText),
        ("error", r.Error), ("input_tokens", r.InputTokens), ("output_tokens", r.OutputTokens), ("cache_creation_tokens", r.CacheCreationTokens),
        ("cache_read_tokens", r.CacheReadTokens), ("latency_ms", r.LatencyMs),
        ("cost_usd", cfg != null ? AiSettings.CostUsd(cfg, r.InputTokens + r.CacheCreationTokens, r.OutputTokens) : null),
        ("created_at", DateTimeFunctions.Iso(r.CreatedAt)), ("reviewed_at", AiShared.Iso(r.ReviewedAt)));

    /// <summary>Records what a person did with a draft: applied, sent or discarded. Null when it is not an open draft (of this seller).</summary>
    public async Task<AiRunModel?> FinishAsync(string runId, string status, UserModel actor, string finalText = "", Guid? sellerId = null)
    {
        if (!Guid.TryParse(runId, out var id)) return null;
        var r = await dal.GetRunAsync(id);
        if (r is null || (sellerId.HasValue && r.SellerId != sellerId) || r.Status != "draft") return null;
        if (!await dal.FinishRunAsync(id, status, J.Cut(finalText, 10000), actor.Id, sellerId)) return null;
        return await dal.GetRunAsync(id);
    }

    // ---------------------------------------------------------------- AI studio (admin)

    public async Task<JsonObject> StudioAsync()
    {
        var cfg = await AiSettings.GetAsync(dal, env);
        var used = await UsageThisMonthAsync();
        var since = AiShared.MonthStartUtc();
        var byTask = await dal.RunCountsByTaskAsync(since, false);
        var applied = await dal.RunCountsByTaskAsync(since, true);
        var budget = J.Long(cfg["monthly_token_budget"]) ?? 0;
        var input = J.Long(used["input_tokens"]) ?? 0;
        var output = J.Long(used["output_tokens"]) ?? 0;
        var usage = J.Merge(used, J.O(("cost_usd", AiSettings.CostUsd(cfg, input, output)), ("budget_left", budget > 0 ? Math.Max(0, budget - input - output) : null)));
        var tasks = new JsonArray();
        foreach (var t in AiTasks.All.Values)
        {
            var ts = AiSettings.Task(cfg, t.Key);
            tasks.Add(J.O(("key", t.Key), ("label", t.Label), ("description", t.Description), ("audience", t.Audience), ("output", t.Output), ("rules", t.Rules),
                ("enabled", ts.Enabled), ("instructions", ts.Instructions), ("runs_this_month", byTask.GetValueOrDefault(t.Key)),
                ("used_this_month", applied.GetValueOrDefault(t.Key))));
        }
        return J.O(("settings", cfg), ("status", J.O(("mode", await ModeAsync()), ("key_configured", await ConfiguredAsync()), ("environment", env.Environment))),
            ("models", AiSettings.Models()), ("usage", usage), ("tasks", tasks));
    }

    public async Task<JsonObject> SaveStudioAsync(JsonObject body, UserModel admin)
    {
        JsonObject cfg;
        try
        {
            cfg = AiSettings.Validate(body, AiTasks.All.Keys, env);
        }
        catch (ArgumentException exc)
        {
            throw new AppException(exc.Message, "invalid_ai_settings");
        }
        await dal.SaveSettingAsync(AiSettings.Key, cfg);
        await dal.AuditAsync(admin.Id, "ai.settings", "settings", "ai", $"enabled={(J.Truthy(cfg["enabled"]) ? "True" : "False")} model={J.S(cfg["model"])}");
        return await StudioAsync();
    }

    public async Task<JsonObject> RunsAsync(string? task, string? status, int page)
    {
        var cfg = await AiSettings.GetAsync(dal, env);
        var (total, rows) = await dal.ListRunsAsync(task, status, page, 30);
        var items = new JsonArray();
        foreach (var r in rows) items.Add(J.Merge(RunOut(r, cfg), J.O(("by", string.IsNullOrEmpty(r.ByName) ? "System" : r.ByName))));
        return J.O(("items", items), ("total", total), ("page", page), ("page_size", 30));
    }

    public async Task<JsonObject> RunDetailAsync(Guid id)
    {
        var r = await dal.GetRunAsync(id) ?? throw new NotFoundException("AI run");
        return J.Merge(RunOut(r, await AiSettings.GetAsync(dal, env)), J.O(("inputs", J.Parse(r.Inputs))));
    }

    private async Task<JsonObject> InputsAsync(string task, AiRunIn body)
    {
        if (task == "listing_writer")
        {
            if (body.Notes.Trim().Length < 20)
                throw new AppException("Describe the product in at least 20 characters", "notes_too_short", 400, new Dictionary<string, string> { ["notes"] = "Too short" });
            var cat = body.CategoryId is { } cid ? await dal.GetCategoryAsync(cid) : null;
            return J.O(("notes", body.Notes.Trim()), ("category", cat?.Name ?? ""), ("brand", body.Brand.Trim()));
        }
        if (task == "customer_message" && body.Intent.Trim().Length < 5)
            throw new AppException("Say what the message should tell the customer", "intent_required", 400, new Dictionary<string, string> { ["intent"] = "Required" });
        return J.O(("tone", AiTasks.Tones.Contains(body.Tone) ? body.Tone : "friendly"), ("intent", body.Intent.Trim()));
    }

    public async Task<JsonObject> AdminRunAsync(string task, AiRunIn body, UserModel admin)
    {
        if (!AiTasks.All.TryGetValue(task, out var spec) || spec.Audience != "admin") throw new NotFoundException("AI task");
        access.Invalidate(); // the role's permissions as the owner set them now
        if (!(await access.PermissionsForAsync(admin)).Contains(spec.Permission)) throw new ForbiddenException($"Your role does not allow this ({spec.Permission})");
        var (r, _) = await RunAsync(task, admin, await InputsAsync(task, body), body.SubjectId);
        return RunOut(r, await AiSettings.GetAsync(dal, env));
    }

    private async Task<AiRunModel> OwnAdminRunAsync(Guid runId, UserModel admin)
    {
        access.Invalidate();
        var r = await dal.GetRunAsync(runId);
        if (r is null || r.SellerId != null) throw new NotFoundException("AI draft");
        if (AiTasks.All.TryGetValue(r.Task, out var spec) && spec.Permission.Length > 0 && !(await access.PermissionsForAsync(admin)).Contains(spec.Permission))
            throw new ForbiddenException("Your role does not allow this");
        return r;
    }

    public async Task<JsonObject> AdminSendAsync(Guid runId, AiSendIn body, UserModel admin)
    {
        var r = await OwnAdminRunAsync(runId, admin);
        if (r.Task != "customer_message" || r.Status != "draft") throw new AppException("Only an unsent customer message draft can be sent", "ai_run_closed", 409);
        var order = Guid.TryParse(r.SubjectId, out var oid) ? await dal.GetOrderAsync(oid) : null;
        var customer = order != null ? await dal.GetUserAsync(order.UserId) : null;
        if (customer is null || customer.DeletedAt != null) throw new AppException("The customer's account is closed", "customer_gone", 409);
        await AiShared.NotifyAsync(dal, env, customer, "staff_message",
            new() { ["subject"] = body.Subject.Trim(), ["message"] = body.Text.Trim(), ["order_number"] = order!.Number }, $"/orders/{order.Id}", ["inapp", "email"]);
        var done = await FinishAsync(runId.ToString(), "sent", admin, $"{body.Subject}\n\n{body.Text}");
        await dal.AuditAsync(admin.Id, "ai.customer_message.sent", "order", order.Id, J.Cut(body.Subject, 200));
        return RunOut(done ?? r);
    }

    public async Task<JsonObject> AdminFinishAsync(Guid runId, string action, AiFinishIn body, UserModel admin)
    {
        await OwnAdminRunAsync(runId, admin);
        var r = await FinishAsync(runId.ToString(), action == "apply" ? "applied" : "discarded", admin, body.FinalText)
                ?? throw new AppException("This draft was already used or discarded", "ai_run_closed", 409);
        return RunOut(r);
    }

    public async Task<JsonObject> SellerRunAsync(string task, AiRunIn body, SellerModel seller, UserModel user)
    {
        if (!AiTasks.All.TryGetValue(task, out var spec) || spec.Audience != "seller") throw new NotFoundException("AI task");
        var (r, _) = await RunAsync(task, user, await InputsAsync(task, body), body.SubjectId, seller.Id);
        return RunOut(r);
    }

    public async Task<JsonObject> SellerFinishAsync(Guid runId, string action, AiFinishIn body, SellerModel seller, UserModel user)
    {
        var r = await FinishAsync(runId.ToString(), action == "apply" ? "applied" : "discarded", user, body.FinalText, seller.Id) ?? throw new NotFoundException("AI draft");
        return RunOut(r);
    }

    public async Task<JsonObject> SellerListingAsync(AiRunIn body, SellerModel seller, UserModel user)
    {
        var (r, outp) = await RunAsync("listing_writer", user, await InputsAsync("listing_writer", body), "", seller.Id);
        return J.Merge(outp, J.O(("run_id", r.Id.ToString()), ("mode", r.Mode)));
    }

    // ---------------------------------------------------------------- deterministic risk briefs

    private static readonly (string Level, int Ceiling)[] Buckets = [("GREEN", 30), ("AMBER", 60), ("RED", 101)];

    private static readonly Dictionary<string, string> Headlines = new()
    {
        ["GREEN"] = "Low risk: looks routine", ["AMBER"] = "Worth a look: a few flags", ["RED"] = "High risk: check before acting",
    };

    private static JsonObject BriefResult(List<(int Weight, string Text)> factors, List<string> notes, bool insufficient)
    {
        var score = Math.Min(100, factors.Sum(f => f.Weight));
        var level = Buckets.First(b => score < b.Ceiling).Level;
        return J.O(("score", score), ("level", level), ("headline", Headlines[level]),
            ("factors", J.A(factors.Select(f => (object?)J.O(("weight", f.Weight), ("text", f.Text))))), ("notes", J.Strings(notes)), ("insufficient_history", insufficient));
    }

    public async Task<JsonObject> SellerRiskAsync(SellerModel seller)
    {
        var now = DateTimeFunctions.UtcNow();
        var c = await dal.SellerRiskAsync(seller.Id, now.AddDays(-90), Math.Max(1, seller.DispatchDays) + 1);
        var factors = new List<(int, string)>();
        var notes = new List<string> { $"{c.Total} packages in the last 90 days, {c.Delivered} delivered." };
        if (c.Total > 0)
        {
            var cancel = (double)c.CancelledBySeller / c.Total;
            if (cancel > 0.05) factors.Add((Math.Min(35, (int)(cancel * 200)), $"Seller cancelled {AiShared.Pct0(cancel)} of packages (target under 5%)"));
            var late = (double)c.Late / c.Total;
            if (late > 0.1) factors.Add((Math.Min(25, (int)(late * 100)), $"{AiShared.Pct0(late)} shipped later than promised"));
            var rto = (double)c.Rto / c.Total;
            if (rto > 0.1) factors.Add((Math.Min(25, (int)(rto * 100)), $"{AiShared.Pct0(rto)} of packages came back undelivered (RTO), by the seller's own courier"));
        }
        if (c.Rto > 0) notes.Add($"{c.Rto} package(s) marked as returned to the seller (RTO).");
        if (c.Delivered > 0)
        {
            var rr = (double)c.Returns / c.Delivered;
            if (rr > 0.1) factors.Add((Math.Min(25, (int)(rr * 120)), $"Return rate {AiShared.Pct0(rr)} (target under 10%)"));
        }
        if (seller.RatingCount >= 5 && (double)seller.RatingAvg < 3.5)
            factors.Add((20, $"Store rating {((double)seller.RatingAvg).ToString("0.0", Inv)} from {seller.RatingCount} reviews"));
        if (c.RejectedListings >= 3) factors.Add((10, $"{c.RejectedListings} listings rejected in moderation"));
        if (seller.ApprovedAt is { } ap && now - ap < TimeSpan.FromDays(30)) factors.Add((10, "Approved less than 30 days ago"));
        return BriefResult(factors, notes, c.Total < 5);
    }

    public async Task<JsonObject> OrderRiskAsync(OrderModel order)
    {
        var user = await dal.GetUserAsync(order.UserId);
        var shipTo = J.Obj(order.ShipTo);
        var pin = J.S(shipTo["pincode"]);
        var c = await dal.OrderRiskAsync(order.UserId, pin);
        var factors = new List<(int, string)>();
        var notes = new List<string> { $"Customer has {c.Placed} placed orders, {c.Returns} returns and {c.Tickets} support tickets." };
        if (order.PaymentMethod == "cod")
        {
            if (order.GrandTotal >= 500_000) factors.Add((25, "Cash on delivery above ₹5,000"));
            else if (order.GrandTotal >= 200_000) factors.Add((10, "Cash on delivery above ₹2,000"));
        }
        if (user != null && DateTimeFunctions.UtcNow() - user.CreatedAt < TimeSpan.FromDays(2)) factors.Add((15, "Account created in the last 2 days"));
        if (c.Placed <= 1) factors.Add((10, "First order"));
        if (c.Cancelled >= 3) factors.Add((20, $"Customer cancelled {c.Cancelled} packages before"));
        if (c.Returns >= 3 && c.Placed > 0 && (double)c.Returns / c.Placed > 0.5) factors.Add((20, $"Returned {c.Returns} times across {c.Placed} orders"));
        if (c.RtoPin >= 3) factors.Add((15, $"{c.RtoPin} shipments to PIN {(shipTo["pincode"] is null ? "None" : pin)} came back undelivered"));
        if (order.CouponCode.Length > 0 && c.Placed <= 1 && order.DiscountTotal >= 20_000) factors.Add((5, $"Large first-order coupon ({order.CouponCode})"));
        return BriefResult(factors, notes, c.Placed < 2);
    }

    public async Task<JsonObject> SellerBriefAsync(Guid sellerId) =>
        await SellerRiskAsync(await dal.GetSellerAsync(sellerId) ?? throw new NotFoundException("Seller"));

    public async Task<JsonObject> OrderBriefAsync(Guid orderId) =>
        await OrderRiskAsync(await dal.GetOrderAsync(orderId) ?? throw new NotFoundException("Order"));

    // ---------------------------------------------------------------- jobs

    /// <summary>
    /// Hourly: short review summaries for busy product pages. Written only by a real model, never the sandbox, because
    /// they are published on the store.
    /// </summary>
    public async Task ReviewSummaryJobAsync()
    {
        if (await ModeAsync() != "live" || !await AvailableAsync("review_summary")) return;
        foreach (var p in await dal.ProductsNeedingSummaryAsync())
        {
            if ((await dal.PublishedReviewsAsync(p.Id, 60, withBody: true)).Count < 3) continue;
            try
            {
                var (run, outp) = await RunAsync("review_summary", null, [], p.Id.ToString());
                var text = J.S(outp["text"]);
                await dal.SaveReviewSummaryAsync(p.Id, text, p.RatingCount);
                await dal.SetRunAppliedAsync(run.Id, text);
            }
            catch (Exception exc) when (exc is AppException or LlmNetworkException)
            {
                log.LogWarning("review summary for {Product} failed: {Error}", p.Id, exc.Message); // keep the old summary; try again next hour
            }
        }
    }

    /// <summary>Files given to the AI assistant are kept for 7 days only; stale action proposals expire.</summary>
    public async Task CleanupJobAsync()
    {
        await dal.DeleteExpiredUploadsAsync();
        await dal.ExpireStaleActionsAsync();
    }
}
