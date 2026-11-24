using System.Globalization;
using System.Text.Json.Nodes;
using BAL.AI;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.Assistant;

/// <summary>A proposal that cannot be prepared; the message goes back to the model.</summary>
public sealed class ActionException(string message) : Exception(message);

/// <summary>
/// Changes the assistant can propose. Nothing here runs until the staff member presses Confirm: the model calls
/// propose_action → <see cref="PrepareAsync"/> checks the permission, finds the record and stores a pending action with a
/// plain-language summary → the chat shows Confirm / Cancel → <see cref="ExecuteAsync"/> makes the change with the same
/// rules and audit entries as the admin panel. Pending actions expire after 30 minutes and only the person they were
/// proposed to can confirm them.
/// </summary>
public sealed class AssistantActions(AssistantDAL dal, AiDAL ai, AssistantQueries q, IAccessBAL access, AppSettings env)
{
    public static readonly TimeSpan ExpiresAfter = TimeSpan.FromMinutes(30);
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static readonly Dictionary<string, JsonObject> Defs = RefData.Arr("assistant_actions").OfType<JsonObject>().ToDictionary(a => J.S(a["kind"]));

    /// <summary>Kinds that belong to modules not merged yet; they are proposed normally but tell the person where to do it.</summary>
    private static readonly Dictionary<string, (string Label, string Href)> Elsewhere = new()
    {
        ["mark_delivered"] = ("Orders", "/admin/orders"), ["return_decision"] = ("Returns", "/admin/returns"), ["run_payouts"] = ("Payouts", "/admin/payouts"),
    };

    private static string Inr(long paise) => AiShared.Inr(paise);

    private static string P(JsonObject p, string k) => J.S(p[k]);

    private static long? RupeesToPaise(JsonNode? v, string label)
    {
        var s = J.S(v);
        if (v is null || s == "") return null;
        if (!double.TryParse(s.Replace(",", "").Replace("₹", ""), NumberStyles.Float, Inv, out var d)) throw new ActionException($"{label} must be an amount in rupees");
        return (long)Math.Round(d * 100, MidpointRounding.ToEven);
    }

    private async Task<ProductModel> ProductAsync(string reference)
    {
        if (Guid.TryParse(reference, out var id) && await dal.ProductAsync(id) is { } p) return p;
        var rows = await dal.ProductsByTitleAsync(reference);
        if (rows.Count != 1) throw new ActionException("I could not find exactly one listing with that id or title. Search the catalogue first.");
        return rows[0];
    }

    private async Task<SellerModel> SellerAsync(string reference) =>
        await q.ResolveSellerAsync(reference) ?? throw new ActionException("I could not find exactly one seller with that name, GSTIN or id.");

    private async Task<UserModel> CustomerAsync(string reference)
    {
        reference = reference.Trim();
        var digits = new string(reference.Where(char.IsDigit).ToArray());
        UserModel? u;
        if (Guid.TryParse(reference, out var id)) u = await dal.CustomerForActionAsync(id, null, null);
        else if (reference.Contains('@')) u = await dal.CustomerForActionAsync(null, reference, null);
        else if (digits.Length >= 10) u = await dal.CustomerForActionAsync(null, null, digits[^10..]);
        else throw new ActionException("Give the customer's mobile number, email or id.");
        return u ?? throw new ActionException("No customer found with that mobile, email or id.");
    }

