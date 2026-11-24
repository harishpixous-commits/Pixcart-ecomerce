namespace BAL;

using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

/// <summary>
/// AI studio service (reference: app/ai/service.py, settings.py, briefs.py; services/analytics.py kpis).
/// Runs one task at a time and records it. The provider call is fail-closed here: no LLM connection can be
/// configured locally, so mode is always "sandbox" and every draft is the marked placeholder text.
/// </summary>
public class AiBAL(
    AiDAL ai,
    OrdersDAL orders,
    CatalogDAL catalog,
    SettingsDAL settings,
    IIntegrationBAL integrations,
    ISiteBAL site,
    IRateLimitBAL rateLimit,
    AuditDAL audit,
    AppSettings app,
    IMySqlDapperHelper db) : IAiBAL
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);
    public const string SettingsKey = "ai";
    private static readonly Regex ModelId = new(@"^claude-[a-z0-9][a-z0-9.\-]{2,60}$", RegexOptions.Compiled);

    public static readonly JsonArray Models = new(
        new JsonObject { ["id"] = "claude-haiku-5-5", ["label"] = "Claude Haiku 5.5 — fastest, lowest cost" },
        new JsonObject { ["id"] = "claude-sonnet-5-5", ["label"] = "Claude Sonnet 5.5 — balanced" },
        new JsonObject { ["id"] = "claude-opus-5-5", ["label"] = "Claude Opus 5.5 — most capable" });

    private JsonObject Defaults() => new()
    {
        ["enabled"] = true,
        ["model"] = "claude-haiku-5-5",
        ["monthly_token_budget"] = 5_000_000,
        ["price_input_per_mtok"] = 1.0,
        ["price_output_per_mtok"] = 5.0,
        ["brand_voice"] = "Warm, clear and respectful of the shopper's time. Simple Indian English.",
        ["tasks"] = new JsonObject(),
    };

    /// <summary>Reads a JSON number as a whole number, whatever node kind it arrives as.</summary>
    private static long Long(JsonNode? node, string field)
    {
        if (node is JsonValue v)
        {
            if (v.TryGetValue<long>(out var l)) return l;
            if (v.TryGetValue<int>(out var i)) return i;
        }
        if (long.TryParse(node?.ToJsonString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var p)) return p;
        throw new AppException($"{field} must be a whole number", "invalid_ai_settings");
    }

    public async Task<JsonObject> GetSettingsAsync() => SettingsDAL.Merge(Defaults(), await settings.GetAsync(SettingsKey));

    /// <summary>Reference: ai.settings.task_settings.</summary>
    public static (bool Enabled, string Instructions) TaskSettings(JsonObject cfg, string task)
    {
        var t = cfg["tasks"]?[task] as JsonObject;
        return (t?["enabled"]?.GetValue<bool>() ?? true, t?["instructions"]?.GetValue<string>() ?? "");
    }

    /// <summary>Reference: ai.settings.validate.</summary>
    private JsonObject Validate(JsonObject data)
    {
        var cfg = SettingsDAL.Merge(Defaults(), data);
        if (cfg["enabled"] is not JsonValue ev || !ev.TryGetValue<bool>(out var enabled))
            throw new AppException("enabled must be true or false", "invalid_ai_settings");
        cfg["enabled"] = enabled;
        if (!ModelId.IsMatch(cfg["model"]?.GetValue<string>() ?? ""))
            throw new AppException("Choose a Claude model, e.g. claude-haiku-5-5", "invalid_ai_settings");
        var budget = Long(cfg["monthly_token_budget"], "monthly_token_budget");
        if (budget < 0 || budget > 2_000_000_000)
            throw new AppException("The monthly token budget must be a whole number (0 for no limit)", "invalid_ai_settings");
        foreach (var k in new[] { "price_input_per_mtok", "price_output_per_mtok" })
        {
            if (cfg[k] is not JsonValue pv || !pv.TryGetValue<double>(out var price) || price < 0 || price > 1000)
                throw new AppException("Prices must be numbers between 0 and 1000", "invalid_ai_settings");
        }
        var voice = Regex.Replace(cfg["brand_voice"]?.GetValue<string>() ?? "", @"[\x00-\x08\x0b-\x1f\x7f]", "");
        cfg["brand_voice"] = voice[..Math.Min(600, voice.Length)].Trim();
        var tasks = new JsonObject();
        if (data["tasks"] is JsonObject t)
            foreach (var (k, v) in t)
                if (AiTasks.Tasks.ContainsKey(k) && v is JsonObject tv)
                {
                    var ins = Regex.Replace(tv["instructions"]?.GetValue<string>() ?? "", @"[\x00-\x08\x0b-\x1f\x7f]", "");
                    var on = tv["enabled"] is JsonValue tvOn && tvOn.TryGetValue<bool>(out var tvB) ? tvB : true;
                    tasks[k] = new JsonObject
                    {
                        ["enabled"] = on,
                        ["instructions"] = ins[..Math.Min(1000, ins.Length)].Trim(),
                    };
                }
        cfg["tasks"] = tasks;
        return cfg;
    }

    public async Task<JsonObject> SaveSettingsAsync(UserModel actor, JsonObject data)
    {
        var cfg = Validate(data);
        await settings.SaveAsync(SettingsKey, cfg);
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = actor.Id, Action = "ai.settings", EntityType = "settings",
            EntityId = "ai", Detail = $"enabled={cfg["enabled"]?.GetValue<bool>()} model={cfg["model"]?.GetValue<string>()}",
            CreatedAt = DateTimeFunctions.UtcNow(),
        });
        return cfg;
    }

    /// <summary>Reference: routers/ai.py _inputs.</summary>
    public async Task<JsonObject> InputsAsync(string task, string notes, Guid? categoryId, string brand, string tone, string intent)
    {
        if (task == "listing_writer")
        {
            var trimmed = notes.Trim();
            if (trimmed.Length < 20)
                throw new AppException("Describe the product in at least 20 characters", "notes_too_short",
                    fields: new Dictionary<string, string> { ["notes"] = "Too short" });
            var category = categoryId is { } cid ? await ai.CategoryNameAsync(cid) ?? "" : "";
            return new JsonObject { ["notes"] = trimmed, ["category"] = category, ["brand"] = brand.Trim() };
        }
        if (task == "customer_message" && intent.Trim().Length < 5)
            throw new AppException("Say what the message should tell the customer", "intent_required",
                fields: new Dictionary<string, string> { ["intent"] = "Required" });
        return new JsonObject
        {
            ["tone"] = AiTasks.Tones.Contains(tone) ? tone : "friendly",
            ["intent"] = intent.Trim(),
        };
    }

    public double CostUsd(JsonObject cfg, long inputTokens, long outputTokens) =>
        Math.Round(inputTokens / 1e6 * cfg["price_input_per_mtok"]!.GetValue<double>() +
                   outputTokens / 1e6 * cfg["price_output_per_mtok"]!.GetValue<double>(), 4);

    // ---------------------------------------------------------------- mode

    /// <summary>Reference: llm.config.targets("studio") non-empty, or the builtin key from Integrations.</summary>
    public async Task<bool> ConfiguredAsync()
    {
        var llm = await settings.GetAsync("llm");
        var conns = llm["connections"] as JsonArray ?? new JsonArray();
        var enabled = conns.OfType<JsonObject>().Where(c => c["enabled"]?.GetValue<bool>() ?? true)
            .Select(c => c["id"]?.GetValue<string>() ?? "").ToHashSet();
        var routes = llm["routes"] as JsonObject ?? new JsonObject();
        var chain = routes["studio"] as JsonArray ?? routes["assistant"] as JsonArray ?? new JsonArray();
        foreach (var t in chain.OfType<JsonObject>())
            if (t["connection"]?.GetValue<string>() is { } id && enabled.Contains(id))
                return true;
        // builtin connection: the Claude key from Admin → Integrations
        return (await integrations.GetAsync()).AnthropicApiKey.Length > 0;
    }

    public Task<string> ModeAsync() => Task.FromResult("sandbox");
    // NOTE: reference is "live" when configured(); the provider call in RunAsync is fail-closed, so sandbox is
    // honest here. When a provider route is ever allowed, this becomes: ConfiguredAsync() ? "live" : "sandbox".

    // ---------------------------------------------------------------- budget

    public DateTime MonthStart()
    {
        var now = DateTimeFunctions.UtcNow() + Ist;
        return new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc) - Ist;
    }

    public async Task<JsonObject> UsageThisMonthAsync()
    {
        var u = await ai.UsageThisMonthAsync(MonthStart());
        return new JsonObject
        {
            ["runs"] = u.Runs, ["input_tokens"] = u.InputTokens,
            ["output_tokens"] = u.OutputTokens, ["cache_read_tokens"] = u.CacheReadTokens,
        };
    }

    // ---------------------------------------------------------------- subject snapshots

    private static Guid? ParseUuid(string value) => Guid.TryParse(value, out var g) ? g : null;

    private async Task<JsonObject?> LoadProductAsync(string sid, Guid? sellerId)
    {
        var id = ParseUuid(sid);
        var p = id is null ? null : await ai.ProductSnapshotAsync(id.Value);
        if (p is null || (sellerId is not null && p.SellerId != sellerId)) return null;
        var variants = (await ai.ProductVariantPricesAsync(p.Id))
            .Select(v => (JsonNode)new JsonObject { ["mrp"] = v.MrpPaise / 100.0, ["price"] = v.PricePaise / 100.0 }).ToArray();
        var reviews = (await ai.PublishedReviewsAsync(p.Id))
            .Select(r => (JsonNode)new JsonObject { ["rating"] = r.Rating, ["body"] = r.Body }).ToArray();
        return new JsonObject
        {
            ["title"] = p.Title, ["brand"] = p.Brand, ["description"] = p.Description,
            ["highlights"] = JsonNode.Parse(p.Highlights)?.DeepClone(), ["specs"] = JsonNode.Parse(p.Specs)?.DeepClone(),
            ["hsn_code"] = p.HsnCode, ["gst_bps"] = p.GstBps, ["category_name"] = p.CategoryName,
            ["variants"] = new JsonArray(variants), ["reviews"] = new JsonArray(reviews),
        };
    }

    private async Task<JsonObject?> LoadTicketAsync(string sid)
    {
        var id = ParseUuid(sid);
        var t = id is null ? null : await ai.TicketAsync(id.Value);
        if (t is null) return null;
        var user = await ai.UserBriefAsync(t.UserId);
        var msgs = await ai.TicketMessagesAsync(t.Id);
        string? orderLine = null;
        if (t.OrderId is { } oid)
        {
            var order = await orders.GetOrderAsync(oid);
            if (order is not null)
            {
                var subs = await ai.SubsWithSellerAsync(oid);
                orderLine = $"{order.Number}, payment {order.PaymentMethod} ({order.PaymentStatus}); packages: " +
                    string.Join(", ", subs.Select(s => $"{s.Number} {s.Status}"));
            }
        }
        return new JsonObject
        {
            ["number"] = t.Number, ["subject"] = t.Subject, ["category"] = t.Category,
            ["first_name"] = (user?.Name ?? "").Split(' ')[0],
            ["order"] = orderLine,
            ["messages"] = new JsonArray(msgs.Select(m => (JsonNode)new JsonObject
            {
                ["who"] = m.AuthorRole == "staff" ? "Support" : "Customer", ["body"] = m.Body,
            }).ToArray()),
        };
    }

    private async Task<JsonObject?> LoadOrderAsync(string sid)
    {
        var id = ParseUuid(sid);
        var o = id is null ? null : await orders.GetOrderAsync(id.Value);
        if (o is null) return null;
        var user = await ai.UserBriefAsync(o.UserId);
        var subs = await ai.SubsWithSellerAsync(o.Id);
        return new JsonObject
        {
            ["number"] = o.Number,
            ["first_name"] = (user?.Name ?? "").Split(' ')[0],
            ["placed"] = o.PlacedAt is { } placed
                ? (placed + Ist).ToString("dd MMM yyyy", CultureInfo.InvariantCulture) : "",
            ["total"] = $"₹{o.GrandTotal / 100.0:n2}",
            ["payment"] = $"{o.PaymentMethod} ({o.PaymentStatus})",
            ["link"] = $"{app.PublicWebUrl}/orders/{o.Id}",
            ["packages"] = new JsonArray(subs.Select(s => (JsonNode)new JsonObject
            {
                ["number"] = s.Number, ["seller"] = s.SellerName, ["status"] = s.Status, ["tracking"] = s.TrackingNumber,
            }).ToArray()),
            ["_user_id"] = o.UserId.ToString(),
        };
    }

    private async Task<JsonObject?> LoadReviewAsync(string sid, Guid? sellerId)
    {
        var id = ParseUuid(sid);
        var r = id is null ? null : await ai.ReviewSnapshotAsync(id.Value);
        if (r is null || (sellerId is not null && r.SellerId != sellerId)) return null;
        return new JsonObject { ["product"] = r.ProductTitle, ["rating"] = r.Rating, ["title"] = r.Title, ["body"] = r.Body };
    }

    /// <summary>Reference: services/analytics.py kpis (admin-wide; the brief task never passes a seller).</summary>
    private async Task<JsonObject> LoadKpisAsync(string sid)
    {
        var days = int.TryParse(sid, out var d) && d is >= 7 and <= 365 ? d : 7;
        var endD = DateOnly.FromDateTime(DateTimeFunctions.UtcNow() + Ist);
        var startD = endD.AddDays(-(days - 1));
        var start = startD.ToDateTime(TimeOnly.MinValue) - Ist;
        var end = endD.AddDays(1).ToDateTime(TimeOnly.MinValue) - Ist;
        var prevStart = start - (end - start);
        var cur = await ai.KpiPeriodAsync(start, end);
        var prev = await ai.KpiPeriodAsync(prevStart, start);
        var delivered = await ai.KpiDeliveredAsync(start, end);
        var returnsCount = await ai.KpiReturnsCountAsync(start, end);
        var shipHours = await ai.KpiShipHoursAsync(start, end);
        var (views, _) = await ai.KpiViewsCartsAsync(startD, endD);
        var top = await ai.KpiTopProductsAsync(start, end);
        var newCustomers = await ai.KpiNewCustomersAsync(start, end);
        var (repeat, buyers) = await ai.KpiRepeatBuyersAsync(start, end);
        var overdue = await ai.KpiOverdueTicketsAsync();

        static string Rs(long paise) => $"₹{paise / 100.0:n0}";
        static string Pct(long a, long b) => b > 0 ? $"{Math.Round(a * 100.0 / b, 1)}%" : "0%";
        var change = prev.Gmv > 0 ? $"{Math.Round((cur.Gmv - prev.Gmv) * 100.0 / prev.Gmv)}%" : "no earlier data";
        var topNames = string.Join(", ", top.Take(3).Select(t => t.Title));
        return new JsonObject
        {
            ["period"] = $"last {days} days",
            ["sales"] = Rs(cur.Gmv), ["sales_change"] = change, ["orders"] = cur.Orders,
            ["average_order"] = Rs(cur.Orders > 0 ? cur.Gmv / cur.Orders : 0),
            ["commission"] = Rs(cur.Commission), ["coupon_cost"] = Rs(cur.Discounts),
            ["cancelled_packages"] = Pct(cur.Cancelled, cur.Packages),
            ["returns_after_delivery"] = Pct(returnsCount, delivered),
            ["average_hours_to_ship"] = shipHours is { } h ? Math.Round(h, 1) : null,
            ["product_views"] = views,
            ["view_to_order"] = Pct(Math.Min(cur.Orders, views), views),
            ["new_customers"] = newCustomers,
            ["repeat_buyers"] = Pct(repeat, buyers),
            ["tickets_past_reply_limit"] = overdue,
            ["top_products"] = topNames.Length > 0 ? topNames : "none",
        };
    }

    // ---------------------------------------------------------------- running a task

    private string BrandBlock(JsonObject siteJson, JsonObject cfg, (bool Enabled, string Instructions) tcfg)
    {
        var b = site.PublicBusiness(siteJson);
        var lines = new List<string>
        {
            $"Marketplace: {b["brand"]?.GetValue<string>()} (operated by {b["legal_name"]?.GetValue<string>()}).",
            "Market: India. Currency INR (₹). Dates as DD Month YYYY.",
            $"Brand voice: {(cfg["brand_voice"]?.GetValue<string>() is { Length: > 0 } bv ? bv : "clear and respectful")}",
        };
        var care = string.Join(", ", new[] { b["support_email"]?.GetValue<string>(), b["support_phone"]?.GetValue<string>() }
            .Where(x => !string.IsNullOrEmpty(x)));
        if (care.Length > 0) lines.Add($"Customer care: {care}");
        if (tcfg.Instructions.Length > 0)
            lines.Add($"Extra instructions from the marketplace team (follow them unless they conflict with the rules above): {tcfg.Instructions}");
        return string.Join("\n", lines);
    }

    public async Task<(AiRunModel Run, JsonObject Output)> RunAsync(string taskKey, UserModel? actor, JsonObject inputs,
        string subjectId = "", Guid? sellerId = null)
    {
        if (!AiTasks.Tasks.TryGetValue(taskKey, out var task))
            throw new NotFoundException("AI task");
        var cfg = await GetSettingsAsync();
        var tcfg = TaskSettings(cfg, taskKey);
        if (cfg["enabled"]?.GetValue<bool>() is false)
            throw new AppException("AI help is switched off in AI studio", "ai_off", 409);
        if (!tcfg.Enabled)
            throw new AppException($"{task.Label} is switched off in AI studio", "ai_task_off", 409);
        if (actor is not null)
            await rateLimit.RateLimitAsync($"ai:{actor.Id}", 40, 3600);

        var snap = new JsonObject();
        if (task.Subject.Length > 0)
        {
            snap = task.Subject switch
            {
                "product" => await LoadProductAsync(subjectId, sellerId),
                "ticket" => await LoadTicketAsync(subjectId),
                "order" => await LoadOrderAsync(subjectId),
                "review" => await LoadReviewAsync(subjectId, sellerId),
                "kpis" => await LoadKpisAsync(subjectId),
                _ => null,
            } ?? new JsonObject();
            if (!snap.Any())
                throw new NotFoundException(char.ToUpper(task.Subject[0]) + task.Subject[1..]);
        }

        var current = await ModeAsync();
        if (current == "live" && Long(cfg["monthly_token_budget"], "monthly_token_budget") > 0)
        {
            var used = await ai.UsageThisMonthAsync(MonthStart());
            if (used.InputTokens + used.OutputTokens >= Long(cfg["monthly_token_budget"], "monthly_token_budget"))
                throw new AppException("This month's AI budget is used up. Raise it in AI studio or wait for next month.", "ai_budget", 429);
        }

        var modelInputs = new JsonObject(snap.Where(kv => !kv.Key.StartsWith('_'))
            .Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value?.DeepClone())));
        var record = new AiRunModel
        {
            Id = Guid.NewGuid(), Task = taskKey, SubjectType = task.Subject, SubjectId = subjectId[..Math.Min(40, subjectId.Length)],
            SellerId = sellerId, Inputs = inputs.ToJsonString(), Mode = current, Status = "draft",
            CreatedBy = actor?.Id, CreatedAt = DateTimeFunctions.UtcNow(),
        };
        JsonObject parsed;
        try
        {
            if (current == "live")
            {
                // Fail-closed: no provider call leaves this environment. Reference calls llm_router.complete here.
                _ = BrandBlock(await site.GetSiteAsync(), cfg, tcfg);
                _ = task.Build(inputs, modelInputs);
                throw new AppException("AI provider calls are restricted to a local mock in this environment", "ai_provider_restricted", 502);
            }
            parsed = task.Parse(task.MakeSandbox(inputs, modelInputs));
            record.Model = "sandbox";
        }
        catch (AppException exc)
        {
            // Keep a record of failures (for the AI studio log) even though the request fails.
            record.Status = "failed";
            record.Error = exc.Message[..Math.Min(300, exc.Message.Length)];
            await using var fuow = await db.BeginAsync();
            await ai.InsertRunAsync(record, fuow);
            await fuow.CommitAsync();
            throw;
        }
        if (taskKey == "listing_check")
        {
            // Rule-based findings are always included, whatever the model says.
            var rules = AiTasks.RuleCheck(modelInputs);
            var issues = (parsed["issues"] as JsonArray ?? new JsonArray()).Select(x => x?.GetValue<string>() ?? "").ToList();
            issues.AddRange((rules["issues"] as JsonArray ?? new JsonArray()).Select(x => x?.GetValue<string>() ?? ""));
            parsed["issues"] = new JsonArray(issues.Distinct().Select(i => (JsonNode)JsonValue.Create(i)!).ToArray());
            if (rules["risk"]!.GetValue<string>() == "high" ||
                (rules["risk"]!.GetValue<string>() == "medium" && parsed["risk"]!.GetValue<string>() == "low"))
                parsed["risk"] = rules["risk"]!.GetValue<string>();
        }
        record.Output = parsed.ToJsonString();
        await using var uow = await db.BeginAsync();
        await ai.InsertRunAsync(record, uow);
        if (actor is not null)
            await audit.InsertAsync(new AuditLogModel
            {
                Id = Guid.NewGuid(), ActorUserId = actor.Id, Action = $"ai.{taskKey}", EntityType = "ai_run",
                EntityId = record.Id.ToString(), Detail = $"{current} {record.Model}", CreatedAt = DateTimeFunctions.UtcNow(),
            }, uow.Transaction);
        await uow.CommitAsync();
        return (record, parsed);
    }

    public JsonObject RunOut(AiRunModel r, JsonObject? cfg = null, string? byName = null, bool includeInputs = false)
    {
        var o = new JsonObject
        {
            ["id"] = r.Id.ToString(), ["task"] = r.Task,
            ["task_label"] = AiTasks.Tasks.TryGetValue(r.Task, out var t) ? t.Label : r.Task,
            ["subject_type"] = r.SubjectType, ["subject_id"] = r.SubjectId, ["status"] = r.Status, ["mode"] = r.Mode,
            ["model"] = r.Model, ["output"] = JsonNode.Parse(r.Output)?.DeepClone(), ["final_text"] = r.FinalText,
            ["error"] = r.Error, ["input_tokens"] = r.InputTokens, ["output_tokens"] = r.OutputTokens,
            ["cache_creation_tokens"] = r.CacheCreationTokens, ["cache_read_tokens"] = r.CacheReadTokens,
            ["latency_ms"] = r.LatencyMs,
            ["cost_usd"] = cfg is null ? null : CostUsd(cfg, r.InputTokens + r.CacheCreationTokens, r.OutputTokens),
            ["created_at"] = r.CreatedAt.ToString("o"), ["reviewed_at"] = r.ReviewedAt?.ToString("o"),
        };
        if (byName is not null) o["by"] = byName;
        if (includeInputs) o["inputs"] = JsonNode.Parse(r.Inputs)?.DeepClone();
        return o;
    }

    public async Task<AiRunModel?> FinishAsync(string runId, string status, UserModel actor, string finalText = "", Guid? sellerId = null)
    {
        var id = ParseUuid(runId);
        var r = id is null ? null : await ai.RunByIdAsync(id.Value);
        if (r is null || (sellerId is not null && r.SellerId != sellerId) || r.Status != "draft") return null;
        var trimmed = finalText[..Math.Min(10000, finalText.Length)];
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        await ai.FinishRunAsync(r.Id, status, trimmed, actor.Id, now, uow);
        await uow.CommitAsync();
        r.Status = status;
        r.FinalText = trimmed;
        r.ReviewedBy = actor.Id;
        r.ReviewedAt = now;
        return r;
    }

    // ---------------------------------------------------------------- studio + runs

    public async Task<JsonObject> StudioAsync()
    {
        var cfg = await GetSettingsAsync();
        var used = await UsageThisMonthAsync();
        var monthStart = MonthStart();
        var byTask = (await ai.RunsByTaskThisMonthAsync(monthStart, false)).ToDictionary(x => x.Task, x => x.C);
        var applied = (await ai.RunsByTaskThisMonthAsync(monthStart, true)).ToDictionary(x => x.Task, x => x.C);
        var budget = Long(cfg["monthly_token_budget"], "monthly_token_budget");
        return new JsonObject
        {
            ["settings"] = cfg,
            ["status"] = new JsonObject
            {
                ["mode"] = await ModeAsync(), ["key_configured"] = await ConfiguredAsync(), ["environment"] = app.Environment,
            },
            ["models"] = Models.DeepClone(),
            ["usage"] = new JsonObject
            {
                ["runs"] = used["runs"]!.GetValue<long>(), ["input_tokens"] = used["input_tokens"]!.GetValue<long>(),
                ["output_tokens"] = used["output_tokens"]!.GetValue<long>(), ["cache_read_tokens"] = used["cache_read_tokens"]!.GetValue<long>(),
                ["cost_usd"] = CostUsd(cfg, used["input_tokens"]!.GetValue<long>(), used["output_tokens"]!.GetValue<long>()),
                ["budget_left"] = budget > 0
                    ? Math.Max(0, budget - used["input_tokens"]!.GetValue<long>() - used["output_tokens"]!.GetValue<long>()) : null,
            },
            ["tasks"] = new JsonArray(AiTasks.Tasks.Values.Select(t =>
            {
                var (enabled, instructions) = TaskSettings(cfg, t.Key);
                return (JsonNode)new JsonObject
                {
                    ["key"] = t.Key, ["label"] = t.Label, ["description"] = t.Description, ["audience"] = t.Audience,
                    ["output"] = t.Output, ["rules"] = t.Rules, ["enabled"] = enabled, ["instructions"] = instructions,
                    ["runs_this_month"] = byTask.GetValueOrDefault(t.Key), ["used_this_month"] = applied.GetValueOrDefault(t.Key),
                };
            }).ToArray()),
        };
    }

    public async Task<JsonObject> RunsPageAsync(string? task, string? status, int page)
    {
        var cfg = await GetSettingsAsync();
        var (items, total) = await ai.RunsPageAsync(task, status, page);
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(r => (JsonNode)new JsonObject
            {
                ["id"] = r.Id.ToString(), ["task"] = r.Task,
                ["task_label"] = AiTasks.Tasks.TryGetValue(r.Task, out var t) ? t.Label : r.Task,
                ["subject_type"] = r.SubjectType, ["subject_id"] = r.SubjectId, ["status"] = r.Status, ["mode"] = r.Mode,
                ["model"] = r.Model, ["output"] = JsonNode.Parse(r.Output)?.DeepClone(), ["final_text"] = r.FinalText,
                ["error"] = r.Error, ["input_tokens"] = r.InputTokens, ["output_tokens"] = r.OutputTokens,
                ["cache_creation_tokens"] = r.CacheCreationTokens, ["cache_read_tokens"] = r.CacheReadTokens,
                ["latency_ms"] = r.LatencyMs,
                ["cost_usd"] = CostUsd(cfg, r.InputTokens + r.CacheCreationTokens, r.OutputTokens),
                ["created_at"] = r.CreatedAt.ToString("o"), ["reviewed_at"] = r.ReviewedAt?.ToString("o"),
                ["by"] = r.ByName ?? "System",
            }).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 30,
        };
    }

    // ---------------------------------------------------------------- deterministic risk briefs

    private static readonly (string Level, int Ceiling)[] Buckets = [("GREEN", 30), ("AMBER", 60), ("RED", 101)];
    private static readonly IReadOnlyDictionary<string, string> Headlines = new Dictionary<string, string>
    {
        ["GREEN"] = "Low risk: looks routine",
        ["AMBER"] = "Worth a look: a few flags",
        ["RED"] = "High risk: check before acting",
    };

    private static JsonObject BriefResult(List<(int Weight, string Text)> factors, List<string> notes, bool insufficient)
    {
        var score = Math.Min(100, factors.Sum(f => f.Weight));
        var level = Buckets.First(b => score < b.Ceiling).Level;
        return new JsonObject
        {
            ["score"] = score, ["level"] = level, ["headline"] = Headlines[level],
            ["factors"] = new JsonArray(factors.Select(f => (JsonNode)new JsonObject { ["weight"] = f.Weight, ["text"] = f.Text }).ToArray()),
            ["notes"] = new JsonArray(notes.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray()),
            ["insufficient_history"] = insufficient,
        };
    }

    public async Task<JsonObject> SellerRiskAsync(Guid sellerId)
    {
        var seller = await catalog.GetSellerAsync(sellerId)
            ?? throw new NotFoundException("Seller");
        var since = DateTimeFunctions.UtcNow().AddDays(-90);
        var stats = await ai.SellerRiskStatsAsync(seller.Id, since, seller.DispatchDays);
        var delivered = await ai.SellerDeliveredSinceAsync(seller.Id, since);
        var returns = await ai.SellerReturnsSinceAsync(seller.Id, since);
        var rejected = await ai.RejectedListingsAsync(seller.Id);
        var factors = new List<(int, string)>();
        var notes = new List<string> { $"{stats.Total} packages in the last 90 days, {delivered} delivered." };
        if (stats.Total > 0)
        {
            var cancelRate = (double)stats.CancelledBySeller / stats.Total;
            if (cancelRate > 0.05) factors.Add((Math.Min(35, (int)(cancelRate * 200)), $"Seller cancelled {cancelRate:P0} of packages (target under 5%)"));
            var lateRate = (double)stats.Late / stats.Total;
            if (lateRate > 0.1) factors.Add((Math.Min(25, (int)(lateRate * 100)), $"{lateRate:P0} shipped later than promised"));
            var rtoRate = (double)stats.Rto / stats.Total;
            if (rtoRate > 0.1) factors.Add((Math.Min(25, (int)(rtoRate * 100)), $"{rtoRate:P0} of packages came back undelivered (RTO), by the seller's own courier"));
        }
        if (stats.Rto > 0) notes.Add($"{stats.Rto} package(s) marked as returned to the seller (RTO).");
        if (delivered > 0)
        {
            var returnRate = (double)returns / delivered;
            if (returnRate > 0.1) factors.Add((Math.Min(25, (int)(returnRate * 120)), $"Return rate {returnRate:P0} (target under 10%)"));
        }
        if (seller.RatingCount >= 5 && (double)seller.RatingAvg < 3.5)
            factors.Add((20, $"Store rating {(double)seller.RatingAvg:0.0} from {seller.RatingCount} reviews"));
        if (rejected >= 3) factors.Add((10, $"{rejected} listings rejected in moderation"));
        if (seller.ApprovedAt is { } approved && DateTimeFunctions.UtcNow() - approved < TimeSpan.FromDays(30))
            factors.Add((10, "Approved less than 30 days ago"));
        return BriefResult(factors, notes, stats.Total < 5);
    }

    public async Task<JsonObject> OrderRiskAsync(Guid orderId)
    {
        var order = await orders.GetOrderAsync(orderId) ?? throw new NotFoundException("Order");
        var user = await ai.UserBriefAsync(order.UserId);
        var factors = new List<(int, string)>();
        var placed = await ai.PlacedOrdersByUserAsync(order.UserId);
        var cancelled = await ai.CancelledByCustomerAsync(order.UserId);
        var returns = await ai.ReturnsByUserAsync(order.UserId);
        var pincode = JsonNode.Parse(order.ShipTo)?["pincode"]?.GetValue<string>() ?? "";
        var rtoPin = pincode.Length > 0 ? await ai.RtoByPincodeAsync(pincode) : 0;
        var tickets = await ai.TicketsByUserAsync(order.UserId);
        var notes = new List<string> { $"Customer has {placed} placed orders, {returns} returns and {tickets} support tickets." };
        if (order.PaymentMethod == "cod")
        {
            if (order.GrandTotal >= 500_000) factors.Add((25, "Cash on delivery above ₹5,000"));
            else if (order.GrandTotal >= 200_000) factors.Add((10, "Cash on delivery above ₹2,000"));
        }
        if (user is not null && DateTimeFunctions.UtcNow() - user.CreatedAt < TimeSpan.FromDays(2))
            factors.Add((15, "Account created in the last 2 days"));
        if (placed <= 1) factors.Add((10, "First order"));
        if (cancelled >= 3) factors.Add((20, $"Customer cancelled {cancelled} packages before"));
        if (returns >= 3 && placed > 0 && (double)returns / placed > 0.5)
            factors.Add((20, $"Returned {returns} times across {placed} orders"));
        if (rtoPin >= 3) factors.Add((15, $"{rtoPin} shipments to PIN {pincode} came back undelivered"));
        if (order.CouponCode.Length > 0 && placed <= 1 && order.DiscountTotal >= 20_000)
            factors.Add((5, $"Large first-order coupon ({order.CouponCode})"));
        return BriefResult(factors, notes, placed < 2);
    }

    // ---------------------------------------------------------------- review summaries job

    /// <summary>
    /// Reference: jobs.review_summary_job. Summaries are published on product pages, so they are written only by
    /// the real model, never the sandbox — a no-op in this environment (mode is always "sandbox").
    /// </summary>
    public async Task<int> ReviewSummariesAsync()
    {
        if (await ModeAsync() != "live") return 0;
        var (enabled, _) = TaskSettings(await GetSettingsAsync(), "review_summary");
        if (!enabled) return 0;
        var done = 0;
        foreach (var (id, _, ratingCount) in await ai.ProductsNeedingSummaryAsync())
        {
            var rows = (await ai.PublishedReviewsAsync(id)).Where(r => r.Body.Length > 0).ToList();
            if (rows.Count < 3) continue;
            var (_, output) = await RunAsync("review_summary", null, new JsonObject(), id.ToString());
            await using var uow = await db.BeginAsync();
            await ai.SetReviewSummaryAsync(id, output["text"]!.GetValue<string>(), ratingCount, uow);
            await uow.CommitAsync();
            done++;
        }
        return done;
    }
}
