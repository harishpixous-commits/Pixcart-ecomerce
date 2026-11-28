using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <inheritdoc cref="IAgentsBAL"/>
public class AgentsBAL(IMySqlDapperHelper db, IAccessBAL access, IGrowthBAL growth, IAdminOpsBAL adminOps, ICatalogNotifyBAL notify, IAuditBAL audit, IProductModerationBAL moderation, ISupportDeskBAL desk) : IAgentsBAL
{
    private sealed record Draft(string Kind, string Key, string Summary, string[][] Details, Dictionary<string, string> Args, string Permission);
    private sealed record AgentDef(string Key, string Label, string Job, string NotWired, Func<JsonObject, Task<List<Draft>>> Scan);
    private sealed record SubRow(Guid SellerId, string Number, string Status, string Tracking, DateTime? ConfirmedAt, DateTime? ShippedAt);
    private sealed record VariantRow(Guid SellerId, int Stock, bool Active);
    private sealed record DelayRow(string Number, string Status, Guid UserId);
    private sealed class Stale(string message) : Exception(message);

    private List<AgentDef> Agents() =>
    [
        new("delivery", "Delivery and shipping agent",
            "Finds packages that are not shipped on time or shipped with no tracking, and proposes a seller reminder or a cancel and refund.",
            "Does not talk to couriers, re-book a pickup or read live tracking events. Late-in-transit packages are handled by the order update agent (not built yet).",
            DeliveryScanAsync),
        new("orderupdate", "Order update agent",
            "Finds packages on their way that are past the promised delivery date and proposes a plain delay message to the customer (in-app and email).",
            "Does not read live courier tracking, promise a new date, or message about other order stages. Normal shipped and delivered messages already go out without an agent.",
            OrderUpdateScanAsync),
        new("reorder", "Sourcing and reorder agent",
            "Compares each live item's stock with how fast it sold recently. When it would run out within the cover period, proposes asking the seller to restock, with a suggested quantity.",
            "Does not buy stock, raise purchase orders or contact outside suppliers: on this marketplace sellers own their stock. Does not predict seasons or sales spikes, only the recent average.",
            ReorderScanAsync),
        new("marketing", "Marketing agent",
            "Finds categories with plenty of live stock but few recent sales and proposes a limited-time category coupon. Staff approve before any coupon exists.",
            "Only proposes category coupons. Does not send emails or ads, does not pick customers, and does not measure whether the coupon worked.",
            MarketingScanAsync),
        new("listing", "Listing review agent",
            "Runs the listing rules on every product waiting for review. Proposes approving the clean ones and sending the rest back to the seller with the exact reasons.",
            "Checks text and price rules only. Does not look at photos, check the brand is genuine or compare against other sellers. Does not rewrite listings.",
            ListingScanAsync),
        new("support", "Support agent",
            "Finds open tickets that nobody has answered after a few hours and drafts a first acknowledging reply for staff to approve.",
            "Only the first acknowledgement. It does not decide refunds or replacements, read attachments or answer follow-up questions. Staff still resolve the ticket.",
            SupportScanAsync),
    ];

    private async Task<JsonObject> CfgAsync() => (JsonObject)(await growth.GetAsync())["agents"]!;