    /// <summary>Validates a proposal and stores it as pending. Throws ActionException with a message for the model.</summary>
    public async Task<AssistantActionModel> PrepareAsync(UserModel user, Guid conversationId, string kind, JsonObject prms)
    {
        if (!Defs.TryGetValue(kind, out var spec)) throw new ActionException($"Unknown action. Available: {string.Join(", ", Defs.Keys)}");
        access.Invalidate();
        var permission = J.S(spec["permission"]);
        if (!(await access.PermissionsForAsync(user)).Contains(permission)) throw new ActionException($"Your role cannot do this ({permission}). Ask an owner to change your role.");
        var missing = (spec["required"] as JsonArray ?? []).Select(J.S).Where(r => prms[r] is null || J.S(prms[r]) == "").ToList();
        if (missing.Count > 0) throw new ActionException($"Missing: {string.Join(", ", missing)}");
        var clean = new JsonObject();
        var details = new List<(string, string)>();
        string summary;
        switch (kind)
        {
            case "approve_product" or "reject_product":
            {
                var p = await ProductAsync(P(prms, "product"));
                if (kind == "approve_product" && p.Status != "pending") throw new ActionException($"This listing is {p.Status}, not waiting for review.");
                var seller = await ai.GetSellerAsync(p.SellerId);
                clean["product_id"] = p.Id.ToString();
                details.AddRange([("Listing", p.Title), ("Seller", seller?.DisplayName ?? ""), ("Status now", p.Status)]);
                summary = $"{(kind == "approve_product" ? "Approve" : "Send back")} “{p.Title}”";
                if (kind == "reject_product")
                {
                    clean["reason"] = J.Cut(P(prms, "reason").Trim(), 1000);
                    details.Add(("Reason for seller", J.S(clean["reason"])));
                }
                break;
            }
            case "approve_seller" or "reject_seller" or "suspend_seller" or "set_seller_commission":
            {
                var s = await SellerAsync(P(prms, "seller"));
                clean["seller_id"] = s.Id.ToString();
                details.AddRange([("Seller", s.DisplayName), ("Legal name", s.LegalName), ("Status now", s.Status)]);
                var verb = kind switch { "approve_seller" => "Approve", "reject_seller" => "Ask to fix", "suspend_seller" => "Suspend", _ => "Change commission for" };
                summary = $"{verb} {s.DisplayName}";
                if (kind is "reject_seller" or "suspend_seller")
                {
                    clean["reason"] = J.Cut(P(prms, "reason").Trim(), 1000);
                    details.Add(("Reason", J.S(clean["reason"])));
                }
                if (kind == "set_seller_commission")
                {
                    long? bps = null;
                    if (prms["percent"] is { } pct && J.S(pct) != "")
                    {
                        var d = J.Double(pct) ?? throw new ActionException("Commission must be between 0% and 50%");
                        bps = (long)Math.Round(d * 100, MidpointRounding.ToEven);
                        if (bps is < 0 or > 5000) throw new ActionException("Commission must be between 0% and 50%");
                    }
                    clean["bps"] = bps;
                    details.Add(("New commission", bps is null ? "Category rates" : $"{(bps.Value / 100.0).ToString("0.##", Inv)}%"));
                }
                break;
            }
            case "cancel_package" or "mark_delivered":
            {
                var sub = await dal.SubByNumberAsync(P(prms, "package")) ?? throw new ActionException($"No package numbered {P(prms, "package")}.");
                clean["sub_id"] = sub.Id.ToString();
                details.AddRange([("Package", sub.Number), ("Status now", sub.Status), ("Value", Inr(sub.Total))]);
                summary = $"{(kind == "cancel_package" ? "Cancel" : "Mark delivered")} package {sub.Number}";
                if (kind == "cancel_package")
                {
                    clean["reason"] = J.Cut(P(prms, "reason").Trim(), 1000);
                    details.Add(("Reason", J.S(clean["reason"])));
                }
                break;
            }
            case "retry_refund":
            {
                var r = (Guid.TryParse(P(prms, "refund_id"), out var rid) ? await dal.RefundAsync(rid) : null) ?? throw new ActionException("No refund with that id.");
                clean["refund_id"] = r.Id.ToString();
                details.AddRange([("Amount", Inr(r.AmountPaise)), ("Status now", r.Status), ("Attempts", r.Attempts.ToString(Inv))]);
                summary = $"Retry refund of {Inr(r.AmountPaise)}";
                break;
            }
            case "return_decision":
            {
                var ret = await dal.ReturnByNumberAsync(P(prms, "return_number")) ?? throw new ActionException("No return with that number.");
                var decision = P(prms, "decision").Trim();
                if (decision is not ("approve" or "reject" or "received" or "mark_refunded")) throw new ActionException("decision is approve, reject, received or mark_refunded");
                clean["return_id"] = ret.Id.ToString();
                clean["decision"] = decision;
                clean["note"] = J.Cut(P(prms, "note"), 2000);
                clean["reference"] = J.Cut(P(prms, "reference"), 60);
                details.AddRange([("Return", ret.Number), ("Status now", ret.Status), ("Refund", Inr(ret.RefundAmount)), ("Decision", decision.Replace('_', ' '))]);
                var d = decision.Replace('_', ' ');
                summary = $"{char.ToUpperInvariant(d[0]) + d[1..]} return {ret.Number}";
                break;
            }
            case "block_customer" or "unblock_customer":
            {
                var u = await CustomerAsync(P(prms, "customer"));
                clean["user_id"] = u.Id.ToString();
                details.AddRange([("Customer", u.Name.Length > 0 ? u.Name : "—"), ("Mobile", u.Phone ?? "—"), ("Active now", u.IsActive ? "yes" : "no")]);
                summary = $"{(kind == "block_customer" ? "Block" : "Unblock")} {(u.Name.Length > 0 ? u.Name : u.Phone ?? "customer")}";
                if (kind == "block_customer")
                {
                    clean["reason"] = J.Cut(P(prms, "reason").Trim(), 1000);
                    details.Add(("Reason", J.S(clean["reason"])));
                }
                break;
            }
            case "create_coupon":
            {
                var code = P(prms, "code").Trim().ToUpperInvariant();
                var kindV = P(prms, "kind").Trim().ToLowerInvariant();
                if (kindV is not ("percent" or "flat")) throw new ActionException("kind is percent or flat");
                var value = J.Double(prms["value"]) ?? throw new ActionException("value must be a number");
                var v = kindV == "percent" ? (long)value : (long)Math.Round(value * 100, MidpointRounding.ToEven);
                var usage = prms["usage_limit"] is { } ul && J.S(ul) != "" ? J.Long(ul) : null;
                clean = J.O(("code", code), ("kind", kindV), ("value", v), ("min_order_paise", RupeesToPaise(prms["min_order_rupees"], "Minimum order") ?? 0),
                    ("max_discount_paise", RupeesToPaise(prms["max_discount_rupees"], "Maximum discount")), ("usage_limit", usage), ("ends_on", P(prms, "ends_on")),
                    ("description", J.Cut(P(prms, "description"), 200)));
                var cap = J.Long(clean["max_discount_paise"]);
                details.AddRange([("Code", code), ("Discount", kindV == "percent" ? $"{v}%" : Inr(v)), ("Minimum order", Inr(J.Long(clean["min_order_paise"]) ?? 0)),
                    ("Cap", cap is > 0 ? Inr(cap.Value) : "None"), ("Total uses", usage is > 0 ? usage.Value.ToString(Inv) : "Unlimited"),
                    ("Last day", P(clean, "ends_on").Length > 0 ? P(clean, "ends_on") : "No end date")]);
                summary = $"Create coupon {code}";
                break;
            }
            case "set_coupon_active":
            {
                var c = await dal.CouponByCodeAsync(P(prms, "code")) ?? throw new ActionException("No coupon with that code.");
                var active = P(prms, "active").Trim().ToLowerInvariant() is "true" or "1" or "yes" or "on";
                clean = J.O(("coupon_id", c.Id.ToString()), ("active", active));
                details.AddRange([("Coupon", c.Code), ("Now", c.IsActive ? "on" : "off"), ("After", active ? "on" : "off")]);
                summary = $"Switch coupon {c.Code} {(active ? "on" : "off")}";
                break;
            }
            case "reply_ticket":
            {
                var t = await dal.TicketByNumberAsync(P(prms, "ticket")) ?? throw new ActionException("No ticket with that number.");
                var status = P(prms, "status") is { Length: > 0 } st ? st : null;
                if (status != null && status is not ("open" or "awaiting_customer" or "resolved" or "closed")) throw new ActionException("status is open, awaiting_customer, resolved or closed");
                clean = J.O(("ticket_id", t.Id.ToString()), ("message", J.Cut(P(prms, "message").Trim(), 5000)), ("status", status));
                details.AddRange([("Ticket", $"{t.Number} — {t.Subject}"), ("Reply", P(clean, "message"))]);
                if (status != null) details.Add(("New status", status));
                summary = $"Reply to ticket {t.Number}";
                break;
            }
            case "moderate_review":
            {
                var r = (Guid.TryParse(P(prms, "review_id"), out var rid) ? await dal.ReviewAsync(rid) : null) ?? throw new ActionException("No review with that id.");
                var decision = P(prms, "decision").Trim();
                if (decision is not ("publish" or "hide")) throw new ActionException("decision is publish or hide");
                clean = J.O(("review_id", r.Id.ToString()), ("decision", decision));
                details.AddRange([("Review", $"{r.Rating}★ {(r.Title.Length > 0 ? r.Title : J.Cut(r.Body, 60))}"), ("Decision", decision)]);
                summary = $"{char.ToUpperInvariant(decision[0]) + decision[1..]} a {r.Rating}-star review";
                break;
            }
            case "update_setting":
            {
                var key = P(prms, "key").Trim();
                var limits = RefData.Obj("marketplace_limits");
                if (limits[key] is not JsonArray lim) throw new ActionException($"Unknown setting. Settings: {string.Join(", ", limits.Select(kv => kv.Key))}");
                var raw = prms["value"];
                JsonNode value;
                if (J.S(lim[0]) == "bool") value = JsonValue.Create(J.S(raw).Trim().ToLowerInvariant() is "true" or "1" or "yes" or "on");
                else if (key.EndsWith("_paise")) value = JsonValue.Create(RupeesToPaise(raw, key) ?? 0);
                else value = JsonValue.Create((long)(J.Double(raw) ?? throw new ActionException($"{key} needs a whole number")));
                try { value = AiShared.ValidateSetting(key, value); }
                catch (ArgumentException exc) { throw new ActionException(exc.Message); }
                var nowValue = (await AiShared.MarketplaceAsync(ai))[key];
                clean = J.O(("key", key), ("value", value));
                string Show(JsonNode? v) => key.EndsWith("_paise") ? Inr(J.Long(v) ?? 0) : key.EndsWith("_bps") ? $"{((J.Double(v) ?? 0) / 100).ToString("0.##", Inv)}%"
                    : J.IsBool(v) ? (J.Truthy(v) ? "True" : "False") : J.S(v);
                details.AddRange([("Setting", key.Replace('_', ' ')), ("Now", Show(nowValue)), ("After", Show(value))]);
                summary = $"Change {key.Replace('_', ' ')} to {Show(value)}";
                break;
            }
            case "set_announcement":
            {
                var text = J.Cut(string.Join(' ', P(prms, "text").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), 160);
                var link = J.Cut(P(prms, "link").Trim(), 200);
                if (link.Length > 0 && !(link.StartsWith('/') && !link.StartsWith("//"))) throw new ActionException("The link must be a page on this site, starting with /");
                clean = J.O(("text", text), ("link", link));
                details.AddRange([("Announcement", text.Length > 0 ? text : "(hidden)"), ("Link", link.Length > 0 ? link : "—")]);
                summary = text.Length == 0 ? "Hide the announcement bar" : "Change the announcement bar";
                break;
            }
            default: // run_payouts
            {
                var ov = await q.PayoutsOverviewAsync(null, 1);
                details.AddRange([("Sellers with money due", (ov["due_now"] as JsonArray)!.Count.ToString(Inv)), ("Total due now", Inr(J.Long(ov["due_now_total"]) ?? 0))]);
                summary = "Create payouts for all sellers with money due";
                break;
            }
        }
        var act = new AssistantActionModel
        {
            Id = Guid.NewGuid(), ConversationId = conversationId, UserId = user.Id, Kind = kind, Params = J.Dumps(clean), Summary = J.Cut(summary, 500), Status = "pending",
            Result = J.Dumps(J.O(("details", J.A(details.Select(d => (object?)J.Strings([d.Item1, d.Item2])))))), CreatedAt = DateTimeFunctions.UtcNow(),
        };
        await dal.InsertActionAsync(act);
        return act;
    }

    /// <summary>Runs a confirmed action with the same rules as the admin panel. Returns the outcome (simple values).</summary>
    public async Task<JsonObject> ExecuteAsync(UserModel user, AssistantActionModel act)
    {
        if (act.UserId != user.Id) throw new AppException("Only the person who asked can confirm this", "not_yours", 403);
        if (act.Status != "pending") throw new AppException($"This action is already {act.Status}", "action_done", 409);
        if (DateTimeFunctions.UtcNow() - act.CreatedAt > ExpiresAfter)
        {
            act.Status = "expired";
            await dal.UpdateActionAsync(act);
            throw new AppException("This suggestion expired. Ask again to get a fresh one.", "action_expired", 409);
        }
        var spec = Defs[act.Kind];
        access.Invalidate();
        var permission = J.S(spec["permission"]);
        if (!(await access.PermissionsForAsync(user)).Contains(permission)) throw new AppException($"Your role no longer allows this ({permission})", "forbidden", 403);
        if (Elsewhere.TryGetValue(act.Kind, out var page))
            throw new AppException($"This change cannot be made from the assistant in this version yet. Use {page.Label} ({page.Href}).", "action_unavailable", 409);
        var p = J.Obj(act.Params);
        var now = DateTimeFunctions.UtcNow();
        Guid G(string k) => Guid.Parse(P(p, k));
        switch (act.Kind)
        {
            case "approve_product":
            {
                var prod = await dal.ProductAsync(G("product_id")) ?? throw new NotFoundException("Product");
                if (prod.Status != "pending") throw new ConflictException($"A {prod.Status} product cannot be approved", "invalid_status");
                await dal.ExecAsync("UPDATE products SET status = 'approved', approved_at = @now, rejection_reason = '' WHERE id = @id", new { id = prod.Id, now });
                await ai.AuditAsync(user.Id, "product.approve", "product", prod.Id);
                await NotifySellerAsync(prod.SellerId, "listing_update", new() { ["status"] = "approved", ["title"] = prod.Title, ["message"] = "It is live on the store now." },
                    $"/seller/products/{prod.Id}");
                return J.O(("id", prod.Id.ToString()), ("status", "approved"));
            }
            case "reject_product":
            {
                var prod = await dal.ProductAsync(G("product_id")) ?? throw new NotFoundException("Product");
                if (prod.Status is not ("pending" or "approved")) throw new ConflictException($"A {prod.Status} product cannot be rejected", "invalid_status");
                var reason = P(p, "reason");
                await dal.ExecAsync("UPDATE products SET status = 'rejected', rejection_reason = @reason WHERE id = @id", new { id = prod.Id, reason });
                await ai.AuditAsync(user.Id, "product.reject", "product", prod.Id, reason);
                await NotifySellerAsync(prod.SellerId, "listing_update", new() { ["status"] = prod.Status == "approved" ? "taken down" : "not approved", ["title"] = prod.Title,
                    ["message"] = $"Reason: {reason}. Edit the listing and send it for review again." }, $"/seller/products/{prod.Id}");
                return J.O(("id", prod.Id.ToString()), ("status", "rejected"));
            }
            case "approve_seller" or "reject_seller" or "suspend_seller" or "set_seller_commission":
            {
                var s = await dal.SellerAsync(G("seller_id")) ?? throw new NotFoundException("Seller");
                var reason = P(p, "reason");
                if (act.Kind == "approve_seller")
                {
                    if (s.Status is not ("submitted" or "suspended" or "rejected")) throw new ConflictException($"A {s.Status} seller cannot be approved", "invalid_status");
                    await dal.ExecAsync("UPDATE sellers SET status = 'approved', approved_at = COALESCE(approved_at, @now), rejection_reason = '' WHERE id = @id", new { id = s.Id, now });
                    await ai.AuditAsync(user.Id, "seller.approve", "seller", s.Id, $"from {s.Status}");
                    var again = s.Status == "suspended";
                    await NotifySellerAsync(s.Id, "seller_kyc_update", new() { ["status"] = again ? "active again" : "approved",
                        ["message"] = again ? "Your store is active again." : "Your store is approved. You can list products and receive orders." }, "/seller");
                }
                else if (act.Kind == "reject_seller")
                {
                    if (s.Status is not ("submitted" or "approved")) throw new ConflictException($"A {s.Status} seller cannot be sent back", "invalid_status");
                    await dal.ExecAsync("UPDATE sellers SET status = 'rejected', rejection_reason = @reason WHERE id = @id", new { id = s.Id, reason });
                    await ai.AuditAsync(user.Id, "seller.reject", "seller", s.Id, reason);
                    await NotifySellerAsync(s.Id, "seller_kyc_update", new() { ["status"] = "sent back for changes", ["message"] = $"Please update your details and submit again: {reason}" },
                        "/seller/onboarding");
                }
                else if (act.Kind == "suspend_seller")
                {
                    if (s.Status != "approved") throw new ConflictException("Only approved sellers can be suspended", "invalid_status");
                    await dal.ExecAsync("UPDATE sellers SET status = 'suspended', rejection_reason = @reason WHERE id = @id", new { id = s.Id, reason });
                    await ai.AuditAsync(user.Id, "seller.suspend", "seller", s.Id, reason);
                    await NotifySellerAsync(s.Id, "seller_kyc_update", new() { ["status"] = "suspended", ["message"] = $"Your store is suspended: {reason}. Contact seller support." },
                        "/seller/onboarding");
                }
                else
                {
                    var bps = J.Long(p["bps"]);
                    await dal.ExecAsync("UPDATE sellers SET commission_bps_override = @bps WHERE id = @id", new { id = s.Id, bps });
                    await ai.AuditAsync(user.Id, "seller.commission", "seller", s.Id, bps?.ToString(Inv) ?? "None");
                }
                return J.O(("id", s.Id.ToString()));
            }
            case "cancel_package":
            {
                var refund = await OrderOps.AdminCancelAsync(ai, env, G("sub_id"), P(p, "reason"), user.Id);
                return J.O(("ok", true), ("refund_id", refund?.ToString()));
            }
            case "retry_refund":
            {
                var r = await dal.RefundAsync(G("refund_id")) ?? throw new NotFoundException("Refund");
                if (r.Status != "failed") throw new ConflictException("Only failed refunds can be retried", "invalid_status");
                await dal.ExecAsync("UPDATE refunds SET status = 'pending', attempts = 0, provider_refund_id = NULL WHERE id = @id", new { id = r.Id });
                await ai.AuditAsync(user.Id, "refund.retry", "refund", r.Id);
                return J.O(("ok", true));
            }
            case "block_customer" or "unblock_customer":
            {
                var u = await dal.UserAsync(G("user_id")) ?? throw new NotFoundException("User");
                if (act.Kind == "block_customer")
                {
                    if (u.Id == user.Id || u.IsAdmin) throw new ConflictException("Admins cannot be blocked here", "invalid_target");
                    await dal.ExecAsync("UPDATE users SET is_active = 0 WHERE id = @id", new { id = u.Id });
                    await dal.ExecAsync("UPDATE refresh_sessions SET revoked_at = @now WHERE user_id = @id AND revoked_at IS NULL", new { id = u.Id, now });
                    await ai.AuditAsync(user.Id, "user.block", "user", u.Id, P(p, "reason"));
                }
                else
                {
                    if (u.IsAdmin) throw new ConflictException("Staff accounts are managed in Staff and roles", "invalid_target");
                    await dal.ExecAsync("UPDATE users SET is_active = 1 WHERE id = @id", new { id = u.Id });
                    await ai.AuditAsync(user.Id, "user.unblock", "user", u.Id);
                }
                return J.O(("ok", true));
            }
            case "create_coupon":
            {
                var code = P(p, "code");
                var kind = P(p, "kind");
                var value = J.Long(p["value"]) ?? 0;
                if (code.Length is < 4 or > 30 || !code.All(char.IsLetterOrDigit)) throw new AppException("Code must be 4-30 letters or digits", "validation_error", 422);
                if (kind == "percent" ? value is < 1 or > 90 : value < 100) throw new AppException(kind == "percent" ? "Percent must be 1 to 90" : "Flat discount must be at least ₹1", "invalid_value");
                if (await dal.CouponByCodeAsync(code) != null) throw new ConflictException("This code is already used", "code_taken");
                DateTime? ends = null;
                if (P(p, "ends_on").Length > 0)
                {
                    if (!DateOnly.TryParseExact(P(p, "ends_on"), "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d)) throw new AppException("Last day must look like 2026-12-31", "validation_error", 422);
                    ends = DateTimeFunctions.IstToUtc(d.ToDateTime(new TimeOnly(23, 59, 59)));
                }
                await dal.ExecAsync(
                    "INSERT INTO coupons (id, code, description, kind, value, max_discount_paise, min_order_paise, starts_at, ends_at, usage_limit, per_user_limit, used_count, funded_by, " +
                    "seller_id, category_id, first_order_only, is_active, show_on_checkout) VALUES (@id, @code, @description, @kind, @value, @cap, @min, NULL, @ends, @usage, 1, 0, 'platform', " +
                    "NULL, NULL, 0, 1, 1)",
                    new { id = Guid.NewGuid(), code, description = P(p, "description"), kind, value, cap = J.Long(p["max_discount_paise"]), min = J.Long(p["min_order_paise"]) ?? 0,
                          ends, usage = J.Long(p["usage_limit"]) });
                await ai.AuditAsync(user.Id, "coupon.create", "coupon", code);
                return J.O(("code", code));
            }
            case "set_coupon_active":
            {
                var active = J.Truthy(p["active"]);
                await dal.ExecAsync("UPDATE coupons SET is_active = @active WHERE id = @id", new { id = G("coupon_id"), active });
                var code = (await dal.OneAsync("SELECT code FROM coupons WHERE id = @id", new { id = G("coupon_id") }))?.S("code") ?? "";
                await ai.AuditAsync(user.Id, "coupon.update", "coupon", code, $"active={(active ? "True" : "False")} (assistant)");
                return J.O(("code", code), ("is_active", active));
            }
            case "reply_ticket":
            {
                await using var uow = await dal.BeginAsync();
                var t = await uow.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE id = @id FOR UPDATE", new { id = G("ticket_id") })
                        ?? throw new NotFoundException("Ticket");
                var status = P(p, "status") is { Length: > 0 } st ? st : "awaiting_customer";
                await uow.ExecuteAsync("INSERT INTO ticket_messages (id, ticket_id, author_id, author_role, body, is_internal, created_at) VALUES (@mid, @tid, @uid, 'staff', @body, 0, @now)",
                    new { mid = Guid.NewGuid(), tid = t.Id, uid = user.Id, body = P(p, "message").Trim(), now });
                await uow.ExecuteAsync("UPDATE support_tickets SET acknowledged_at = COALESCE(acknowledged_at, @now), status = @status, assigned_to = COALESCE(assigned_to, @uid), " +
                                       "resolved_at = CASE WHEN @status IN ('resolved','closed') THEN COALESCE(resolved_at, @now) ELSE resolved_at END, updated_at = @now WHERE id = @tid",
                    new { tid = t.Id, status, uid = user.Id, now });
                await uow.CommitAsync();
                await AiShared.NotifyAsync(ai, env, await ai.GetUserAsync(t.UserId), "ticket_reply", new() { ["ticket_number"] = t.Number, ["subject"] = t.Subject },
                    $"/support/{t.Id}", ["inapp", "email"]);
                return J.O(("id", t.Id.ToString()), ("status", status));
            }
            case "moderate_review":
            {
                var r = await dal.ReviewAsync(G("review_id")) ?? throw new NotFoundException("Review");
                var publish = P(p, "decision") == "publish";
                await dal.ExecAsync("UPDATE reviews SET status = @status, report_count = 0 WHERE id = @id", new { id = r.Id, status = publish ? "published" : "hidden" });
                await dal.ExecAsync("UPDATE products SET rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = @pid AND status = 'published'), " +
                                    "rating_avg = COALESCE((SELECT ROUND(AVG(rating), 2) FROM reviews WHERE product_id = @pid AND status = 'published'), 0) WHERE id = @pid", new { pid = r.ProductId });
                await ai.AuditAsync(user.Id, $"review.{P(p, "decision")}", "review", r.Id);
                return J.O(("ok", true), ("status", publish ? "published" : "hidden"));
            }
            case "update_setting":
            {
                var saved = await ai.SettingAsync("marketplace");
                saved[P(p, "key")] = p["value"]?.DeepClone();
                await ai.SaveSettingAsync("marketplace", saved);
                await ai.AuditAsync(user.Id, "settings.update", "settings", "marketplace", J.Cut($"{{'{P(p, "key")}': {J.S(p["value"])}}}", 1000));
                return J.O(("ok", true));
            }
            case "set_announcement":
            {
                var site = await ai.SettingAsync("site");
                var ann = (site["announcement"] as JsonObject)?.DeepClone() as JsonObject ?? (JsonObject)(await AiShared.SiteAsync(ai, env))["announcement"]!.DeepClone();
                var text = P(p, "text");
                ann["enabled"] = text.Length > 0;
                ann["text"] = text.Length > 0 ? text : J.S(ann["text"]);
                ann["link"] = P(p, "link");
                site["announcement"] = ann;
                await ai.SaveSettingAsync("site", site);
                await ai.AuditAsync(user.Id, "storefront.announcement", "settings", "site", "assistant");
                return J.O(("ok", true));
            }
        }
        return J.O(("ok", true));
    }

    private async Task NotifySellerAsync(Guid sellerId, string evt, Dictionary<string, string> vars, string link)
    {
        if (await ai.GetSellerAsync(sellerId) is { } s) await AiShared.NotifyAsync(ai, env, await ai.GetUserAsync(s.UserId), evt, vars, link, ["inapp", "email"]);
    }
}
