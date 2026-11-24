using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>A proposal problem the model can fix and retry (reference: assistant/actions.py ActionError).</summary>
public sealed class AssistantActionException(string message) : Exception(message);

/// <summary>
/// Changes the assistant can propose (reference: assistant/actions.py prepare/execute and routers/assistant.py
/// decide_action). Nothing runs until the staff member presses Confirm; pending actions expire after 30 minutes
/// and can only be confirmed by the person they were proposed to. Execution runs the same ported admin
/// operations the admin panel endpoints use, so validation, side effects and the audit log match doing it by
/// hand. Only kinds whose backing admin operation is ported are executable; the rest are rejected at prepare
/// time with a clear message (the reference ports them all).
/// </summary>
public class AssistantActionsBAL(
    AssistantDAL asstDal,
    OrdersDAL ordersDal,
    AdminOpsDAL adminOpsDal,
    ReturnsDAL returnsDal,
    IAdminOpsBAL adminOps,
    IReturnsBAL returns,
    IAccessBAL access,
    IPlatformSettingsBAL platformSettings,
    SellerModerationDAL sellersDal,
    ISellerModerationBAL sellers,
    IMySqlDapperHelper db)
{
    private static readonly TimeSpan ExpiresAfter = TimeSpan.FromMinutes(30);

    /// <summary>Kinds whose execute path is ported end-to-end. Reference: ACTIONS.</summary>
    private static readonly Dictionary<string, (string Label, string Permission, string[] Required)> Kinds = new()
    {
        ["cancel_package"] = ("Cancel a package and refund it", "orders", ["package", "reason"]),
        ["mark_delivered"] = ("Mark a package delivered", "orders", ["package"]),
        ["retry_refund"] = ("Retry a failed refund", "refunds", ["refund_id"]),
        ["return_decision"] = ("Decide on a return", "refunds", ["return_number", "decision"]),
        ["block_customer"] = ("Block a customer", "customers", ["customer", "reason"]),
        ["unblock_customer"] = ("Unblock a customer", "customers", ["customer"]),
        ["update_setting"] = ("Change a marketplace setting", "settings", ["key", "value"]),
        ["run_payouts"] = ("Create payouts for sellers with money due", "payouts", []),
        ["approve_seller"] = ("Approve a seller", "sellers", ["seller"]),
        ["reject_seller"] = ("Ask a seller to fix their application", "sellers", ["seller", "reason"]),
        ["suspend_seller"] = ("Suspend a seller", "sellers", ["seller", "reason"]),
        ["set_seller_commission"] = ("Change a seller's commission", "sellers", ["seller"]),
    };

    private static string Str(JsonObject p, string key) =>
        p[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

    private static string Rupees(long paise) => Money.Rupees(paise);

    /// <summary>Validates a proposal and stores it pending (reference: actions.prepare). Throws
    /// <see cref="AssistantActionException"/> with a message for the model.</summary>
    public async Task<AssistantActionModel> PrepareAsync(Guid userId, IReadOnlySet<string> permissions,
        Guid conversationId, string kind, JsonObject prms)
    {
        if (AssistantActionDefs.All.All(a => a.Kind != kind))
            throw new AssistantActionException($"Unknown action. Available: {string.Join(", ", AssistantActionDefs.All.Select(a => a.Kind))}");
        if (!Kinds.TryGetValue(kind, out var spec))
            throw new AssistantActionException(
                $"Preparing {kind} is not available in this build yet; its admin operation has not been ported.");
        if (!permissions.Contains(spec.Permission))
            throw new AssistantActionException($"Your role cannot do this ({spec.Permission}). Ask an owner to change your role.");
        var missing = spec.Required.Where(r => Str(prms, r).Length == 0).ToList();
        if (missing.Count > 0)
            throw new AssistantActionException($"Missing: {string.Join(", ", missing)}");
        var clean = new JsonObject();
        var details = new JsonArray();
        string summary;
        void Detail(string label, string value) => details.Add(new JsonArray(label, value));
        switch (kind)
        {
            case "cancel_package":
            case "mark_delivered":
            {
                var sub = await ordersDal.SubByNumberAsync(Str(prms, "package").Trim())
                    ?? throw new AssistantActionException($"No package numbered {Str(prms, "package")}.");
                clean["sub_id"] = sub.Id.ToString();
                Detail("Package", sub.Number); Detail("Status now", sub.Status); Detail("Value", Rupees(sub.Total));
                summary = $"{(kind == "cancel_package" ? "Cancel" : "Mark delivered")} package {sub.Number}";
                if (kind == "cancel_package")
                {
                    clean["reason"] = Str(prms, "reason").Trim()[..Math.Min(1000, Str(prms, "reason").Trim().Length)];
                    Detail("Reason", clean["reason"]!.GetValue<string>());
                }
                break;
            }
            case "retry_refund":
            {
                if (!Guid.TryParse(Str(prms, "refund_id"), out var rid)
                    || await adminOpsDal.RefundAsync(rid) is not { } r)
                    throw new AssistantActionException("No refund with that id.");
                clean["refund_id"] = r.Id.ToString();
                Detail("Amount", Rupees(r.AmountPaise)); Detail("Status now", r.Status); Detail("Attempts", r.Attempts.ToString());
                summary = $"Retry refund of {Rupees(r.AmountPaise)}";
                break;
            }
            case "return_decision":
            {
                var ret = await returnsDal.ReturnByNumberAsync(Str(prms, "return_number").Trim())
                    ?? throw new AssistantActionException("No return with that number.");
                var decision = Str(prms, "decision").Trim();
                if (decision is not ("approve" or "reject" or "received" or "mark_refunded"))
                    throw new AssistantActionException("decision is approve, reject, received or mark_refunded");
                clean["return_id"] = ret.Id.ToString(); clean["decision"] = decision;
                clean["note"] = Str(prms, "note")[..Math.Min(2000, Str(prms, "note").Length)];
                clean["reference"] = Str(prms, "reference")[..Math.Min(60, Str(prms, "reference").Length)];
                Detail("Return", ret.Number); Detail("Status now", ret.Status); Detail("Refund", Rupees(ret.RefundAmount));
                Detail("Decision", decision.Replace("_", " "));
                summary = $"{char.ToUpper(decision.Replace("_", " ")[0])}{decision.Replace("_", " ")[1..]} return {ret.Number}";
                break;
            }
            case "block_customer":
            case "unblock_customer":
            {
                var u = await CustomerAsync(Str(prms, "customer"));
                clean["user_id"] = u.Id.ToString();
                Detail("Customer", u.Name.Length > 0 ? u.Name : "—"); Detail("Mobile", u.Phone is { Length: > 0 } ph ? ph : "—");
                Detail("Active now", u.IsActive ? "yes" : "no");
                summary = $"{(kind == "block_customer" ? "Block" : "Unblock")} {(u.Name.Length > 0 ? u.Name : u.Phone is { Length: > 0 } p2 ? p2 : "customer")}";
                if (kind == "block_customer")
                {
                    clean["reason"] = Str(prms, "reason").Trim()[..Math.Min(1000, Str(prms, "reason").Trim().Length)];
                    Detail("Reason", clean["reason"]!.GetValue<string>());
                }
                break;
            }
            case "update_setting":
            {
                var key = Str(prms, "key").Trim();
                if (!PlatformSettingsBAL.Limits.TryGetValue(key, out var lim))
                    throw new AssistantActionException($"Unknown setting. Settings: {string.Join(", ", PlatformSettingsBAL.Limits.Keys)}");
                var raw = Str(prms, "value");
                JsonNode? value;
                if (lim.IsBool)
                    value = raw.Trim().ToLowerInvariant() is "true" or "1" or "yes" or "on";
                else if (key.EndsWith("_paise"))
                    value = RupeesToPaise(raw, key);
                else if (long.TryParse(raw, out var whole) || (double.TryParse(raw, out var d) && (whole = (long)d) == d))
                    value = whole;
                else
                    throw new AssistantActionException($"{key} needs a whole number");
                try { platformSettings.Validate(new JsonObject { [key] = value?.DeepClone() }); }
                catch (AppException e) { throw new AssistantActionException(e.Message); }
                var now = (await platformSettings.GetAsync())[key];
                clean["key"] = key; clean["value"] = value?.DeepClone();
                string Show(JsonNode? v) => key.EndsWith("_paise") ? Rupees(SettingsJson.ToLong(v))
                    : key.EndsWith("_bps") ? $"{SettingsJson.ToLong(v) / 100m}%" : SettingsJson.Text(v);
                Detail("Setting", key.Replace("_", " ")); Detail("Now", Show(now)); Detail("After", Show(value));
                summary = $"Change {key.Replace("_", " ")} to {Show(value)}";
                break;
            }
            case "run_payouts":
            {
                var dueCount = await db.ExecuteScalarAsync<long>(
                    "SELECT COUNT(*) FROM (SELECT 1 FROM seller_ledger WHERE payout_id IS NULL AND available_at <= UTC_TIMESTAMP(6) " +
                    "GROUP BY seller_id HAVING SUM(amount) > 0) due");
                var dueTotal = await db.ExecuteScalarAsync<long>(
                    "SELECT COALESCE(SUM(t.amount), 0) FROM (SELECT SUM(amount) AS amount FROM seller_ledger " +
                    "WHERE payout_id IS NULL AND available_at <= UTC_TIMESTAMP(6) GROUP BY seller_id HAVING SUM(amount) > 0) t");
                Detail("Sellers with money due", dueCount.ToString()); Detail("Total due now", Rupees(dueTotal));
                summary = "Create payouts for all sellers with money due";
                break;
            }
            case "approve_seller":
            case "reject_seller":
            case "suspend_seller":
            case "set_seller_commission":
            {
                var sid = await sellersDal.ResolveSellerAsync(Str(prms, "seller"))
                    ?? throw new AssistantActionException("I could not find exactly one seller with that name, GSTIN or id.");
                clean["seller_id"] = sid.Id.ToString();
                Detail("Seller", sid.DisplayName); Detail("Legal name", sid.LegalName); Detail("Status now", sid.Status);
                var verb = kind switch
                {
                    "approve_seller" => "Approve", "reject_seller" => "Ask to fix",
                    "suspend_seller" => "Suspend", _ => "Change commission for",
                };
                summary = $"{verb} {sid.DisplayName}";
                if (kind is "reject_seller" or "suspend_seller")
                {
                    clean["reason"] = Str(prms, "reason").Trim()[..Math.Min(1000, Str(prms, "reason").Trim().Length)];
                    Detail("Reason", clean["reason"]!.GetValue<string>());
                }
                if (kind == "set_seller_commission")
                {
                    var pct = Str(prms, "percent").Trim();
                    int? bps = null;
                    if (pct.Length > 0)
                    {
                        if (!double.TryParse(pct, out var pd))
                            throw new AssistantActionException("Commission must be between 0% and 50%");
                        bps = (int)Math.Round(pd * 100);
                        if (bps is < 0 or > 5000)
                            throw new AssistantActionException("Commission must be between 0% and 50%");
                    }
                    clean["bps"] = bps;
                    Detail("New commission", bps is null ? "Category rates" : $"{bps.Value / 100m:0.##}%");
                }
                break;
            }
            default:
                throw new AssistantActionException("Not supported");
        }
        var act = new AssistantActionModel
        {
            ConversationId = conversationId, UserId = userId, Kind = kind,
            Params = clean.ToJsonString(), Summary = summary[..Math.Min(500, summary.Length)], Status = "pending",
            Result = new JsonObject { ["details"] = details }.ToJsonString(),
            CreatedAt = DateTimeFunctions.UtcNow(), Id = Guid.NewGuid(),
        };
        await asstDal.InsertActionAsync(act);
        return act;
    }

    /// <summary>Confirm or cancel a pending action (reference: routers/assistant.py decide_action).</summary>
    public async Task<JsonObject> DecideAsync(UserModel user, Guid actionId, string decision)
    {
        await access.RequireAsync(user, "assistant_actions");
        var uid = user.Id; // read now: a rollback below expires loaded objects (reference comment)
        AssistantActionModel a;
        await using (var uow = await db.BeginAsync())
        {
            a = await asstDal.ActionForUpdateAsync(actionId, uow) ?? throw new NotFoundException("Action");
            if (a.UserId != uid) throw new NotFoundException("Action");
            if (a.Status != "pending")
                throw new AppException($"This action is already {a.Status}", "action_done", 409);
            if (decision == "cancel")
            {
                await asstDal.SaveActionDecisionAsync(a.Id, "cancelled", DateTimeFunctions.UtcNow(), a.Result, uow);
                await uow.CommitAsync();
                return new JsonObject { ["id"] = a.Id.ToString(), ["status"] = "cancelled" };
            }
            if (DateTimeFunctions.UtcNow() - a.CreatedAt > ExpiresAfter)
            {
                await asstDal.SaveActionStatusAsync(a.Id, "expired", uow);
                await uow.CommitAsync();
                throw new AppException("This suggestion expired. Ask again to get a fresh one.", "action_expired", 409);
            }
            await uow.CommitAsync();
        }
        var perms = await access.PermissionsForAsync(user);
        if (!Kinds.TryGetValue(a.Kind, out var def) || !perms.Contains(def.Permission))
            throw new AppException($"Your role no longer allows this ({(Kinds.TryGetValue(a.Kind, out var d2) ? d2.Permission : a.Kind)})", "forbidden", 403);
        JsonObject outcome;
        try
        {
            outcome = await ExecuteDispatchAsync(user, a);
        }
        catch (AppException exc)
        {
            await using var uow2 = await db.BeginAsync();
            var fresh = await asstDal.ActionForUpdateAsync(actionId, uow2) ?? throw new NotFoundException("Action");
            if (fresh.Status == "pending" && exc.Code != "action_expired")
            {
                var result = JsonNode.Parse(fresh.Result) is JsonObject ro ? ro : new JsonObject();
                result["error"] = exc.Message;
                await asstDal.SaveActionDecisionAsync(fresh.Id, "failed", DateTimeFunctions.UtcNow(), result.ToJsonString(), uow2);
                await AuditAsync(uow2, user, $"assistant.action.{fresh.Kind}", fresh.Id,
                    $"failed: {exc.Message[..Math.Min(200, exc.Message.Length)]}");
                await uow2.CommitAsync();
            }
            throw;
        }
        await using (var uow3 = await db.BeginAsync())
        {
            var done = await asstDal.ActionForUpdateAsync(actionId, uow3) ?? throw new NotFoundException("Action");
            var result = JsonNode.Parse(done.Result) is JsonObject ro ? ro : new JsonObject();
            var scalars = new JsonObject();
            foreach (var (k, v) in outcome)
                if (v is null || v is JsonValue) scalars[k] = v?.DeepClone();
            result["outcome"] = scalars;
            await asstDal.SaveActionDecisionAsync(done.Id, "done", DateTimeFunctions.UtcNow(), result.ToJsonString(), uow3);
            await AuditAsync(uow3, user, $"assistant.action.{done.Kind}", done.Id,
                done.Summary[..Math.Min(200, done.Summary.Length)]);
            await uow3.CommitAsync();
            return new JsonObject { ["id"] = done.Id.ToString(), ["status"] = "done", ["summary"] = done.Summary };
        }
    }

    /// <summary>Runs a confirmed action through the ported admin operation it mirrors (reference: actions.execute).</summary>
    private async Task<JsonObject> ExecuteDispatchAsync(UserModel user, AssistantActionModel act)
    {
        var p = JsonNode.Parse(act.Params) is JsonObject po ? po : new JsonObject();
        return act.Kind switch
        {
            "cancel_package" => await adminOps.CancelSubOrderAsync(user, Guid.Parse(Str(p, "sub_id")), Str(p, "reason")),
            "mark_delivered" => await adminOps.DeliverSubOrderAsync(user, Guid.Parse(Str(p, "sub_id"))),
            "retry_refund" => await adminOps.RetryRefundAsync(user, Guid.Parse(Str(p, "refund_id"))),
            "return_decision" => await returns.AdminActAsync(user, Guid.Parse(Str(p, "return_id")), Str(p, "decision"),
                Str(p, "note"), Str(p, "reference")),
            "block_customer" => await adminOps.BlockUserAsync(user, Guid.Parse(Str(p, "user_id")), Str(p, "reason")),
            "unblock_customer" => await adminOps.UnblockUserAsync(user, Guid.Parse(Str(p, "user_id"))),
            "update_setting" => await adminOps.WriteSettingsAsync(user,
                new JsonObject { [Str(p, "key")] = p["value"]?.DeepClone() }),
            "run_payouts" => await adminOps.RunPayoutsAsync(user),
            "approve_seller" => await sellers.ApproveAsync(user, Guid.Parse(Str(p, "seller_id"))),
            "reject_seller" => await sellers.RejectAsync(user, Guid.Parse(Str(p, "seller_id")), Str(p, "reason")),
            "suspend_seller" => await sellers.SuspendAsync(user, Guid.Parse(Str(p, "seller_id")), Str(p, "reason")),
            "set_seller_commission" => await sellers.CommissionAsync(user, Guid.Parse(Str(p, "seller_id")),
                p["bps"] is JsonValue bv && bv.TryGetValue<int>(out var b) ? b : null),
            _ => throw new AppException($"Preparing {act.Kind} is not available in this build yet; its admin operation has not been ported.",
                "action_unavailable", 400),
        };
    }

    /// <summary>Reference: actions._customer — a customer by id, email or mobile.</summary>
    private async Task<UserModel> CustomerAsync(string reference)
    {
        var r = reference.Trim();
        UserModel? u = null;
        var digits = new string(r.Where(char.IsDigit).ToArray());
        if (Guid.TryParse(r, out var id))
            u = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE is_admin = 0 AND id = @id", new { id });
        else if (r.Contains('@'))
            u = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE is_admin = 0 AND LOWER(email) = @email", new { email = r.ToLowerInvariant() });
        else if (digits.Length >= 10)
            u = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE is_admin = 0 AND phone = @phone", new { phone = digits[^10..] });
        else
            throw new AssistantActionException("Give the customer's mobile number, email or id.");
        return u ?? throw new AssistantActionException("No customer found with that mobile, email or id.");
    }

    private static long? RupeesToPaise(string v, string label)
    {
        if (v.Length == 0) return null;
        var cleaned = v.Replace(",", "").Replace("₹", "");
        if (!double.TryParse(cleaned, out var d))
            throw new AssistantActionException($"{label} must be an amount in rupees");
        return (long)Math.Round(d * 100);
    }

    private static async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, Guid entityId, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'assistant_action', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, eid = entityId.ToString(), detail, id = Guid.NewGuid() });
}