    // ---------- delivery agent ----------
    private async Task<List<Draft>> DeliveryScanAsync(JsonObject cfg)
    {
        var now = DateTime.UtcNow; var oldest = now.AddDays(-cfg.Int("delivery_max_age_days"));
        var nudgeBefore = now.AddHours(-cfg.Int("delivery_nudge_hours")); var trackBefore = now.AddHours(-cfg.Int("delivery_tracking_hours"));
        var cancelHours = cfg.Int("delivery_cancel_hours");
        var outp = new List<Draft>();
        var waiting = await db.QueryAsync<(Guid Id, string Number, string Status, DateTime At, string Seller)>(
            "SELECT s.id AS Id, s.number AS Number, s.status AS Status, s.confirmed_at AS At, k.display_name AS Seller FROM sub_orders s JOIN sellers k ON k.id = s.seller_id " +
            "WHERE s.status IN ('confirmed','packed') AND s.confirmed_at <= @nudgeBefore AND s.confirmed_at >= @oldest ORDER BY s.confirmed_at LIMIT 200", new { nudgeBefore, oldest });
        foreach (var r in waiting)
        {
            var hours = (int)(now - DateTime.SpecifyKind(r.At, DateTimeKind.Utc)).TotalHours;
            string[][] d = [["Package", r.Number], ["Seller", r.Seller], ["Waiting to ship", $"{hours} hours"], ["Status", r.Status]];
            if (hours >= cancelHours)
                outp.Add(new("cancel_package", r.Id.ToString(), $"Cancel and refund {r.Number}: {r.Seller} has not shipped for {hours / 24} days", d,
                    new() { ["sub_id"] = r.Id.ToString(), ["reason"] = "The seller did not ship in time" }, "orders"));
            else
                outp.Add(new("nudge_seller", r.Id.ToString(), $"Remind {r.Seller} to ship {r.Number} (waiting {hours} hours)", d, new() { ["sub_id"] = r.Id.ToString() }, "orders"));
        }
        var untracked = await db.QueryAsync<(Guid Id, string Number, DateTime At, string Seller)>(
            "SELECT s.id AS Id, s.number AS Number, s.shipped_at AS At, k.display_name AS Seller FROM sub_orders s JOIN sellers k ON k.id = s.seller_id " +
            "WHERE s.status = 'shipped' AND s.tracking_number = '' AND s.provider_shipment_id = '' AND s.shipped_at <= @trackBefore AND s.shipped_at >= @oldest ORDER BY s.shipped_at LIMIT 200", new { trackBefore, oldest });
        foreach (var r in untracked)
        {
            var hours = (int)(now - DateTime.SpecifyKind(r.At, DateTimeKind.Utc)).TotalHours;
            outp.Add(new("nudge_tracking", r.Id.ToString(), $"Ask {r.Seller} to add tracking to {r.Number} (shipped {hours} hours ago, no tracking)",
                [["Package", r.Number], ["Seller", r.Seller], ["Marked shipped", $"{hours} hours ago"]], new() { ["sub_id"] = r.Id.ToString() }, "orders"));
        }
        return outp;
    }

    // ---------- order update agent ----------
    private async Task<List<Draft>> OrderUpdateScanAsync(JsonObject cfg)
    {
        var now = DateTime.UtcNow; var lateBefore = now.AddHours(-cfg.Int("orderupdate_late_hours")); var oldest = now.AddDays(-cfg.Int("orderupdate_max_age_days"));
        var rows = await db.QueryAsync<(Guid Id, string Number, string Courier, DateTime Due)>(
            "SELECT id AS Id, number AS Number, courier_name AS Courier, expected_delivery_at AS Due FROM sub_orders WHERE status = 'shipped' AND expected_delivery_at IS NOT NULL " +
            "AND expected_delivery_at <= @lateBefore AND expected_delivery_at >= @oldest ORDER BY expected_delivery_at LIMIT 200", new { lateBefore, oldest });
        var outp = new List<Draft>();
        foreach (var r in rows)
        {
            var due = DateTime.SpecifyKind(r.Due, DateTimeKind.Utc); var ist = due + TimeSpan.FromHours(5.5);
            var late = (int)(now - due).TotalHours; var expected = $"{ist.Day} {ist:MMM}";
            outp.Add(new("delay_notice", r.Id.ToString(), $"Tell the customer package {r.Number} is late (due {expected}, {late} hours past)",
                [["Package", r.Number], ["Courier", string.IsNullOrEmpty(r.Courier) ? "not recorded" : r.Courier], ["Was due", expected], ["Hours late", late.ToString()]],
                new() { ["sub_id"] = r.Id.ToString(), ["expected"] = expected }, "orders"));
        }
        return outp;
    }

