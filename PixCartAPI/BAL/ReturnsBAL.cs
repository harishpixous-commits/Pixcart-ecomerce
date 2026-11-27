using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Returns after delivery: request → approve/reject → picked up → received (restock, ledger reversal, credit
/// note) → refunded (reference: services/returns.py plus the returns endpoints of routers/customer.py). Online
/// payments are refunded through the gateway worker afterwards; cash-on-delivery refunds are marked paid by
/// finance against the customer's UPI ID. Fleet return pickups hook in through IDeliveryFleetBAL.
/// </summary>
public partial class ReturnsBAL(
    ReturnsDAL returnsDal,
    OrdersDAL orders,
    CatalogDAL catalog,
    IPlatformSettingsBAL platform,
    IAccessBAL access,
    ICatalogNotifyBAL notify,
    IOrdersBAL ordersBal,
    CatalogSupportDAL support,
    IDeliveryFleetBAL fleetBal,
    IInventoryBAL inventoryBal,
    IRefundQueue refundQueue,
    IMySqlDapperHelper db) : IReturnsBAL
{
    private static readonly string[] Open = ["requested", "approved", "picked_up"];

    [GeneratedRegex(@"^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$")]
    private static partial Regex UpiRegex();

    private static readonly IReadOnlyDictionary<string, string> StatusText = new Dictionary<string, string>
    {
        ["requested"] = "We have sent your return request to the seller.",
        ["approved"] = "Your return is approved. Keep the item packed; the seller will arrange a pickup.",
        ["rejected"] = "The seller could not accept this return.",
        ["picked_up"] = "Your return has been picked up.",
        ["received"] = "The seller received your return. Your refund is on its way.",
        ["refunded"] = "Your refund has been issued.",
        ["cancelled"] = "You cancelled this return request.",
    };

    private static readonly IReadOnlyDictionary<string, string[]> Allowed = new Dictionary<string, string[]>
    {
        ["requested"] = ["approved", "rejected", "cancelled"],
        ["approved"] = ["picked_up", "received", "cancelled"],
        ["picked_up"] = ["received"],
        ["received"] = ["refunded"],
    };

    /// <summary>Returned for a seller's fault: not put back on sale unless the seller says otherwise
    /// (reference: NOT_RESTOCKED_BY_DEFAULT / default_condition).</summary>
    public static string DefaultCondition(string reason) =>
        reason is "damaged" or "defective" or "missing_parts" or "wrong_item" ? "damaged" : "sellable";

    /// <summary>What the customer paid for qty units of this line, after any coupon (reference: paid_value).</summary>
    public static long PaidValue(OrderItemModel it, int qty) =>
        it.Qty > 0 ? (it.LineTotal - it.SellerDiscount - it.PlatformDiscount) * qty / it.Qty : 0;

    /// <summary>The seller's sale value of qty units (excludes platform-funded discount; reference: seller_value).</summary>
    public static long SellerValue(OrderItemModel it, int qty) =>
        it.Qty > 0 ? (it.LineTotal - it.SellerDiscount) * qty / it.Qty : 0;

    // ----------------------------------------------------------------------------- returnable items (reference: returnable_items)

    /// <summary>What can still be returned from a delivered package. Each item can be returned for any reason
    /// within its saved window; after that, damage/defect/wrong/incomplete is still accepted for the
    /// marketplace's defect_return_days (defects_only).</summary>
    public async Task<List<JsonObject>> ReturnableItemsAsync(SubOrderModel sub, IUnitOfWork uow)
    {
        var outList = new List<JsonObject>();
        if (sub.Status != "delivered" || sub.DeliveredAt is null) return outList;
        var cfg = await platform.GetAsync();
        var defectDays = cfg.Long("defect_return_days");
        var defectUntil = sub.DeliveredAt.Value.AddDays(defectDays);
        var items = await orders.ItemsAsync([sub.Id], uow);
        var pending = await returnsDal.PendingQtyByItemAsync(sub.Id, uow);
        var now = DateTimeFunctions.UtcNow();
        foreach (var it in items)
        {
            var until = sub.DeliveredAt.Value.AddDays(it.ReturnWindowDays);
            var anyReason = it.ReturnWindowDays > 0 && now <= until;
            var defectsOnly = !anyReason && defectDays > 0 && now <= defectUntil;
            var left = it.Qty - it.ReturnedQty - (int)pending.GetValueOrDefault(it.Id, 0);
            outList.Add(new JsonObject
            {
                ["order_item_id"] = it.Id.ToString(), ["title"] = it.Title, ["variant_label"] = it.VariantLabel,
                ["image"] = it.ImageUrl,
                ["qty_left"] = Math.Max(0, left),
                ["return_by"] = (defectsOnly ? defectUntil : until).ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["eligible"] = (anyReason || defectsOnly) && left > 0,
                ["defects_only"] = defectsOnly,
                ["unit_refund"] = PaidValue(it, 1),
            });
        }
        return outList;
    }

    // ----------------------------------------------------------------------------- create (reference: returns.create)

    /// <summary>The customer's return request (reference: POST /api/returns). Auto-approves when the marketplace
    /// setting says so, which also asks the fleet to collect.</summary>
    public async Task<ReturnRequestModel> CreateAsync(UserModel user, Guid subOrderId, IReadOnlyList<(Guid OrderItemId, int Qty)> lines,
        string reason, string comment, string refundUpi)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_returns"))
            throw new AppException("Returns are not available right now", "returns_off");
        await using var uow = await db.BeginAsync();
        var sub = await orders.SubForUpdateAsync(subOrderId, uow);
        var order = sub is null ? null : await orders.GetOrderAsync(sub.OrderId);
        if (sub is null || order is null || order.UserId != user.Id)
            throw new NotFoundException("Order");
        var reasonLabels = await ReturnReasonsConfig.Async(db);
        if (!reasonLabels.ContainsKey(reason))
            throw new AppException("Choose a reason for the return", "invalid_reason");
        var eligible = (await ReturnableItemsAsync(sub, uow)).ToDictionary(e => e["order_item_id"]!.GetValue<string>());
        if (lines.Count == 0)
            throw new AppException("Choose at least one item to return", "no_items");
        // One line per item: an item named twice counts once, with its quantities added up.
        var wanted = new Dictionary<Guid, int>();
        foreach (var (itemId, qty) in lines)
        {
            if (!eligible.TryGetValue(itemId.ToString(), out var e) || !e["eligible"]!.GetValue<bool>())
                throw new AppException("One of the items can no longer be returned", "not_returnable");
            if (e["defects_only"]!.GetValue<bool>() && !PlatformSettingsBAL.DefectReasons.Contains(reason))
                throw new AppException(
                    $"'{e["title"]!.GetValue<string>()}' can now be returned only if it arrived damaged, faulty, wrong or with parts missing. " +
                    "Choose that reason, or leave this item out.", "reason_not_allowed");
            if (qty < 1)
                throw new AppException($"Choose how many of '{e["title"]!.GetValue<string>()}' to return", "invalid_qty");
            wanted[itemId] = wanted.GetValueOrDefault(itemId, 0) + qty;
        }
        foreach (var (itemId, qty) in wanted)
        {
            var e = eligible[itemId.ToString()];
            if (qty > e["qty_left"]!.GetValue<int>())
                throw new AppException($"You can return at most {e["qty_left"]!.GetValue<int>()} of '{e["title"]!.GetValue<string>()}'", "invalid_qty");
        }
        if (order.PaymentMethod == "cod" && !UpiRegex().IsMatch(refundUpi))
            throw new AppException("Enter the UPI ID where we should send your refund (for example name@okbank)",
                "upi_required", 400, new Dictionary<string, string> { ["refund_upi"] = "Required" });
        var now = DateTimeFunctions.UtcNow();
        var ret = new ReturnRequestModel
        {
            Id = Guid.NewGuid(),
            Number = $"RT{now:yyMMdd}{Convert.ToHexString(RandomNumberGenerator.GetBytes(3))}",
            SubOrderId = sub.Id, SellerId = sub.SellerId, UserId = user.Id, Status = "requested",
            Reason = reason, Comment = comment.Length > 2000 ? comment[..2000] : comment,
            RefundUpi = order.PaymentMethod == "cod" ? refundUpi : "",
            CreatedAt = now, UpdatedAt = now,
        };
        await returnsDal.InsertReturnAsync(ret, uow);
        long total = 0;
        var items = (await returnsDal.OrderItemsByIdsAsync(wanted.Keys.ToList(), uow)).ToDictionary(i => i.Id);
        foreach (var (itemId, qty) in wanted)
        {
            var it = items[itemId];
            var amount = PaidValue(it, qty);
            total += amount;
            await returnsDal.InsertReturnItemAsync(new ReturnItemModel
            {
                Id = Guid.NewGuid(), ReturnId = ret.Id, OrderItemId = it.Id, Qty = qty, Amount = amount, Condition = "",
            }, uow);
        }
        ret.RefundAmount = total;
        await returnsDal.UpdateReturnAsync(ret, uow);
        await notify.NotifySellerAsync(sub.SellerId, "seller_return_requested",
            new Dictionary<string, string>
            {
                ["order_number"] = sub.Number, ["reason"] = reasonLabels[reason],
            }, "/seller/returns");
        List<Guid> refundIds = [];
        if (cfg.Bool("auto_approve_returns"))
            refundIds = await SetStatusAsync(ret, "approved", uow, note: "Approved automatically");
        else
            await TellCustomerAsync(ret, "", uow);
        await uow.CommitAsync();
        refundQueue.Enqueue(refundIds);
        return ret;
    }

    // ----------------------------------------------------------------------------- status moves (reference: set_status)

    /// <summary>Moves a return forward; returns refund ids to send to the gateway after commit.</summary>
    public async Task<List<Guid>> SetStatusAsync(ReturnRequestModel ret, string dst, IUnitOfWork uow, string note = "",
        string courier = "", string tracking = "", bool byFleet = false, IReadOnlyDictionary<Guid, string>? conditions = null,
        UserModel? actor = null)
    {
        if (!(Allowed.TryGetValue(ret.Status, out var next) && next.Contains(dst)))
            throw new AppException(
                $"A {ret.Status.Replace('_', ' ')} return cannot become {dst.Replace('_', ' ')}", "illegal_transition", 409);
        var now = DateTimeFunctions.UtcNow();
        var refundIds = new List<Guid>();
        var extra = dst == "rejected" ? note : "";
        ret.Status = dst;
        if (note.Length > 0) ret.SellerNote = note[..Math.Min(2000, note.Length)];
        switch (dst)
        {
            case "approved":
                ret.ApprovedAt = now;
                await returnsDal.UpdateReturnAsync(ret, uow);
                await fleetBal.RequestReturnPickupAsync(ret, uow);
                if (ret.FleetRequestedAt is not null)
                    extra = $"Our delivery partner will collect it. Give pickup code {ret.PickupOtp} when you hand it over.";
                break;
            case "picked_up":
                ret.PickupCourier = courier[..Math.Min(60, courier.Length)];
                ret.PickupTracking = tracking[..Math.Min(60, tracking.Length)];
                if (ret.FleetRequestedAt is not null && !byFleet)
                    await fleetBal.CancelReturnPickupAsync(ret, "The seller arranged another pickup", uow);
                break;
            case "received":
                ret.ReceivedAt = now;
                refundIds = await ReceiveAsync(ret, conditions ?? new Dictionary<Guid, string>(), uow);
                await fleetBal.ClosePickupOnReceiveAsync(ret, uow, actor);
                break;
            case "refunded":
                ret.RefundedAt = now;
                break;
            case "cancelled":
                if (ret.FleetRequestedAt is not null)
                    await fleetBal.CancelReturnPickupAsync(ret, "The customer cancelled the return", uow, actor);
                break;
        }
        await returnsDal.UpdateReturnAsync(ret, uow);
        await TellCustomerAsync(ret, extra, uow);
        return refundIds;
    }

    /// <summary>Receipt: returned quantities, restock of sellable units, the ledger reversal, the credit note and
    /// the refund row (reference: _receive).</summary>
    private async Task<List<Guid>> ReceiveAsync(ReturnRequestModel ret, IReadOnlyDictionary<Guid, string> conditions, IUnitOfWork uow)
    {
        var sub = await orders.SubForUpdateAsync(ret.SubOrderId, uow) ?? throw new NotFoundException("Order");
        var order = await orders.OrderForUpdateAsync(sub.OrderId, uow) ?? throw new NotFoundException("Order");
        var seller = await catalog.GetSellerAsync(sub.SellerId);
        var rows = await returnsDal.ItemsForReturnAsync(ret.Id, uow);
        var items = (await returnsDal.OrderItemsByIdsAsync(rows.Select(r => r.OrderItemId).ToList(), uow)).ToDictionary(i => i.Id);
        long sValue = 0;
        foreach (var ri in rows)
        {
            var it = items[ri.OrderItemId];
            await returnsDal.BumpItemReturnedQtyAsync(it.Id, ri.Qty, uow);
            sValue += SellerValue(it, ri.Qty);
            var condition = conditions.TryGetValue(it.Id, out var c) && c is "sellable" or "damaged" ? c : DefaultCondition(ret.Reason);
            await returnsDal.SetReturnItemConditionAsync(ri.Id, condition, uow);
            if (condition != "sellable")
                continue; // recorded on the return; the customer is refunded all the same
            if (sub.WarehouseId is not null)
            {
                var variant = await catalog.GetVariantAsync(it.VariantId);
                if (variant is not null)
                    await inventoryBal.ChangeAsync(variant, sub.WarehouseId.Value, ri.Qty, "return", reference: ret.Number, uow: uow);
            }
        }
        await returnsDal.BumpSubReturnedTotalAsync(sub.Id, ret.RefundAmount, uow);
        await LoyaltyPoints.ReverseForReturnAsync(uow, sub.Id, sub.Number, sub.ItemsTotal, sub.ReturnedTotal + ret.RefundAmount, order.UserId); // takes back the matching share of earned points
        await PostReturnAsync(sub, ret, rows, items, sValue, uow);
        var now = DateTimeFunctions.UtcNow();
        if (seller is not null)
            ret.CreditNoteNumber = await NextNumberAsync(seller, "CN", now, uow);
        var refundIds = new List<Guid>();
        if (order.PaymentMethod == "online")
        {
            var payment = await orders.CapturedPaymentAsync(order.Id);
            if (payment is not null)
            {
                var refund = new RefundModel
                {
                    Id = Guid.NewGuid(), OrderId = order.Id, PaymentId = payment.Id, SubOrderId = sub.Id,
                    AmountPaise = ret.RefundAmount, Status = "pending", Reason = $"Return {ret.Number}",
                    CreatedAt = now, UpdatedAt = now,
                };
                await orders.InsertRefundAsync(refund, uow);
                refundIds.Add(refund.Id);
                ret.Status = "refunded";
                ret.RefundedAt = now;
            }
        }
        var refundedTotal = order.RefundedTotal + ret.RefundAmount;
        await returnsDal.BumpOrderRefundedAsync(order.Id, ret.RefundAmount,
            refundedTotal >= order.GrandTotal ? "refunded" : "partially_refunded", uow);
        return refundIds;
    }

    /// <summary>Reverses, for a refunded return, the returned lines' sale value and exactly the deductions charged
    /// on them (reference: ledger.post_return).</summary>
    private async Task PostReturnAsync(SubOrderModel sub, ReturnRequestModel ret, IReadOnlyList<ReturnItemModel> rows,
        IReadOnlyDictionary<Guid, OrderItemModel> items, long sellerValue, IUnitOfWork uow)
    {
        if (sub.Total <= 0 || sellerValue <= 0) return;
        long commission = 0, taxable = 0;
        foreach (var ri in rows)
        {
            var it = items[ri.OrderItemId];
            if (it.Qty <= 0) continue;
            commission += it.CommissionPaise * ri.Qty / it.Qty;
            taxable += it.TaxableValue * ri.Qty / it.Qty;
        }
        var now = DateTimeFunctions.UtcNow();
        var entries = new (string Kind, long Amount)[]
        {
            ("return", -sellerValue),
            ("commission_reversal", commission),
            ("commission_gst_reversal", sub.CommissionPaise > 0
                ? (long)Math.Round((double)sub.CommissionGstPaise * commission / sub.CommissionPaise) : 0),
            ("tcs_reversal", sub.TaxableTotal > 0
                ? (long)Math.Round((double)sub.TcsPaise * taxable / sub.TaxableTotal) : 0),
            ("tds_reversal", (long)Math.Round((double)sub.TdsPaise * sellerValue / sub.Total)),
        };
        foreach (var (kind, amount) in entries)
            if (amount != 0)
                await orders.InsertLedgerAsync(sub.SellerId, sub.Id, kind, amount, $"Return {ret.Number}", now, uow, returnId: ret.Id);
    }

    /// <summary>The next credit-note number for the seller (reference: invoices.next_number with doc_type CN).</summary>
    private async Task<string> NextNumberAsync(SellerModel seller, string docType, DateTime now, IUnitOfWork uow)
    {
        var fy = FiscalYear(now);
        var n = await orders.DocCounterForUpdateAsync(seller.Id, docType, fy, uow);
        if (n is null) { await orders.InsertDocCounterAsync(seller.Id, docType, fy, uow); n = 1; }
        else { await orders.BumpDocCounterAsync(seller.Id, docType, fy, uow); n += 1; }
        var prefix = seller.InvoicePrefix.Length > 0 ? seller.InvoicePrefix : DefaultPrefix(seller.DisplayName);
        if (prefix.Length > 4) prefix = prefix[..4];
        if (docType == "CN") prefix = $"{prefix[..Math.Min(2, prefix.Length)]}CN";
        var number = $"{prefix}/{fy}/{n.Value:D6}";
        return number.Length > 16 ? number[..16] : number;
    }

    private static string FiscalYear(DateTime utc)
    {
        var d = utc.AddMinutes(330); // IST
        var start = d.Month >= 4 ? d.Year : d.Year - 1;
        return $"{start % 100:00}-{(start + 1) % 100:00}";
    }

    private static string DefaultPrefix(string displayName)
    {
        var letters = new string(displayName.ToUpperInvariant().Where(c => c is >= 'A' and <= 'Z').ToArray());
        var p = letters.Length >= 3 ? letters[..3] : letters.Length > 0 ? letters.PadRight(3, 'X') : "INV";
        return p;
    }

    private async Task TellCustomerAsync(ReturnRequestModel ret, string extra, IUnitOfWork uow)
    {
        var sub = await orders.GetSubAsync(ret.SubOrderId);
        if (sub is null) return;
        var message = (StatusText.GetValueOrDefault(ret.Status, "") + (extra.Length > 0 ? " " + extra : "")).Trim();
        await notify.NotifyUserAsync(ret.UserId, "return_update", new Dictionary<string, string>
        {
            ["return_number"] = ret.Number, ["status"] = ret.Status.Replace('_', ' '), ["message"] = message,
        }, $"/orders/{sub.OrderId}");
    }

    // ----------------------------------------------------------------------------- seller flows (reference: seller_extras returns)

    /// <summary>The seller's returns page (reference: GET /api/seller/returns).</summary>
    public async Task<JsonObject> SellerListAsync(UserModel user, string? status, int page)
    {
        var seller = await ordersBal.RequireSellerAsync(user, true);
        await using var uow = await db.BeginAsync();
        var rows = await returnsDal.SellerReturnsAsync(seller.Id, status, (page - 1) * 20, uow);
        var counts = await returnsDal.StatusCountsAsync(seller.Id, uow);
        var items = new List<JsonObject>();
        foreach (var r in rows)
            items.Add(await ReturnOutAsync(r, "seller", uow));
        await uow.CommitAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode?)i).ToArray()),
            ["status_counts"] = new JsonObject(counts.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
            ["page"] = page,
        };
    }

    /// <summary>The seller decides on a return: approve, reject (with a note), picked_up (own courier) or received
    /// with per-item conditions (reference: POST /api/seller/returns/{return_id}).</summary>
    public async Task<JsonObject> SellerActAsync(UserModel user, Guid returnId, string action, string note,
        string courier, string tracking, IReadOnlyDictionary<Guid, string> conditions)
    {
        if (action is not ("approve" or "reject" or "picked_up" or "received"))
            throw new AppException("action must be one of approve, reject, picked_up, received", "validation", 422);
        if (note.Length > 2000 || courier.Length > 60 || tracking.Length > 60)
            throw new AppException("note must be at most 2000 characters, courier and tracking at most 60", "validation", 422);
        var seller = await ordersBal.RequireSellerAsync(user, true);
        await using var uow = await db.BeginAsync();
        var ret = await returnsDal.ReturnForUpdateAsync(returnId, uow);
        if (ret is null || ret.SellerId != seller.Id) throw new NotFoundException("Return");
        if (action == "reject" && note.Trim().Length < 10)
            throw new AppException("Explain to the customer why the return cannot be accepted", "note_required",
                400, new Dictionary<string, string> { ["note"] = "Required" });
        var dst = action switch { "approve" => "approved", "reject" => "rejected", "picked_up" => "picked_up", _ => "received" };
        var refundIds = await SetStatusAsync(ret, dst, uow, note: note, courier: courier, tracking: tracking,
            conditions: conditions, actor: user);
        var damaged = conditions.Values.Count(c => c == "damaged");
        await AuditAsync(uow, user, $"return.{dst}", ret.Id,
            (note[..Math.Min(150, note.Length)] + (damaged > 0 ? $" ({damaged} item(s) kept out of stock)" : "")).Trim());
        var outObj = await ReturnOutAsync(ret, "seller", uow);
        await uow.CommitAsync();
        refundQueue.Enqueue(refundIds);
        return outObj;
    }

    // ----------------------------------------------------------------------------- staff flows (reference: admin_extras returns)

    /// <summary>Staff returns search (reference: GET /api/admin/returns).</summary>
    public async Task<JsonObject> AdminListAsync(UserModel admin, string? status, string q, Guid? sellerId, int page)
    {
        await access.RequireAsync(admin, "orders");
        var like = q.Trim().Length > 0 ? $"%{q.Trim()}%" : "";
        await using var uow = await db.BeginAsync();
        var rows = await returnsDal.AdminReturnsAsync(status, like, sellerId, (page - 1) * 30, uow);
        var total = await returnsDal.AdminCountAsync(status, like, sellerId, uow);
        var counts = await returnsDal.StatusCountsAsync(null, uow);
        var items = new List<JsonObject>();
        foreach (var r in rows)
            items.Add(await ReturnOutAsync(r, "admin", uow, withUpi: true));
        await uow.CommitAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode?)i).ToArray()),
            ["status_counts"] = new JsonObject(counts.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 30,
        };
    }

    /// <summary>What can still be returned from an order, by the customer's own rules
    /// (reference: GET /api/admin/orders/{order_id}/returnable).</summary>
    public async Task<JsonObject> AdminReturnableAsync(UserModel admin, Guid orderId)
    {
        await access.RequireAsync(admin, "orders");
        var order = await orders.GetOrderAsync(orderId) ?? throw new NotFoundException("Order");
        await using var uow = await db.BeginAsync();
        var subs = await orders.SubOrdersForUpdateAsync(orderId, uow);
        var items = new JsonObject();
        foreach (var s in subs)
            items[s.Id.ToString()] = new JsonArray((await ReturnableItemsAsync(s, uow)).Select(r => (JsonNode?)r).ToArray());
        await uow.CommitAsync();
        return new JsonObject { ["items"] = items, ["needs_upi"] = order.PaymentMethod == "cod" };
    }

    /// <summary>Staff open a return for the customer, with the customer's own checks
    /// (reference: POST /api/admin/returns).</summary>
    public async Task<JsonObject> AdminCreateAsync(UserModel admin, Guid subOrderId,
        IReadOnlyList<(Guid OrderItemId, int Qty)> lines, string reason, string comment, string refundUpi)
    {
        await access.RequireAsync(admin, "orders");
        var order = await returnsDal.OrderForSubAsync(subOrderId) ?? throw new NotFoundException("Order");
        var customer = await support.GetUserAsync(order.UserId) ?? throw new NotFoundException("Order");
        var ret = await CreateAsync(customer, subOrderId, lines, reason, comment, refundUpi);
        await using var uow = await db.BeginAsync();
        await AuditAsync(uow, admin, "return.admin_open", ret.Id, $"{ret.Number} on order {order.Number}, reason {reason}");
        await uow.CommitAsync();
        return await ReturnOutAsync(ret, "admin", withUpi: true);
    }

    /// <summary>Staff act on a return, including marking a COD refund paid with its UPI/bank reference
    /// (reference: POST /api/admin/returns/{return_id}).</summary>
    public async Task<JsonObject> AdminActAsync(UserModel admin, Guid returnId, string action, string note, string reference)
    {
        await access.RequireAsync(admin, "refunds");
        if (action is not ("approve" or "reject" or "received" or "mark_refunded"))
            throw new AppException("action must be one of approve, reject, received, mark_refunded", "validation", 422);
        if (note.Length > 2000 || reference.Length > 60)
            throw new AppException("note must be at most 2000 characters, reference at most 60", "validation", 422);
        await using var uow = await db.BeginAsync();
        var ret = await returnsDal.ReturnForUpdateAsync(returnId, uow) ?? throw new NotFoundException("Return");
        List<Guid> refundIds;
        if (action == "mark_refunded")
        {
            if (reference.Trim().Length == 0)
                throw new AppException("Enter the UPI/bank reference of the refund you paid", "reference_required");
            refundIds = await SetStatusAsync(ret, "refunded", uow, note: $"Refund reference {reference.Trim()}", actor: admin);
        }
        else
        {
            var dst = action switch { "approve" => "approved", "reject" => "rejected", _ => "received" };
            refundIds = await SetStatusAsync(ret, dst, uow, note: note, actor: admin);
        }
        await AuditAsync(uow, admin, $"return.admin_{action}", ret.Id, note.Length > 0 ? note : reference);
        var outObj = await ReturnOutAsync(ret, "admin", uow, withUpi: true);
        await uow.CommitAsync();
        refundQueue.Enqueue(refundIds);
        return outObj;
    }

    private static async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, Guid returnId, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'return', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, eid = returnId.ToString(), detail, id = Guid.NewGuid() });

    // ----------------------------------------------------------------------------- customer flows

    /// <summary>The shopper's returnable items and existing returns for one order
    /// (reference: GET /api/orders/{order_id}/returnable).</summary>
    public async Task<JsonObject> ReturnableAsync(UserModel user, Guid orderId)
    {
        await using var uow = await db.BeginAsync();
        var order = await orders.GetOrderAsync(orderId);
        if (order is null || order.UserId != user.Id) throw new NotFoundException("Order");
        var subs = await orders.SubOrdersForUpdateAsync(orderId, uow);
        var items = new JsonObject();
        foreach (var s in subs)
        {
            var rows = await ReturnableItemsAsync(s, uow);
            items[s.Id.ToString()] = new JsonArray(rows.Select(r => (JsonNode?)r).ToArray());
        }
        var rets = await returnsDal.ReturnsForOrderAsync(orderId, uow);
        var outRets = new List<JsonObject>();
        foreach (var r in rets)
            outRets.Add(await ReturnOutAsync(r, viewer: "customer", uow));
        await uow.CommitAsync();
        return new JsonObject
        {
            ["items"] = items,
            ["returns"] = new JsonArray(outRets.Select(r => (JsonNode?)r).ToArray()),
            ["needs_upi"] = order.PaymentMethod == "cod",
        };
    }

    /// <summary>The customer cancels their own return (reference: POST /api/returns/{id}/cancel).</summary>
    public async Task<JsonObject> CancelAsync(UserModel user, Guid returnId)
    {
        await using var uow = await db.BeginAsync();
        var ret = await returnsDal.ReturnForUpdateAsync(returnId, uow);
        if (ret is null || ret.UserId != user.Id) throw new NotFoundException("Return");
        await SetStatusAsync(ret, "cancelled", uow);
        var outObj = await ReturnOutAsync(ret, viewer: "customer", uow);
        await uow.CommitAsync();
        return outObj;
    }

    // ----------------------------------------------------------------------------- output (reference: return_out)

    /// <summary>A return for the customer, the seller or staff; each sees only the pickup code meant for them
    /// (reference: return_out).</summary>
    public async Task<JsonObject> ReturnOutAsync(ReturnRequestModel ret, string viewer = "customer", IUnitOfWork? uow = null,
        bool withUpi = false)
    {
        var own = uow is null;
        uow ??= await db.BeginAsync();
        try
        {
            var rows = await returnsDal.ItemsForReturnAsync(ret.Id, uow);
            var items = (await returnsDal.OrderItemsByIdsAsync(rows.Select(r => r.OrderItemId).ToList(), uow)).ToDictionary(i => i.Id);
            var sub = await orders.GetSubAsync(ret.SubOrderId);
            return new JsonObject
            {
                ["fleet_pickup"] = await fleetBal.PickupTrackingAsync(ret, viewer, uow) is { } t ? (JsonNode)t : null,
                ["id"] = ret.Id.ToString(), ["number"] = ret.Number, ["status"] = ret.Status,
                ["reason"] = ret.Reason,
                ["reason_label"] = (await ReturnReasonsConfig.Async(db, false)).GetValueOrDefault(ret.Reason, ret.Reason),
                ["comment"] = ret.Comment, ["seller_note"] = ret.SellerNote, ["refund_amount"] = ret.RefundAmount,
                ["refund_upi"] = withUpi ? ret.RefundUpi : MaskUpi(ret.RefundUpi),
                ["pickup_courier"] = ret.PickupCourier, ["pickup_tracking"] = ret.PickupTracking,
                ["credit_note_number"] = ret.CreditNoteNumber,
                ["sub_order_id"] = ret.SubOrderId.ToString(),
                ["sub_order_number"] = sub?.Number ?? "",
                ["order_id"] = sub?.OrderId.ToString() ?? "",
                ["created_at"] = ret.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["approved_at"] = ret.ApprovedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["received_at"] = ret.ReceivedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["refunded_at"] = ret.RefundedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["items"] = new JsonArray(rows.Select(ri =>
                {
                    var it = items[ri.OrderItemId];
                    return (JsonNode?)new JsonObject
                    {
                        ["order_item_id"] = it.Id.ToString(), ["title"] = it.Title, ["variant_label"] = it.VariantLabel,
                        ["image"] = it.ImageUrl, ["qty"] = ri.Qty, ["amount"] = ri.Amount,
                        ["condition"] = ri.Condition, ["suggested_condition"] = DefaultCondition(ret.Reason),
                    };
                }).ToArray()),
            };
        }
        finally
        {
            if (own) await uow.DisposeAsync();
        }
    }

    private static string MaskUpi(string upi) =>
        upi.Length == 0 ? "" : $"{upi[..Math.Min(2, upi.Length)]}…@{upi.Split('@').Last()}";
}
