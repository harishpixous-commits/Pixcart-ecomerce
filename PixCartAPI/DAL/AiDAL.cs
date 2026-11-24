using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>
/// AI studio data: the AI run log (ai_runs), the facts each task reads (products, tickets, orders, reviews, KPIs), the
/// deterministic risk briefs, and the shared pieces the AI module needs from other areas until those modules are
/// merged (audit log, rate limits, in-app notifications, settings rows, storefront site). Queries match the reference.
/// </summary>
public class AiDAL(IMySqlDapperHelper db, SettingsDAL settings)
{
    public static long N(object? v) => v switch { null or DBNull => 0, _ => Convert.ToInt64(v) };

    public static double? D(object? v) => v switch { null or DBNull => null, _ => Convert.ToDouble(v) };

    private static IDictionary<string, object?> Row(object? r) => (IDictionary<string, object?>?)r ?? new Dictionary<string, object?>();

    // ---------------------------------------------------------------- settings rows, audit, rate limits

    public Task<JsonObject> SettingAsync(string key) => settings.GetAsync(key);

    public Task SaveSettingAsync(string key, JsonNode value) => settings.SaveAsync(key, value);

    public Task<bool> SettingExistsAsync(string key) => settings.ExistsAsync(key);

    /// <summary>The setting row locked for a read-modify-write (SELECT ... FOR UPDATE), or null when there is none.</summary>
    public async Task<JsonObject?> LockSettingAsync(IUnitOfWork uow, string key)
    {
        var json = await uow.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = @key FOR UPDATE", new { key });
        return json is null ? null : JsonHelper.Object(json);
    }

    public Task SaveSettingAsync(IUnitOfWork uow, string key, JsonNode value) =>
        uow.ExecuteAsync(
            "INSERT INTO platform_settings (`key`, `value`, updated_at) VALUES (@key, CAST(@value AS JSON), UTC_TIMESTAMP(6)) " +
            "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)", new { key, value = value.ToJsonString() });

    public Task<IUnitOfWork> BeginAsync() => db.BeginAsync();

    public Task AuditAsync(Guid? actor, string action, string entityType, object entityId, string detail = "", IUnitOfWork? uow = null)
    {
        var p = new
        {
            id = Guid.NewGuid(), actor, action, entityType, entityId = J64(Convert.ToString(entityId) ?? ""),
            detail = detail.Length > 2000 ? detail[..2000] : detail, now = DateTimeFunctions.UtcNow(),
        };
        const string sql = "INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, detail, created_at) " +
                           "VALUES (@id, @actor, @action, @entityType, @entityId, @detail, @now)";
        return uow != null ? uow.ExecuteAsync(sql, p) : db.ExecuteAsync(sql, p);
    }

    private static string J64(string s) => s.Length > 64 ? s[..64] : s;