    // ---------- sourcing and reorder agent ----------
    private async Task<List<Draft>> ReorderScanAsync(JsonObject cfg)
    {
        var window = cfg.Int("reorder_window_days"); var cover = cfg.Int("reorder_cover_days"); var since = DateTime.UtcNow.AddDays(-window);
        var rows = await db.QueryAsync<(Guid Id, int Stock, string Options, string Title, string Seller, long Sold)>(
            "SELECT v.id AS Id, v.stock AS Stock, CAST(v.options AS CHAR) AS Options, p.title AS Title, k.display_name AS Seller, x.qty AS Sold FROM variants v " +
            "JOIN (SELECT oi.variant_id AS vid, SUM(oi.qty) AS qty FROM order_items oi JOIN sub_orders s ON s.id = oi.sub_order_id WHERE s.created_at >= @since AND s.status NOT IN ('pending_payment','cancelled') GROUP BY oi.variant_id) x ON x.vid = v.id " +
            "JOIN products p ON p.id = v.product_id JOIN sellers k ON k.id = v.seller_id WHERE v.is_active = 1 AND p.status = 'approved' AND x.qty >= @minSold LIMIT 500", new { since, minSold = cfg.Int("reorder_min_sold") });
        var outp = new List<Draft>(); var month = DateTime.UtcNow.ToString("yyyy-MM");
        foreach (var r in rows)
        {
            var rate = (double)r.Sold / window; var left = r.Stock / rate;
            if (left > cover) continue;
            var suggest = Math.Max(1, (int)Math.Ceiling(rate * cover * 2) - r.Stock);
            var opts = JsonNode.Parse(r.Options) as JsonObject;
            var label = r.Title + (opts is { Count: > 0 } ? " (" + string.Join(", ", opts.Select(o => o.Value?.ToString())) + ")" : "");
            var daysLeft = (int)left;
            outp.Add(new("request_restock", $"{r.Id}:{month}", $"Ask {r.Seller} to restock {label}: {r.Stock} left, sells about {rate:0.0} a day, out in about {daysLeft} days",
                [["Item", label], ["Seller", r.Seller], ["In stock", r.Stock.ToString()], [$"Sold in {window} days", r.Sold.ToString()], ["Suggested to add", suggest.ToString()]],
                new() { ["variant_id"] = r.Id.ToString(), ["item"] = label[..Math.Min(100, label.Length)], ["stock"] = r.Stock.ToString(), ["sold"] = r.Sold.ToString(), ["days"] = window.ToString(), ["left"] = daysLeft.ToString(), ["suggest"] = suggest.ToString() }, "orders"));
        }
        return outp;
    }

    // ---------- marketing agent ----------
    private async Task<List<Draft>> MarketingScanAsync(JsonObject cfg)
    {
        var now = DateTime.UtcNow; var window = cfg.Int("marketing_window_days"); var since = now.AddDays(-window);
        var pct = cfg.Int("marketing_discount_percent"); var days = cfg.Int("marketing_valid_days");
        var rows = await db.QueryAsync<(Guid Id, string Name, long Items, long Sold)>(
            "SELECT c.id AS Id, c.name AS Name, x.items AS Items, COALESCE(y.qty, 0) AS Sold FROM categories c " +
            "JOIN (SELECT p.category_id AS cid, COUNT(DISTINCT p.id) AS items FROM products p JOIN variants v ON v.product_id = p.id WHERE p.status = 'approved' AND v.is_active = 1 AND v.stock > 0 GROUP BY p.category_id) x ON x.cid = c.id " +
            "LEFT JOIN (SELECT p.category_id AS cid, SUM(oi.qty) AS qty FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id JOIN sub_orders s ON s.id = oi.sub_order_id " +
            "WHERE s.created_at >= @since AND s.status NOT IN ('pending_payment','cancelled') GROUP BY p.category_id) y ON y.cid = c.id " +
            "WHERE x.items >= @minItems AND COALESCE(y.qty, 0) <= @maxSold LIMIT 200", new { since, minItems = cfg.Int("marketing_min_items"), maxSold = cfg.Int("marketing_max_sold") });
        var outp = new List<Draft>(); var month = now.ToString("yyyy-MM");
        foreach (var r in rows)
        {
            var code = $"SLOW{pct}{r.Id.ToString("N")[..6].ToUpperInvariant()}{now:MMdd}";
            outp.Add(new("create_coupon", $"{r.Id}:{month}", $"Run {pct}% off {r.Name} for {days} days: {r.Items} items in stock but only {r.Sold} sold in {window} days",
                [["Category", r.Name], ["Items in stock", r.Items.ToString()], [$"Sold in {window} days", r.Sold.ToString()], ["Coupon", $"{pct}% off, code {code}, {days} days"]],
                new() { ["category_id"] = r.Id.ToString(), ["category"] = r.Name, ["code"] = code, ["percent"] = pct.ToString(), ["days"] = days.ToString() }, "marketing"));
        }
        return outp;
    }

