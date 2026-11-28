using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <inheritdoc cref="IAgentsBAL"/>
public class AgentsBAL(IMySqlDapperHelper db, IAccessBAL access, IGrowthBAL growth, IAdminOpsBAL adminOps, ICatalogNotifyBAL notify, IAuditBAL audit) : IAgentsBAL
{
    private sealed record Draft(string Kind, string Key, string Summary, string[][] Details, Dictionary<string, string> Args, string Permission);
    private sealed record AgentDef(string Key, string Label, string Job, string NotWired, Func<JsonObject, Task<List<Draft>>> Scan);
    private sealed record SubRow(Guid SellerId, string Number, string Status, string Tracking, DateTime? ConfirmedAt, DateTime? ShippedAt);
    private sealed class Stale(string message) : Exception(message);

    private List<AgentDef> Agents() =>
    [
        new("delivery", "Delivery and shipping agent",
            "Finds packages that are not shipped on time or shipped with no tracking, and proposes a seller reminder or a cancel and refund.",
            "Does not talk to couriers, re-book a pickup or read live tracking events. Late-in-transit packages are handled by the order update agent (not built yet).",
            DeliveryScanAsync),
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
        throw new Stale("This kind of proposal is no longer supported.");
    }
}