    /// <summary>Fixed-window limiter in the database (works across servers): throws 429 when the key is used up.</summary>
    public async Task RateLimitAsync(string key, int limit, int windowSeconds)
    {
        var now = DateTimeFunctions.UtcNow();
        var count = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM rate_limit_events WHERE `key` = @key AND created_at >= @since",
            new { key, since = now.AddSeconds(-windowSeconds) });
        if (count >= limit) throw new TooManyRequestsException();
        await db.ExecuteAsync("INSERT INTO rate_limit_events (`key`, created_at) VALUES (@key, @now)", new { key, now });
    }

    public Task<UserModel?> GetUserAsync(Guid id) => db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id });

    public Task<NotificationTemplateModel?> TemplateAsync(string evt, string channel) =>
        db.QueryFirstOrDefaultAsync<NotificationTemplateModel>("SELECT * FROM notification_templates WHERE event = @evt AND channel = @channel", new { evt, channel });

    public Task InsertNotificationAsync(NotificationModel n, IUnitOfWork? uow = null)
    {
        const string sql = "INSERT INTO notifications (id, user_id, event, channel, recipient, subject, body, link, variables, status, attempts, error, created_at, sent_at) " +
                           "VALUES (@Id, @UserId, @Event, @Channel, @Recipient, @Subject, @Body, @Link, CAST(@Variables AS JSON), @Status, 0, '', @CreatedAt, @SentAt)";
        return uow != null ? uow.ExecuteAsync(sql, n) : db.ExecuteAsync(sql, n);
    }

    public Task<CategoryModel?> GetCategoryAsync(Guid id) => db.QueryFirstOrDefaultAsync<CategoryModel>("SELECT * FROM categories WHERE id = @id", new { id });

    // ---------------------------------------------------------------- AI runs

    public Task InsertRunAsync(AiRunModel r) =>
        db.ExecuteAsync(
            "INSERT INTO ai_runs (id, task, subject_type, subject_id, seller_id, inputs, output, final_text, status, mode, model, input_tokens, output_tokens, " +
            "cache_creation_tokens, cache_read_tokens, latency_ms, error, created_by, reviewed_by, created_at, reviewed_at) VALUES (@Id, @Task, @SubjectType, @SubjectId, " +
            "@SellerId, CAST(@Inputs AS JSON), CAST(@Output AS JSON), @FinalText, @Status, @Mode, @Model, @InputTokens, @OutputTokens, @CacheCreationTokens, " +
            "@CacheReadTokens, @LatencyMs, @Error, @CreatedBy, @ReviewedBy, @CreatedAt, @ReviewedAt)", r);

    public Task<AiRunModel?> GetRunAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<AiRunModel>("SELECT * FROM ai_runs WHERE id = @id", new { id });

    /// <summary>Records what a person did with a draft, only while it is still a draft. False when it was not.</summary>
    public async Task<bool> FinishRunAsync(Guid id, string status, string finalText, Guid reviewedBy, Guid? sellerId)
    {
        var n = await db.ExecuteAsync(
            "UPDATE ai_runs SET status = @status, final_text = @finalText, reviewed_by = @reviewedBy, reviewed_at = @now " +
            "WHERE id = @id AND status = 'draft'" + (sellerId.HasValue ? " AND seller_id = @sellerId" : ""),
            new { id, status, finalText, reviewedBy, sellerId, now = DateTimeFunctions.UtcNow() });
        return n > 0;
    }

    public Task SetRunAppliedAsync(Guid id, string finalText) =>
        db.ExecuteAsync("UPDATE ai_runs SET status = 'applied', final_text = @finalText WHERE id = @id", new { id, finalText });

    public sealed class RunRow : AiRunModel
    {
        public string? ByName { get; set; }
    }

    public async Task<(long Total, List<RunRow> Rows)> ListRunsAsync(string? task, string? status, int page, int size)
    {
        var where = new List<string>();
        if (!string.IsNullOrEmpty(task)) where.Add("r.task = @task");
        if (!string.IsNullOrEmpty(status)) where.Add("r.status = @status");
        var w = where.Count > 0 ? "WHERE " + string.Join(" AND ", where) : "";
        var p = new { task, status, take = size, skip = (page - 1) * size };
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM ai_runs r {w}", p);
        var rows = await db.QueryAsync<RunRow>(
            $"SELECT r.*, u.name AS by_name FROM ai_runs r LEFT JOIN users u ON u.id = r.created_by {w} " +
            "ORDER BY r.created_at DESC LIMIT @take OFFSET @skip", p);
        return (total, rows.ToList());
    }

    public async Task<Dictionary<string, long>> RunCountsByTaskAsync(DateTime since, bool usedOnly)
    {
        var rows = await db.QueryAsync<object>(
            "SELECT task, COUNT(*) AS n FROM ai_runs WHERE created_at >= @since" + (usedOnly ? " AND status IN ('applied','sent')" : "") + " GROUP BY task", new { since });
        return rows.Select(Row).ToDictionary(r => (string)r["task"]!, r => N(r["n"]));
    }

    /// <summary>Live runs since a moment: runs, input (incl. cache write and read), output and cache-read tokens.</summary>
    public async Task<(long Runs, long Input, long Output, long CacheRead)> UsageSinceAsync(DateTime since)
    {
        var r = Row(await db.QueryFirstOrDefaultAsync<object>(
            "SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS input, " +
            "COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cache_read_tokens), 0) AS cache_read FROM ai_runs WHERE created_at >= @since AND mode = 'live'",
            new { since }));
        return (N(r["runs"]), N(r["input"]), N(r["output"]), N(r["cache_read"]));
    }

    public Task<long> TaskTokensSinceAsync(string task, DateTime since) =>
        db.ExecuteScalarAsync<long>("SELECT CAST(COALESCE(SUM(input_tokens + output_tokens), 0) AS SIGNED) FROM ai_runs WHERE task = @task AND created_at >= @since",
            new { task, since });

    // ---------------------------------------------------------------- subjects (only the facts a task needs)

    public Task<ProductModel?> GetProductAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id });

    public Task<IEnumerable<VariantModel>> VariantsAsync(Guid productId) =>
        db.QueryAsync<VariantModel>("SELECT * FROM variants WHERE product_id = @productId ORDER BY created_at, sku", new { productId });

    public async Task<List<(int Rating, string Body)>> PublishedReviewsAsync(Guid productId, int limit, bool withBody = false)
    {
        var rows = await db.QueryAsync<ReviewModel>(
            "SELECT rating, body FROM reviews WHERE product_id = @productId AND status = 'published'" + (withBody ? " AND body <> ''" : "") +
            " ORDER BY created_at DESC LIMIT @limit", new { productId, limit });
        return rows.Select(r => (r.Rating, r.Body)).ToList();
    }

    public Task<SupportTicketModel?> GetTicketAsync(Guid id) => db.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE id = @id", new { id });

    public Task<IEnumerable<TicketMessageModel>> PublicTicketMessagesAsync(Guid ticketId) =>
        db.QueryAsync<TicketMessageModel>("SELECT * FROM ticket_messages WHERE ticket_id = @ticketId AND is_internal = 0 ORDER BY created_at", new { ticketId });

    public Task<OrderModel?> GetOrderAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id = @id", new { id });

    public sealed class SubWithSeller
    {
        public string Number { get; set; } = "";
        public string Status { get; set; } = "";
        public string TrackingNumber { get; set; } = "";
        public string SellerName { get; set; } = "";
    }

    public async Task<List<SubWithSeller>> OrderPackagesAsync(Guid orderId) =>
        (await db.QueryAsync<SubWithSeller>(
            "SELECT s.number, s.status, s.tracking_number, se.display_name AS seller_name FROM sub_orders s JOIN sellers se ON se.id = s.seller_id " +
            "WHERE s.order_id = @orderId", new { orderId })).ToList();

    public Task<ReviewModel?> GetReviewAsync(Guid id) => db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @id", new { id });

    public Task<SellerModel?> GetSellerAsync(Guid id) => db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id });

    /// <summary>The dashboard figures the business brief uses (reference analytics.kpis for the whole marketplace).</summary>
    public async Task<Dictionary<string, object?>> KpisAsync(DateTime start, DateTime end, DateTime prevStart, DateOnly startDay, DateOnly endDay)
    {
        const string period = "SELECT COUNT(DISTINCT order_id) AS orders, COUNT(id) AS packages, " +
                              "COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total ELSE 0 END), 0) AS gmv, " +
                              "COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled, " +
                              "COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN commission_paise ELSE 0 END), 0) AS commission, " +
                              "COALESCE(SUM(returned_total), 0) AS returned, " +
                              "COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN platform_discount + seller_discount ELSE 0 END), 0) AS discounts " +
                              "FROM sub_orders WHERE status <> 'pending_payment' AND created_at >= @a AND created_at < @b";
        var cur = Row(await db.QueryFirstOrDefaultAsync<object>(period, new { a = start, b = end }));
        var prev = Row(await db.QueryFirstOrDefaultAsync<object>(period, new { a = prevStart, b = start }));
        var p = new { start, end, sd = startDay.ToDateTime(TimeOnly.MinValue), ed = endDay.ToDateTime(TimeOnly.MinValue) };
        var returns = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM return_requests WHERE created_at >= @start AND created_at < @end", p);
        var delivered = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders WHERE status <> 'pending_payment' AND status = 'delivered' AND delivered_at >= @start AND delivered_at < @end", p);
        var shipHours = D(await db.ExecuteScalarAsync<object>(
            "SELECT AVG(TIMESTAMPDIFF(MICROSECOND, created_at, shipped_at) / 3600000000) FROM sub_orders WHERE status <> 'pending_payment' AND shipped_at >= @start AND shipped_at < @end", p));
        var views = N(await db.ExecuteScalarAsync<object>("SELECT COALESCE(SUM(views), 0) FROM product_daily_stats WHERE day >= @sd AND day <= @ed", p));
        var top = (await db.QueryAsync<object>(
            "SELECT i.title AS title FROM order_items i JOIN sub_orders s ON s.id = i.sub_order_id WHERE s.status NOT IN ('pending_payment','cancelled') " +
            "AND s.created_at >= @start AND s.created_at < @end GROUP BY i.product_id, i.title ORDER BY SUM(i.line_total) DESC LIMIT 10", p))
            .Select(r => (string)Row(r)["title"]!).ToList();
        var newCustomers = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM users WHERE created_at >= @start AND created_at < @end AND is_admin = 0", p);
        var buyers = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(DISTINCT user_id) FROM orders WHERE status = 'placed' AND placed_at >= @start AND placed_at < @end", p);
        var repeat = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM (SELECT DISTINCT user_id FROM orders WHERE status = 'placed' AND placed_at >= @start AND placed_at < @end) b " +
            "WHERE (SELECT COUNT(*) FROM orders o WHERE o.user_id = b.user_id AND o.status = 'placed') > 1", p);
        var overdue = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed') AND acknowledged_at IS NULL AND ack_due_at < UTC_TIMESTAMP(6)");
        static double Pct(double a, double b) => b != 0 ? Math.Round(a * 100 / b, 1) : 0.0;
        var orders = N(cur["orders"]);
        var gmv = N(cur["gmv"]);
        return new Dictionary<string, object?>
        {
            ["gmv"] = gmv, ["gmv_prev"] = N(prev["gmv"]), ["orders"] = orders, ["aov"] = orders > 0 ? gmv / orders : 0,
            ["commission"] = N(cur["commission"]), ["discounts"] = N(cur["discounts"]),
            ["cancellation_rate"] = Pct(N(cur["cancelled"]), N(cur["packages"])), ["return_rate"] = Pct(returns, delivered),
            ["avg_hours_to_ship"] = shipHours.HasValue ? Math.Round(shipHours.Value, 1) : null, ["views"] = views,
            ["conversion_rate"] = Pct(Math.Min(orders, views), views), ["new_customers"] = newCustomers,
            ["repeat_buyer_rate"] = Pct(repeat, buyers), ["tickets_ack_overdue"] = overdue, ["top_products"] = top,
        };
    }

    // ---------------------------------------------------------------- risk briefs

    public async Task<(long Total, long CancelledBySeller, long Late, long Rto, long Delivered, long Returns, long RejectedListings)> SellerRiskAsync(
        Guid sellerId, DateTime since, int lateDays)
    {
        var r = Row(await db.QueryFirstOrDefaultAsync<object>(
            "SELECT COUNT(*) AS total, " +
            "COALESCE(SUM(CASE WHEN status = 'cancelled' AND cancelled_by = 'seller' AND shipped_at IS NULL THEN 1 ELSE 0 END), 0) AS cancelled, " +
            "COALESCE(SUM(CASE WHEN shipped_at IS NOT NULL AND shipped_at > DATE_ADD(created_at, INTERVAL @lateDays DAY) THEN 1 ELSE 0 END), 0) AS late, " +
            "COALESCE(SUM(CASE WHEN status = 'cancelled' AND cancelled_by = 'seller' AND shipped_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS rto " +
            "FROM sub_orders WHERE seller_id = @sellerId AND created_at >= @since AND status <> 'pending_payment'", new { sellerId, since, lateDays }));
        var delivered = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND delivered_at >= @since", new { sellerId, since });
        var returns = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM return_requests WHERE seller_id = @sellerId AND created_at >= @since", new { sellerId, since });
        var rejected = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM products WHERE seller_id = @sellerId AND status = 'rejected'", new { sellerId });
        return (N(r["total"]), N(r["cancelled"]), N(r["late"]), N(r["rto"]), delivered, returns, rejected);
    }

    public async Task<(long Placed, long Cancelled, long Returns, long RtoPin, long Tickets)> OrderRiskAsync(Guid userId, string pincode)
    {
        var p = new { userId, pincode };
        var placed = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM orders WHERE user_id = @userId AND status = 'placed'", p);
        var cancelled = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE o.user_id = @userId AND s.status = 'cancelled' AND s.cancelled_by = 'customer'", p);
        var returns = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM return_requests WHERE user_id = @userId", p);
        var rto = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE (o.ship_to->>'$.pincode') = @pincode AND s.status = 'cancelled' AND s.shipped_at IS NOT NULL", p);
        var tickets = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM support_tickets WHERE user_id = @userId", p);
        return (placed, cancelled, returns, rto, tickets);
    }

    // ---------------------------------------------------------------- review summaries (hourly job)

    public async Task<List<ProductModel>> ProductsNeedingSummaryAsync() =>
        (await db.QueryAsync<ProductModel>(
            "SELECT id, title, rating_count, review_summary_count FROM products WHERE rating_count >= 5 AND rating_count - review_summary_count >= 5 LIMIT 20")).ToList();

    public Task SaveReviewSummaryAsync(Guid productId, string summary, int count) =>
        db.ExecuteAsync("UPDATE products SET review_summary = @summary, review_summary_count = @count WHERE id = @productId", new { productId, summary, count });

    // ---------------------------------------------------------------- housekeeping (cleanup job)

    public Task<int> DeleteExpiredUploadsAsync() => db.ExecuteAsync("DELETE FROM assistant_uploads WHERE expires_at < UTC_TIMESTAMP(6)");

    public Task<int> ExpireStaleActionsAsync() =>
        db.ExecuteAsync("UPDATE assistant_actions SET status = 'expired' WHERE status = 'pending' AND created_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR)");
    // ---------------------------------------------------------------- cancelling a package (shared by the assistant and the shop assistant)

    public Task<SubOrderModel?> LockSubAsync(IUnitOfWork uow, Guid id) =>
        uow.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE id = @id FOR UPDATE", new { id });

    public async Task<List<SubOrderModel>> LockOrderSubsAsync(IUnitOfWork uow, Guid orderId) =>
        (await uow.QueryAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE order_id = @orderId ORDER BY number FOR UPDATE", new { orderId })).ToList();

    public Task<OrderModel?> LockOrderAsync(IUnitOfWork uow, Guid id) =>
        uow.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id = @id FOR UPDATE", new { id });

    /// <summary>
    /// The database side of cancelling one package: status, event, stock back on sale, the refund of an online payment
    /// (left pending for the refunds job), and the order closed (coupon use released) when nothing is left.
    /// Returns the refund id and the amount refunded (0 when nothing was charged).
    /// </summary>
    public async Task<(Guid? RefundId, long Refunded)> CancelSubOrderAsync(IUnitOfWork uow, SubOrderModel sub, OrderModel order, string actor, string reason, bool feesBack)
    {
        var now = DateTimeFunctions.UtcNow();
        var src = sub.Status;
        reason ??= "";
        await uow.ExecuteAsync("UPDATE sub_orders SET status = 'cancelled', cancelled_at = @now, cancelled_by = @actor, cancel_reason = @reason, settlement_status = 'void', " +
                               "updated_at = @now WHERE id = @id", new { id = sub.Id, now, actor, reason = reason.Length > 300 ? reason[..300] : reason });
        await uow.ExecuteAsync("INSERT INTO order_events (id, order_id, sub_order_id, from_status, to_status, actor, note, created_at) VALUES (@eid, @orderId, @subId, @src, 'cancelled', @actor, @note, @now)",
            new { eid = Guid.NewGuid(), orderId = order.Id, subId = sub.Id, src, actor, note = reason.Length > 1000 ? reason[..1000] : reason, now });
        var items = (await uow.QueryAsync<OrderItemModel>("SELECT * FROM order_items WHERE sub_order_id = @id ORDER BY variant_id", new { id = sub.Id })).ToList();
        foreach (var it in items)
        {
            var qty = it.Qty - it.ReturnedQty;
            if (qty <= 0) continue;
            if (sub.WarehouseId is { } wh)
                await uow.ExecuteAsync("INSERT INTO inventory_levels (variant_id, warehouse_id, quantity, updated_at) VALUES (@v, @wh, @qty, @now) " +
                                       "ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at = VALUES(updated_at)", new { v = it.VariantId, wh, qty, now });
            await uow.ExecuteAsync("UPDATE variants SET stock = stock + @qty WHERE id = @v", new { v = it.VariantId, qty });
            await uow.ExecuteAsync("UPDATE products SET sold_count = GREATEST(sold_count - @qty, 0), in_stock = 1 WHERE id = @p", new { p = it.ProductId, qty });
        }
        var othersLive = await uow.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sub_orders WHERE order_id = @o AND status <> 'cancelled' AND id <> @id", new { o = order.Id, id = sub.Id });
        Guid? refundId = null;
        long refunded = 0;
        if (order.PaymentMethod == "online" && order.PaymentStatus is "paid" or "partially_refunded")
        {
            var paymentId = await uow.ExecuteScalarAsync<Guid?>("SELECT id FROM payments WHERE order_id = @o AND status = 'captured' ORDER BY created_at LIMIT 1", new { o = order.Id });
            var share = sub.Total - sub.PlatformDiscount + (othersLive == 0 ? order.TipPaise + (feesBack ? order.FeesTotal : 0) : 0);
            if (paymentId is { } pid && share > 0)
            {
                refundId = Guid.NewGuid();
                refunded = share;
                await uow.ExecuteAsync("INSERT INTO refunds (id, order_id, payment_id, sub_order_id, amount_paise, status, reason, attempts, last_error) " +
                                       "VALUES (@rid, @o, @pid, @sid, @amount, 'pending', @reason, 0, '')",
                    new { rid = refundId, o = order.Id, pid, sid = sub.Id, amount = share, reason = reason.Length > 300 ? reason[..300] : reason });
                var total = order.RefundedTotal + share;
                await uow.ExecuteAsync("UPDATE orders SET refunded_total = @total, payment_status = @ps WHERE id = @o",
                    new { o = order.Id, total, ps = total >= order.GrandTotal ? "refunded" : "partially_refunded" });
            }
        }
        if (order.PaymentMethod == "cod")
        {
            var live = (await uow.QueryAsync<string>("SELECT status FROM sub_orders WHERE order_id = @o AND status <> 'cancelled'", new { o = order.Id })).ToList();
            if (live.Count > 0 && live.All(x => x == "delivered")) await uow.ExecuteAsync("UPDATE orders SET payment_status = 'paid' WHERE id = @o", new { o = order.Id });
        }
        if (othersLive == 0)
        {
            await uow.ExecuteAsync("UPDATE orders SET status = 'cancelled', cancelled_at = @now, payment_status = CASE WHEN payment_method = 'online' AND payment_status = 'pending' " +
                                   "THEN 'failed' ELSE payment_status END WHERE id = @o", new { o = order.Id, now });
            var red = await uow.QueryFirstOrDefaultAsync<CouponRedemptionModel>("SELECT * FROM coupon_redemptions WHERE order_id = @o AND released = 0", new { o = order.Id });
            if (red != null)
            {
                await uow.ExecuteAsync("UPDATE coupon_redemptions SET released = 1 WHERE id = @id", new { id = red.Id });
                await uow.ExecuteAsync("UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = @c", new { c = red.CouponId });
            }
        }
        return (refundId, refunded);
    }

    public async Task<string> FirstTitleAsync(Guid subId, string fallback)
    {
        var titles = (await db.QueryAsync<string>("SELECT title FROM order_items WHERE sub_order_id = @subId", new { subId })).ToList();
        return titles.Count == 0 ? fallback : titles[0] + (titles.Count > 1 ? $" and {titles.Count - 1} more" : "");
    }
}