    // ---------- listing review agent ----------
    private async Task<List<Draft>> ListingScanAsync(JsonObject cfg)
    {
        var rows = await db.QueryAsync<(Guid Id, string Title, string Description, string Highlights, string Stamp)>(
            "SELECT id AS Id, title AS Title, description AS Description, CAST(highlights AS CHAR) AS Highlights, DATE_FORMAT(updated_at, '%Y%m%d%H%i%s') AS Stamp FROM products WHERE status = 'pending' ORDER BY updated_at LIMIT 100");
        var outp = new List<Draft>();
        foreach (var r in rows)
        {
            var vs = await db.QueryAsync<(long Mrp, long Price)>("SELECT mrp_paise AS Mrp, price_paise AS Price FROM variants WHERE product_id = @id", new { id = r.Id });
            var snap = new JsonObject
            {
                ["title"] = r.Title, ["description"] = r.Description, ["highlights"] = JsonNode.Parse(r.Highlights)?.DeepClone() ?? new JsonArray(),
                ["variants"] = new JsonArray(vs.Select(v => (JsonNode)new JsonObject { ["mrp"] = v.Mrp / 100.0, ["price"] = v.Price / 100.0 }).ToArray()),
            };
            var res = AiTasks.RuleCheck(snap);
            var issues = res["issues"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
            var key = $"{r.Id}:{r.Stamp}";
            if (res["risk"]!.GetValue<string>() == "low")
                outp.Add(new("approve_listing", key, $"Approve \"{r.Title}\": passes every listing check",
                    [["Listing", r.Title], ["Checks", "No restricted words, no contact details, discount looks normal, description is long enough"]],
                    new() { ["product_id"] = r.Id.ToString(), ["title"] = r.Title }, "catalog"));
            else
            {
                var reason = string.Join("; ", issues); if (reason.Length > 900) reason = reason[..900];
                outp.Add(new("reject_listing", key, $"Send back \"{r.Title}\": {issues[0]}",
                    new[] { new[] { "Listing", r.Title }, new[] { "Risk", res["risk"]!.GetValue<string>() } }.Concat(issues.Select(i => new[] { "Issue", i })).ToArray(),
                    new() { ["product_id"] = r.Id.ToString(), ["title"] = r.Title, ["reason"] = reason }, "catalog"));
            }
        }
        return outp;
    }

    // ---------- support agent ----------
    private async Task<List<Draft>> SupportScanAsync(JsonObject cfg)
    {
        var now = DateTime.UtcNow; var cutoff = now.AddHours(-cfg.Int("support_wait_hours")); var oldest = now.AddDays(-cfg.Int("support_max_age_days"));
        var tickets = await db.QueryAsync<(Guid Id, string Number, string Category, string Subject, string Priority, string Name)>(
            "SELECT t.id AS Id, t.number AS Number, t.category AS Category, t.subject AS Subject, t.priority AS Priority, u.name AS Name FROM support_tickets t JOIN users u ON u.id = t.user_id " +
            "WHERE t.status = 'open' AND t.acknowledged_at IS NULL AND t.created_at >= @oldest ORDER BY t.created_at LIMIT 100", new { oldest });
        var outp = new List<Draft>();
        foreach (var t in tickets)
        {
            var msgs = (await db.QueryAsync<(string Role, DateTime At)>("SELECT author_role AS Role, created_at AS At FROM ticket_messages WHERE ticket_id = @id AND is_internal = 0 ORDER BY created_at", new { id = t.Id })).ToList();
            if (msgs.Count == 0 || msgs[^1].Role != "customer" || msgs[^1].At > cutoff) continue;
            var first = (t.Name ?? "").Split(' ')[0]; var subject = t.Subject.Length > 80 ? t.Subject[..80] : t.Subject;
            var body = $"Hi {(first == "" ? "there" : first)}, thank you for writing to us about \"{subject}\". We have your message and a member of our team is looking into it. " +
                       "We will reply here as soon as we have checked. Please do not share OTPs, passwords or card details with anyone, including us.";
            var hours = (int)(now - DateTime.SpecifyKind(msgs[^1].At, DateTimeKind.Utc)).TotalHours;
            outp.Add(new("reply_ticket", $"{t.Id}:{msgs.Count}", $"Send a first reply on ticket {t.Number}: \"{subject}\" has waited {hours} hours",
                [["Ticket", t.Number], ["Category", t.Category], ["Priority", t.Priority], ["Draft reply", body]],
                new() { ["ticket_id"] = t.Id.ToString(), ["messages"] = msgs.Count.ToString(), ["body"] = body }, "support"));
        }
        return outp;
    }

    // ---------- core ----------
    private async Task<bool> ProposeAsync(string agent, Draft d)
    {
        var n = await db.ExecuteAsync(
            "INSERT IGNORE INTO agent_proposals (id, agent, kind, dedupe_key, summary, details, params, permission, status, result, created_at) VALUES (@id, @agent, @kind, @key, @summary, @details, @args, @perm, 'pending', '{}', UTC_TIMESTAMP(6))",
            new { id = Guid.NewGuid(), agent, kind = d.Kind, key = $"{d.Kind}:{d.Key}"[..Math.Min(120, d.Kind.Length + 1 + d.Key.Length)], summary = d.Summary[..Math.Min(500, d.Summary.Length)],
                  details = JsonSerializer.Serialize(d.Details), args = JsonSerializer.Serialize(d.Args), perm = d.Permission });
        return n > 0;
    }

    private async Task<int> RunAgentAsync(AgentDef a, JsonObject cfg)
    {
        if (!(cfg.Bool("enabled") && cfg.Bool(a.Key + "_enabled"))) return 0;
        var made = 0;
        foreach (var d in (await a.Scan(cfg)).Take(cfg.Int("max_per_run"))) if (await ProposeAsync(a.Key, d)) made++;
        return made;
    }

    private async Task ExpireOldAsync(JsonObject cfg)
    {
        var before = DateTime.UtcNow.AddHours(-cfg.Int("expire_hours"));
        await db.ExecuteAsync("UPDATE agent_proposals SET status = 'expired', decided_at = UTC_TIMESTAMP(6), result = '{\"note\":\"Nobody decided in time.\"}' WHERE status = 'pending' AND created_at < @before", new { before });
    }

    public async Task<int> RunAllAsync()
    {
        var cfg = await CfgAsync(); var total = 0;
        foreach (var a in Agents()) total += await RunAgentAsync(a, cfg);
        await ExpireOldAsync(cfg);
        return total;
    }

    // ---------- admin API ----------
    public async Task<JsonObject> OverviewAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "assistant_actions");
        var cfg = await CfgAsync();
        var pending = (await db.QueryAsync<(string Agent, long N)>("SELECT agent AS Agent, COUNT(*) AS N FROM agent_proposals WHERE status = 'pending' GROUP BY agent")).ToDictionary(x => x.Agent, x => x.N);
        var list = new JsonArray();
        foreach (var a in Agents())
            list.Add(new JsonObject { ["key"] = a.Key, ["label"] = a.Label, ["job"] = a.Job, ["not_wired"] = a.NotWired, ["enabled"] = cfg.Bool("enabled") && cfg.Bool(a.Key + "_enabled"), ["pending"] = pending.GetValueOrDefault(a.Key) });
        return new JsonObject { ["settings"] = cfg.DeepClone(), ["defaults"] = ((JsonObject)GrowthBAL.Defaults()["agents"]!).DeepClone(), ["agents"] = list };
    }

    public async Task<JsonObject> SaveSettingsAsync(UserModel admin, JsonObject body)
    {
        var r = await growth.UpdateAsync(admin, new JsonObject { ["agents"] = body.DeepClone() }, "assistant_actions");
        return new JsonObject { ["settings"] = ((JsonObject)r["settings"]!)["agents"]!.DeepClone() };
    }

    private sealed record Row(Guid Id, string Agent, string Kind, string Summary, string Details, string Params, string Permission, string Status, string Result, DateTime CreatedAt, DateTime? DecidedAt);
    private const string RowSql = "SELECT id AS Id, agent AS Agent, kind AS Kind, summary AS Summary, CAST(details AS CHAR) AS Details, CAST(params AS CHAR) AS Params, permission AS Permission, status AS Status, CAST(result AS CHAR) AS Result, created_at AS CreatedAt, decided_at AS DecidedAt FROM agent_proposals ";

    private static JsonObject View(Row r) => new()
    {
        ["id"] = r.Id.ToString(), ["agent"] = r.Agent, ["kind"] = r.Kind, ["summary"] = r.Summary, ["details"] = JsonNode.Parse(r.Details), ["status"] = r.Status, ["permission"] = r.Permission,
        ["result"] = JsonNode.Parse(r.Result), ["created_at"] = DateTime.SpecifyKind(r.CreatedAt, DateTimeKind.Utc).ToString("o"),
        ["decided_at"] = r.DecidedAt is null ? null : DateTime.SpecifyKind(r.DecidedAt.Value, DateTimeKind.Utc).ToString("o"),
    };

    public async Task<JsonObject> ProposalsAsync(UserModel admin, string status, string? agent)
    {
        await access.RequireAsync(admin, "assistant_actions");
        var rows = await db.QueryAsync<Row>(RowSql + "WHERE (@status = 'all' OR status = @status) AND (@agent IS NULL OR agent = @agent) ORDER BY created_at DESC LIMIT 200", new { status, agent });
        return new JsonObject { ["items"] = new JsonArray(rows.Select(r => (JsonNode)View(r)).ToArray()) };
    }

    public async Task<JsonObject> RunNowAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "assistant_actions");
        var cfg = await CfgAsync(); var made = new JsonObject();
        foreach (var a in Agents()) made[a.Key] = await RunAgentAsync(a, cfg);
        await ExpireOldAsync(cfg);
        await audit.AuditAsync(admin, "agents.run", "settings", "agents", made.ToJsonString());
        return new JsonObject { ["new"] = made };
    }

    public async Task<JsonObject> DecideAsync(UserModel admin, Guid id, string decision)
    {
        await access.RequireAsync(admin, "assistant_actions");
        var row = await db.QueryFirstOrDefaultAsync<Row>(RowSql + "WHERE id = @id", new { id }) ?? throw new NotFoundException("Proposal");
        if (row.Status != "pending") throw new ConflictException($"This proposal is already {row.Status}", "proposal_done");
        if (!(await access.PermissionsForAsync(admin)).Contains(row.Permission)) throw new ForbiddenException($"Your role cannot do this ({row.Permission}).");
        var claimed = await db.ExecuteAsync("UPDATE agent_proposals SET status = @to, decided_at = UTC_TIMESTAMP(6), decided_by = @by WHERE id = @id AND status = 'pending'",
            new { to = decision == "reject" ? "rejected" : "running", by = admin.Id, id });
        if (claimed == 0) throw new ConflictException("This proposal is already decided", "proposal_done");
        if (decision == "reject")
        {
            await audit.AuditAsync(admin, $"agent.{row.Agent}.reject", "agent_proposal", id.ToString(), row.Summary[..Math.Min(200, row.Summary.Length)]);
        }
        else
        {
            try { await ExecuteAsync(admin, row); }
            catch (Stale e)
            {
                await Finish(id, "expired", new JsonObject { ["note"] = e.Message });
                throw new ConflictException(e.Message, "proposal_stale");
            }
            catch (AppException e)
            {
                await Finish(id, "failed", new JsonObject { ["error"] = e.Message });
                throw;
            }
            catch (Exception e)
            {
                await Finish(id, "failed", new JsonObject { ["error"] = e.Message[..Math.Min(300, e.Message.Length)] });
                throw new AppException("The agent could not do this. Check the package by hand.", "proposal_failed", 500);
            }
            await Finish(id, "done", new JsonObject { ["outcome"] = new JsonObject { ["ok"] = true } });
            await audit.AuditAsync(admin, $"agent.{row.Agent}.{row.Kind}", "agent_proposal", id.ToString(), row.Summary[..Math.Min(200, row.Summary.Length)]);
        }
        return View((await db.QueryFirstOrDefaultAsync<Row>(RowSql + "WHERE id = @id", new { id }))!);
    }

    private Task Finish(Guid id, string status, JsonObject result) =>
        db.ExecuteAsync("UPDATE agent_proposals SET status = @status, result = @result WHERE id = @id", new { status, result = result.ToJsonString(), id });

    private async Task ExecuteAsync(UserModel admin, Row row)
    {
        var p = JsonNode.Parse(row.Params)!.AsObject();
        if (row.Kind is "nudge_seller" or "nudge_tracking" or "cancel_package")
        {
            var subId = Guid.Parse(p["sub_id"]!.GetValue<string>());
            var s = await db.QueryFirstOrDefaultAsync<SubRow>(
                "SELECT seller_id AS SellerId, number AS Number, status AS Status, tracking_number AS Tracking, confirmed_at AS ConfirmedAt, shipped_at AS ShippedAt FROM sub_orders WHERE id = @subId", new { subId })
                ?? throw new Stale("The package no longer exists.");
            var track = row.Kind == "nudge_tracking";
            if (track ? s.Status != "shipped" || s.Tracking != "" : s.Status is not ("confirmed" or "packed"))
                throw new Stale($"Package {s.Number} has moved on ({s.Status}), so nothing was sent.");
            if (row.Kind == "cancel_package")
            {
                await adminOps.CancelSubOrderAsync(admin, subId, p["reason"]?.GetValue<string>() is { Length: >= 5 } r ? r : "The seller did not ship in time");
                return;
            }
            var since = DateTime.SpecifyKind((track ? s.ShippedAt : s.ConfirmedAt) ?? DateTime.UtcNow, DateTimeKind.Utc);
            await notify.NotifySellerAsync(s.SellerId, track ? "seller_tracking_reminder" : "seller_ship_reminder",
                new Dictionary<string, string> { ["order_number"] = s.Number, ["hours"] = ((int)(DateTime.UtcNow - since).TotalHours).ToString() }, $"/seller/orders/{subId}");
            return;
        }
        if (row.Kind == "request_restock")
        {
            var vid = Guid.Parse(p["variant_id"]!.GetValue<string>());
            var v = await db.QueryFirstOrDefaultAsync<VariantRow>("SELECT seller_id AS SellerId, stock AS Stock, is_active AS Active FROM variants WHERE id = @vid", new { vid });
            if (v is null || !v.Active) throw new Stale("This item is no longer for sale, so nothing was sent.");
            if (v.Stock > int.Parse(p["stock"]!.GetValue<string>())) throw new Stale($"Stock was already topped up ({v.Stock} now), so nothing was sent.");
            await notify.NotifySellerAsync(v.SellerId, "seller_restock", new Dictionary<string, string>
            {
                ["item"] = p["item"]!.GetValue<string>(), ["stock"] = v.Stock.ToString(), ["sold"] = p["sold"]!.GetValue<string>(), ["days"] = p["days"]!.GetValue<string>(),
                ["left"] = p["left"]!.GetValue<string>(), ["suggest"] = p["suggest"]!.GetValue<string>(),
            }, "/seller/inventory?low_stock=1");
            return;
        }
        if (row.Kind == "create_coupon")
        {
            var cat = Guid.Parse(p["category_id"]!.GetValue<string>()); var code = p["code"]!.GetValue<string>().ToUpperInvariant();
            var pct = int.Parse(p["percent"]!.GetValue<string>()); var days = int.Parse(p["days"]!.GetValue<string>());
            if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM categories WHERE id = @cat", new { cat }) == 0) throw new Stale("The category no longer exists, so no coupon was made.");
            if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM coupons WHERE UPPER(code) = @code", new { code }) > 0) throw new Stale("A coupon with this code already exists, so nothing was made.");
            var now = DateTime.UtcNow;
            await db.ExecuteAsync(
                "INSERT INTO coupons (id, code, description, kind, value, min_order_paise, starts_at, ends_at, per_user_limit, used_count, funded_by, category_id, first_order_only, is_active, show_on_checkout) " +
                "VALUES (@id, @code, @d, 'percent', @v, 0, @s, @e, 1, 0, 'platform', @cat, 0, 1, 1)",
                new { id = Guid.NewGuid(), code, d = $"{pct}% off {p["category"]!.GetValue<string>()}", v = pct * 100, s = now, e = now.AddDays(days), cat });
            await db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'coupon.create', 'coupon', @code, 'made by the marketing agent', UTC_TIMESTAMP(6), @id)",
                new { by = admin.Id, code, id = Guid.NewGuid() });
            return;
        }
        if (row.Kind is "approve_listing" or "reject_listing")
        {
            var pid = Guid.Parse(p["product_id"]!.GetValue<string>());
            if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM products WHERE id = @pid AND status = 'pending'", new { pid }) == 0)
                throw new Stale("This listing is no longer waiting for review, so nothing was changed.");
            if (row.Kind == "approve_listing") await moderation.ApproveAsync(admin, pid); else await moderation.RejectAsync(admin, pid, p["reason"]!.GetValue<string>());
            return;
        }
        if (row.Kind == "reply_ticket")
        {
            var tid = Guid.Parse(p["ticket_id"]!.GetValue<string>());
            if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM support_tickets WHERE id = @tid AND status = 'open' AND acknowledged_at IS NULL", new { tid }) == 0)
                throw new Stale("The ticket was already answered or closed, so nothing was sent.");
            if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = @tid AND is_internal = 0", new { tid }) != long.Parse(p["messages"]!.GetValue<string>()))
                throw new Stale("The ticket has new messages since this draft, so nothing was sent.");
            await desk.ReplyAsync(admin, tid, p["body"]!.GetValue<string>(), false, null, null, null);
            return;
        }
        if (row.Kind == "delay_notice")
        {
            var subId = Guid.Parse(p["sub_id"]!.GetValue<string>());
            var s = await db.QueryFirstOrDefaultAsync<DelayRow>("SELECT s.number AS Number, s.status AS Status, o.user_id AS UserId FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE s.id = @subId", new { subId })
                ?? throw new Stale("The package no longer exists.");
            if (s.Status != "shipped") throw new Stale("The package is no longer on its way, so nothing was sent.");
            await notify.NotifyUserAsync(s.UserId, "order_delay", new Dictionary<string, string> { ["order_number"] = s.Number, ["expected"] = p["expected"]!.GetValue<string>() }, "/account/orders");
            return;
        }
        throw new Stale("This kind of proposal is no longer supported.");
    }
}
