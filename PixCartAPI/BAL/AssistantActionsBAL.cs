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
    ProductModerationDAL productsDal,
    IProductModerationBAL products,
    ICouponAdminBAL coupons,
    IReviewModerationBAL reviews,
    ISupportDeskBAL supportDesk,
    ISiteBAL site,
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
        ["approve_product"] = ("Approve a listing", "catalog", ["product"]),
        ["reject_product"] = ("Send a listing back to the seller", "catalog", ["product", "reason"]),
        ["approve_seller"] = ("Approve a seller", "sellers", ["seller"]),
        ["reject_seller"] = ("Ask a seller to fix their application", "sellers", ["seller", "reason"]),
        ["suspend_seller"] = ("Suspend a seller", "sellers", ["seller", "reason"]),
        ["set_seller_commission"] = ("Change a seller's commission", "sellers", ["seller"]),
        ["create_coupon"] = ("Create a coupon", "marketing", ["code", "kind"]),
        ["set_coupon_active"] = ("Switch a coupon on or off", "marketing", ["code"]),
        ["moderate_review"] = ("Publish or hide a review", "catalog", ["review_id", "decision"]),
        ["reply_ticket"] = ("Reply to a support ticket", "support", []),
        ["set_announcement"] = ("Change the storefront announcement bar", "marketing", ["text"]),
    };

    private static string Str(JsonObject p, string key) =>
        p[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

    /// <summary>A numeric parameter, whether the model sent it as a number or a string.</summary>
    private static bool TryNum(JsonObject p, string key, out double value)
    {
        value = 0;
        if (p[key] is not JsonValue v) return false;
        if (v.TryGetValue<int>(out var i)) { value = i; return true; }
        if (v.TryGetValue<long>(out var l)) { value = l; return true; }
        if (v.TryGetValue<double>(out var d)) { value = d; return true; }
        return v.TryGetValue<string>(out var s) && double.TryParse(s, out value);
    }

    /// <summary>A boolean parameter: JSON true/false or the strings true/1/yes/on (reference: str checks in actions.prepare).</summary>
    private static bool BoolParam(JsonObject p, string key)
    {
        if (p[key] is JsonValue v && v.TryGetValue<bool>(out var b)) return b;
        return Str(p, key).Trim().ToLowerInvariant() is "true" or "1" or "yes" or "on";
    }

    /// <summary>A rupees amount parameter converted to paise (reference: actions._rupees_to_paise). Null when absent/empty.</summary>
    private static long? RupeesToPaise(JsonObject p, string key)
    {
        if (!TryNum(p, key, out var v)) return null;
        return Math.Max(0, (long)(v * 100));
    }

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
            case "approve_product":
            case "reject_product":
            {
                var prod = await productsDal.ResolveProductAsync(Str(prms, "product"))
                    ?? throw new AssistantActionException(
                        "I could not find exactly one listing with that id or title. Search the catalogue first.");
                if (kind == "approve_product" && prod.Status != "pending")
                    throw new AssistantActionException($"This listing is {prod.Status}, not waiting for review.");
                var prodSeller = await sellersDal.SellerAsync(prod.SellerId);
                clean["product_id"] = prod.Id.ToString();
                Detail("Listing", prod.Title); Detail("Seller", prodSeller?.DisplayName ?? ""); Detail("Status now", prod.Status);
                summary = (kind == "approve_product" ? "Approve " : "Send back ") + "\u201c" + prod.Title + "\u201d";
                if (kind == "reject_product")
                {
                    clean["reason"] = Str(prms, "reason").Trim()[..Math.Min(1000, Str(prms, "reason").Trim().Length)];
                    Detail("Reason for seller", clean["reason"]!.GetValue<string>());
                }
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
            case "create_coupon":
            case "set_coupon_active":
            {
                // Reference: prepare create_coupon / set_coupon_active (permission "marketing").
                if (kind == "create_coupon")
                {
                    // Reference: prepare create_coupon. Model-facing value is percent (1-90) or flat rupees.
                    // HELD DEVIATION (owner decision pending): the reference prepare stores a percent value
                    // UNCONVERTED (int(value)), which its own endpoint then rejects (100..9000 bps). We keep
                    // reference-exact behavior here until the owner approves the percent->bps conversion;
                    // flat values convert rupees -> paise exactly like the reference.
                    var code = Str(prms, "code").Trim().ToUpperInvariant();
                    var ck = Str(prms, "kind").Trim().ToLowerInvariant();
                    if (ck is not ("percent" or "flat"))
                        throw new AssistantActionException("kind is percent or flat");
                    if (!TryNum(prms, "value", out var rawValue) || rawValue <= 0)
                        throw new AssistantActionException("Coupon value must be a positive number.");
                    var storeValue = ck == "percent" ? (long)Math.Round(rawValue) : (long)Math.Round(rawValue * 100);
                    if (await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM coupons WHERE UPPER(code) = @code", new { code }) > 0)
                        throw new AssistantActionException("This code is already used");
                    clean["code"] = code; clean["kind"] = ck; clean["value"] = storeValue;
                    clean["min_order_paise"] = RupeesToPaise(prms, "min_order_rupees") ?? 0;
                    var maxDisc = RupeesToPaise(prms, "max_discount_rupees");
                    if (maxDisc is not null) clean["max_discount_paise"] = maxDisc.Value;
                    if (TryNum(prms, "usage_limit", out var ul) && ul > 0) clean["usage_limit"] = (int)ul;
                    clean["ends_on"] = Str(prms, "ends_on").Trim();
                    var desc = Str(prms, "description").Trim();
                    clean["description"] = desc[..Math.Min(200, desc.Length)];
                    Detail("Code", code);
                    Detail("Discount", ck == "percent" ? $"{rawValue:0.##}%" : Money.Rupees(storeValue));
                    if (ck == "percent") Detail("Note", "Stored as-is (reference behavior); percent conversion is pending owner approval");
                    Detail("Minimum order", Money.Rupees(RupeesToPaise(prms, "min_order_rupees") ?? 0));
                    Detail("Cap", maxDisc is null ? "None" : Money.Rupees(maxDisc.Value));
                    Detail("Total uses", clean["usage_limit"]?.GetValue<int>().ToString() ?? "Unlimited");
                    Detail("Last day", Str(prms, "ends_on").Trim().Length > 0 ? Str(prms, "ends_on").Trim() : "No end date");
                    summary = $"Create coupon {code}";
                }
                else
                {
                    // Reference: prepare set_coupon_active — the model names the coupon by its code.
                    var ccode = Str(prms, "code").Trim().ToUpperInvariant();
                    var found = await db.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE UPPER(code) = @ccode", new { ccode })
                        ?? throw new AssistantActionException("No coupon with that code.");
                    if (prms["active"] is null)
                        throw new AssistantActionException("Missing: active");
                    var active = BoolParam(prms, "active");
                    clean["coupon_id"] = found.Id.ToString();
                    clean["active"] = active;
                    Detail("Coupon", found.Code); Detail("Now", found.IsActive ? "on" : "off"); Detail("After", active ? "on" : "off");
                    summary = $"Switch coupon {found.Code} {(active ? "on" : "off")}";
                }
                break;
            }
            case "moderate_review":
            {
                // Reference: prepare moderate_review (permission "catalog").
                var rid = Str(prms, "review_id");
                if (!Guid.TryParse(rid, out var rguid))
                    throw new AssistantActionException("I need the review's id.");
                var rev = await db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @rguid", new { rguid })
                    ?? throw new AssistantActionException("I could not find a review with that id.");
                var decision = Str(prms, "decision").Trim().ToLowerInvariant();
                if (decision is not ("publish" or "hide"))
                    throw new AssistantActionException("I can publish or hide a review.");
                clean["review_id"] = rguid.ToString(); clean["decision"] = decision;
                var pname = await db.ExecuteScalarAsync<string?>("SELECT title FROM products WHERE id = @pid", new { pid = rev.ProductId }) ?? "";
                Detail("Review", $"{rev.Rating} stars on {pname}"); Detail("Decision", decision);
                summary = $"{(decision == "publish" ? "Publish" : "Hide")} review on {pname}";
                break;
            }
            case "reply_ticket":
            {
                // Reference: prepare reply_ticket (permission "support") — params ticket (number), message, optional status.
                var tno = Str(prms, "ticket").Trim();
                if (tno.Length == 0) tno = Str(prms, "ticket_number").Trim();
                if (tno.Length == 0)
                    throw new AssistantActionException("Missing: ticket");
                var tk = await db.QueryFirstOrDefaultAsync<SupportTicketModel>(
                    "SELECT * FROM support_tickets WHERE UPPER(number) = UPPER(@tno)", new { tno })
                    ?? throw new AssistantActionException("No ticket with that number.");
                clean["ticket_id"] = tk.Id.ToString();
                var tbody = Str(prms, "message").Trim();
                if (tbody.Length == 0) tbody = Str(prms, "body").Trim();
                if (tbody.Length == 0)
                    throw new AssistantActionException("Missing: message");
                clean["body"] = tbody[..Math.Min(5000, tbody.Length)];
                var tstatus = Str(prms, "status").Trim().ToLowerInvariant();
                if (tstatus.Length > 0)
                {
                    if (tstatus is not ("open" or "awaiting_customer" or "resolved" or "closed"))
                        throw new AssistantActionException("status is open, awaiting_customer, resolved or closed");
                    clean["status"] = tstatus;
                }
                clean["internal"] = BoolParam(prms, "internal");
                Detail("Ticket", $"{tk.Number} — {tk.Subject}");
                Detail("Reply", clean["body"]!.GetValue<string>());
                if (tstatus.Length > 0) Detail("New status", tstatus);
                summary = $"Reply to ticket {tk.Number}";
                break;
            }
            case "set_announcement":
            {
                // Reference: prepare set_announcement (permission "marketing").
                var atext = string.Join(' ', Str(prms, "text").Split(' ', StringSplitOptions.RemoveEmptyEntries));
                atext = atext[..Math.Min(160, atext.Length)];
                var alink = Str(prms, "link").Trim();
                alink = alink[..Math.Min(200, alink.Length)];
                if (alink.Length > 0 && !(alink.StartsWith('/') && !alink.StartsWith("//")))
                    throw new AssistantActionException("The link must be a page on this site, starting with /");
                clean["text"] = atext; clean["link"] = alink;
                Detail("Announcement", atext.Length > 0 ? atext : "(hidden)");
                Detail("Link", alink.Length > 0 ? alink : "\u2014");
                summary = atext.Length == 0 ? "Hide the announcement bar" : "Change the announcement bar";
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
            "approve_product" => await products.ApproveAsync(user, Guid.Parse(Str(p, "product_id"))),
            "reject_product" => await products.RejectAsync(user, Guid.Parse(Str(p, "product_id")), Str(p, "reason")),
            "approve_seller" => await sellers.ApproveAsync(user, Guid.Parse(Str(p, "seller_id"))),
            "reject_seller" => await sellers.RejectAsync(user, Guid.Parse(Str(p, "seller_id")), Str(p, "reason")),
            "suspend_seller" => await sellers.SuspendAsync(user, Guid.Parse(Str(p, "seller_id")), Str(p, "reason")),
            "set_seller_commission" => await sellers.CommissionAsync(user, Guid.Parse(Str(p, "seller_id")),
                p["bps"] is JsonValue bv && bv.TryGetValue<int>(out var b) ? b : null),
            "create_coupon" => await coupons.CreateAsync(user, Str(p, "code"), Str(p, "description"), Str(p, "kind"),
                (int)(p["value"] is JsonValue cv && cv.TryGetValue<long>(out var cvv) ? cvv : 0),
                p["max_discount_paise"] is JsonValue md && md.TryGetValue<long>(out var mdv) ? mdv : null,
                p["min_order_paise"] is JsonValue mo && mo.TryGetValue<long>(out var mov) ? mov : 0,
                null, CouponEndsOn(Str(p, "ends_on")),
                p["usage_limit"] is JsonValue ul2 && ul2.TryGetValue<int>(out var ulv) ? ulv : null,
                1, true, null, false, true),
            "set_coupon_active" => await coupons.SetActiveAsync(user, Guid.Parse(Str(p, "coupon_id")),
                p["active"] is JsonValue av && av.TryGetValue<bool>(out var a) && a),
            "moderate_review" => await reviews.ModerateAsync(user, Guid.Parse(Str(p, "review_id")), Str(p, "decision")),
            "reply_ticket" => await supportDesk.ReplyAsync(user, Guid.Parse(Str(p, "ticket_id")), Str(p, "body"),
                p["internal"] is JsonValue iv && iv.TryGetValue<bool>(out var ib) && ib,
                Str(p, "status") is { Length: > 0 } st ? st : null, null, null),
            "set_announcement" => await SetAnnouncementAsync(user, Str(p, "text"), Str(p, "link")),
            _ => throw new AppException($"Preparing {act.Kind} is not available in this build yet; its admin operation has not been ported.",
                "action_unavailable", 400),
        };
    }

    /// <summary>Reference: execute create_coupon — an ends_on date means 23:59:59 IST that day; stored as UTC.</summary>
    private static DateTime? CouponEndsOn(string endsOn)
    {
        if (!DateTime.TryParse(endsOn.Trim(), out var d)) return null;
        return new DateTimeOffset(d.Year, d.Month, d.Day, 23, 59, 59, TimeSpan.FromMinutes(330)).UtcDateTime;
    }

    /// <summary>Reference: execute set_announcement — merge the announcement bar into the site document.</summary>
    private async Task<JsonObject> SetAnnouncementAsync(UserModel user, string text, string link)
    {
        await access.RequireAsync(user, "marketing");
        var doc = await site.GetSiteAsync();
        var ann = doc["announcement"] is JsonObject a ? a : new JsonObject();
        ann["enabled"] = text.Length > 0;
        if (text.Length > 0)
            ann["text"] = text;
        ann["link"] = link;
        doc["announcement"] = ann;
        await site.SaveSiteAsync(doc);
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, 'storefront.announcement', 'settings', 'site', 'assistant', UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, id = Guid.NewGuid() });
        await uow.CommitAsync();
        return new JsonObject { ["enabled"] = text.Length > 0, ["text"] = ann["text"]?.GetValue<string>() };
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
