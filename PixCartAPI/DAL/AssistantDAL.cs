using System.Text.Json.Nodes;
using DAL.Helpers;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>
/// The admin AI assistant: conversations, messages, uploads and confirm-before-run actions, plus the read-only business
/// queries behind its tools (sales, orders, customers, catalogue, sellers, returns, refunds, tickets, payouts, coupons,
/// GST TCS) and the changes it can run after Confirm. Definitions match the dashboard and the reference queries.
/// </summary>
public class AssistantDAL(IMySqlDapperHelper db)
{
    public sealed class Row : Dictionary<string, object?>
    {
        public Row(IDictionary<string, object?> d) : base(d, StringComparer.OrdinalIgnoreCase) { }

        public long L(string k) => AiDAL.N(this.GetValueOrDefault(k));
        public string S(string k) => this.GetValueOrDefault(k) is { } v and not DBNull ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "" : "";
        public DateTime? T(string k) => this.GetValueOrDefault(k) is DateTime d ? DateTime.SpecifyKind(d, DateTimeKind.Utc) : null;
        public double F(string k) => AiDAL.D(this.GetValueOrDefault(k)) ?? 0;
        public bool B(string k) => this.GetValueOrDefault(k) switch { bool b => b, null or DBNull => false, var v => Convert.ToInt64(v) != 0 };
        public Guid G(string k) => this.GetValueOrDefault(k) switch { Guid g => g, string s => Guid.Parse(s), _ => Guid.Empty };
    }

    private static Row ToRow(object r) => new((IDictionary<string, object?>)r);

    public async Task<List<Row>> RowsAsync(string sql, object? p = null) => (await db.QueryAsync<object>(sql, p)).Select(ToRow).ToList();

    public async Task<Row?> OneAsync(string sql, object? p = null) => await db.QueryFirstOrDefaultAsync<object>(sql, p) is { } r ? ToRow(r) : null;

    public async Task<long> CountAsync(string sql, object? p = null) => AiDAL.N(await db.ExecuteScalarAsync<object>(sql, p));

    // ---------------------------------------------------------------- conversations and messages

    public Task<AssistantConversationModel?> ConversationAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<AssistantConversationModel>("SELECT * FROM assistant_conversations WHERE id = @id", new { id });

    public async Task<List<AssistantConversationModel>> ConversationsAsync(Guid userId, bool archived, string q) =>
        (await db.QueryAsync<AssistantConversationModel>(
            "SELECT * FROM assistant_conversations WHERE user_id = @userId AND is_archived = @archived" + (q.Length > 0 ? " AND title LIKE @like" : "") +
            " ORDER BY updated_at DESC LIMIT 100", new { userId, archived, like = SqlHelpers.Contains(q) })).ToList();

    public Task InsertConversationAsync(AssistantConversationModel c) =>
        db.ExecuteAsync("INSERT INTO assistant_conversations (id, user_id, title, context, is_archived, created_at, updated_at) " +
                        "VALUES (@Id, @UserId, @Title, CAST(@Context AS JSON), @IsArchived, @CreatedAt, @UpdatedAt)", c);

    public Task UpdateConversationAsync(AssistantConversationModel c) =>
        db.ExecuteAsync("UPDATE assistant_conversations SET title = @Title, context = CAST(@Context AS JSON), is_archived = @IsArchived, updated_at = @UpdatedAt WHERE id = @Id", c);

    public Task SetConversationMetaAsync(Guid id, string title, bool archived) =>
        db.ExecuteAsync("UPDATE assistant_conversations SET title = @title, is_archived = @archived WHERE id = @id", new { id, title, archived });

    public Task DeleteConversationAsync(Guid id) => db.ExecuteAsync("DELETE FROM assistant_conversations WHERE id = @id", new { id });

    public async Task<List<AssistantMessageModel>> MessagesAsync(Guid conversationId) =>
        (await db.QueryAsync<AssistantMessageModel>("SELECT * FROM assistant_messages WHERE conversation_id = @conversationId ORDER BY created_at", new { conversationId })).ToList();

    public Task<AssistantMessageModel?> MessageAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<AssistantMessageModel>("SELECT * FROM assistant_messages WHERE id = @id", new { id });

    public Task<AssistantMessageModel?> QuestionBeforeAsync(Guid conversationId, DateTime at) =>
        db.QueryFirstOrDefaultAsync<AssistantMessageModel>(
            "SELECT * FROM assistant_messages WHERE conversation_id = @conversationId AND `role` = 'user' AND created_at <= @at ORDER BY created_at DESC LIMIT 1",
            new { conversationId, at });

    public Task InsertMessageAsync(AssistantMessageModel m) =>
        db.ExecuteAsync(
            "INSERT INTO assistant_messages (id, conversation_id, `role`, text, blocks, model_content, status, mode, upload_ids, input_tokens, output_tokens, created_at) " +
            "VALUES (@Id, @ConversationId, @Role, @Text, CAST(@Blocks AS JSON), CAST(@ModelContent AS JSON), @Status, @Mode, CAST(@UploadIds AS JSON), @InputTokens, @OutputTokens, @CreatedAt)", m);

    public Task TouchConversationAsync(Guid id) =>
        db.ExecuteAsync("UPDATE assistant_conversations SET updated_at = @now WHERE id = @id", new { id, now = DateTimeFunctions.UtcNow() });

    // ---------------------------------------------------------------- uploads

    public Task<AssistantUploadModel?> UploadAsync(Guid id) => db.QueryFirstOrDefaultAsync<AssistantUploadModel>("SELECT * FROM assistant_uploads WHERE id = @id", new { id });

    public Task InsertUploadAsync(AssistantUploadModel u) =>
        db.ExecuteAsync(
            "INSERT INTO assistant_uploads (id, user_id, filename, content_type, size, sha256, columns, `rows`, row_count, truncated, text, created_at, expires_at) " +
            "VALUES (@Id, @UserId, @Filename, @ContentType, @Size, @Sha256, CAST(@Columns AS JSON), CAST(@Rows AS JSON), @RowCount, @Truncated, @Text, @CreatedAt, @ExpiresAt)", u);

    public Task DeleteUploadAsync(Guid id, Guid userId) => db.ExecuteAsync("DELETE FROM assistant_uploads WHERE id = @id AND user_id = @userId", new { id, userId });

    // ---------------------------------------------------------------- actions

    public Task<AssistantActionModel?> ActionAsync(Guid id, IUnitOfWork? uow = null) =>
        uow != null
            ? uow.QueryFirstOrDefaultAsync<AssistantActionModel>("SELECT * FROM assistant_actions WHERE id = @id FOR UPDATE", new { id })
            : db.QueryFirstOrDefaultAsync<AssistantActionModel>("SELECT * FROM assistant_actions WHERE id = @id", new { id });

    public async Task<Dictionary<string, string>> ActionStatusesAsync(Guid conversationId) =>
        (await db.QueryAsync<AssistantActionModel>("SELECT id, status FROM assistant_actions WHERE conversation_id = @conversationId", new { conversationId }))
        .ToDictionary(a => a.Id.ToString(), a => a.Status);

    public Task InsertActionAsync(AssistantActionModel a) =>
        db.ExecuteAsync("INSERT INTO assistant_actions (id, conversation_id, user_id, kind, params, summary, status, result, created_at) " +
                        "VALUES (@Id, @ConversationId, @UserId, @Kind, CAST(@Params AS JSON), @Summary, @Status, CAST(@Result AS JSON), @CreatedAt)", a);

    public Task UpdateActionAsync(AssistantActionModel a, IUnitOfWork? uow = null)
    {
        const string sql = "UPDATE assistant_actions SET status = @Status, result = CAST(@Result AS JSON), decided_at = @DecidedAt WHERE id = @Id";
        return uow != null ? uow.ExecuteAsync(sql, a) : db.ExecuteAsync(sql, a);
    }

    // ---------------------------------------------------------------- sales

    private static string SubFilters(Guid? sellerId, Guid? categoryId, string? paymentMethod, string? stateCode, string alias = "s")
    {
        var f = $"{alias}.status <> 'pending_payment' AND {alias}.created_at >= @start AND {alias}.created_at < @end";
        if (sellerId.HasValue) f += $" AND {alias}.seller_id = @sellerId";
        if (!string.IsNullOrEmpty(paymentMethod)) f += $" AND {alias}.order_id IN (SELECT id FROM orders WHERE payment_method = @paymentMethod)";
        if (!string.IsNullOrEmpty(stateCode)) f += $" AND {alias}.order_id IN (SELECT id FROM orders WHERE (ship_to->>'$.state_code') = @stateCode)";
        if (categoryId.HasValue)
            f += $" AND {alias}.id IN (SELECT i.sub_order_id FROM order_items i JOIN products p ON p.id = i.product_id WHERE p.category_id = @categoryId)";
        return f;
    }

    public async Task<(Row Totals, long Units, Dictionary<string, long> Mix)> SalesAsync(DateTime start, DateTime end, Guid? sellerId, Guid? categoryId,
        string? paymentMethod, string? stateCode)
    {
        var f = SubFilters(sellerId, categoryId, paymentMethod, stateCode);
        var p = new { start, end, sellerId, categoryId, paymentMethod, stateCode };
        var totals = (await OneAsync(
            "SELECT COUNT(DISTINCT s.order_id) AS orders, COUNT(s.id) AS packages, COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.total ELSE 0 END), 0) AS gmv, " +
            "COALESCE(SUM(CASE WHEN s.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled, COALESCE(SUM(CASE WHEN s.status = 'cancelled' THEN s.total ELSE 0 END), 0) AS cancelled_value, " +
            "COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.commission_paise ELSE 0 END), 0) AS commission, " +
            "COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.platform_discount + s.seller_discount ELSE 0 END), 0) AS discounts, " +
            "COALESCE(SUM(s.returned_total), 0) AS returned, COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.tcs_paise ELSE 0 END), 0) AS tcs, " +
            "COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.shipping_fee ELSE 0 END), 0) AS shipping, " +
            $"COALESCE(SUM(CASE WHEN s.status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered FROM sub_orders s WHERE {f}", p))!;
        var units = await CountAsync($"SELECT COALESCE(SUM(i.qty), 0) FROM order_items i JOIN sub_orders s ON s.id = i.sub_order_id WHERE {f} AND s.status <> 'cancelled'", p);
        var mix = (await RowsAsync($"SELECT o.payment_method AS pm, COUNT(DISTINCT o.id) AS n FROM orders o JOIN sub_orders s ON s.order_id = o.id WHERE {f} GROUP BY o.payment_method", p))
            .ToDictionary(r => r.S("pm"), r => r.L("n"));
        return (totals, units, mix);
    }

    public async Task<(long NewCustomers, long RefundsPaid, long AwaitingPayment)> SalesExtrasAsync(DateTime start, DateTime end)
    {
        var p = new { start, end };
        return (await CountAsync("SELECT COUNT(*) FROM users WHERE created_at >= @start AND created_at < @end AND is_admin = 0", p),
            await CountAsync("SELECT COALESCE(SUM(amount_paise), 0) FROM refunds WHERE status = 'processed' AND updated_at >= @start AND updated_at < @end", p),
            await CountAsync("SELECT COUNT(*) FROM orders WHERE status = 'pending_payment' AND created_at >= @start AND created_at < @end", p));
    }

    /// <summary>Sales grouped by a key. Time keys are India-time dates (day, Monday of the week, first of the month) or the hour.</summary>
    public async Task<List<Row>> BreakdownAsync(string by, DateTime start, DateTime end, Guid? sellerId, Guid? categoryId, string? paymentMethod, int limit)
    {
        var f = SubFilters(sellerId, categoryId, paymentMethod, null);
        var p = new { start, end, sellerId, categoryId, paymentMethod, limit };
        const string local = "CONVERT_TZ(s.created_at, '+00:00', '+05:30')";
        const string sales = "COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.total ELSE 0 END), 0)";
        const string orders = "COUNT(DISTINCT s.order_id)";
        switch (by)
        {
            case "day" or "week" or "month" or "hour":
                var k = by switch
                {
                    "day" => $"DATE({local})", "week" => $"DATE_SUB(DATE({local}), INTERVAL WEEKDAY({local}) DAY)",
                    "month" => $"DATE(DATE_FORMAT({local}, '%Y-%m-01'))", _ => $"HOUR({local})",
                };
                return await RowsAsync($"SELECT {k} AS k, {sales} AS sales, {orders} AS orders FROM sub_orders s WHERE {f} GROUP BY k ORDER BY k", p);
            case "seller":
                return await RowsAsync($"SELECT se.display_name AS k, {sales} AS sales, {orders} AS orders FROM sub_orders s JOIN sellers se ON se.id = s.seller_id WHERE {f} " +
                                       "GROUP BY se.display_name ORDER BY sales DESC LIMIT @limit", p);
            case "status":
                return await RowsAsync($"SELECT s.status AS k, COALESCE(SUM(s.total), 0) AS sales, {orders} AS orders FROM sub_orders s WHERE {f} GROUP BY s.status ORDER BY orders DESC LIMIT @limit", p);
            case "payment_method":
                return await RowsAsync($"SELECT o.payment_method AS k, {sales} AS sales, {orders} AS orders FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE {f} " +
                                       "GROUP BY o.payment_method ORDER BY sales DESC LIMIT @limit", p);
            case "state":
                return await RowsAsync($"SELECT (o.ship_to->>'$.state_code') AS k, {sales} AS sales, {orders} AS orders FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE {f} " +
                                       "GROUP BY k ORDER BY sales DESC LIMIT @limit", p);
            case "category":
                return await RowsAsync("SELECT c.name AS k, COALESCE(SUM(i.line_total - i.seller_discount), 0) AS sales, COALESCE(SUM(i.qty), 0) AS units FROM order_items i " +
                                       $"JOIN sub_orders s ON s.id = i.sub_order_id JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id WHERE {f} AND s.status <> 'cancelled' " +
                                       "GROUP BY c.name ORDER BY sales DESC LIMIT @limit", p);
            default: // product
                return await RowsAsync("SELECT i.title AS k, COALESCE(SUM(i.line_total - i.seller_discount), 0) AS sales, COALESCE(SUM(i.qty), 0) AS units FROM order_items i " +
                                       $"JOIN sub_orders s ON s.id = i.sub_order_id WHERE {f} AND s.status <> 'cancelled' GROUP BY i.title ORDER BY sales DESC LIMIT @limit", p);
        }
    }

    // ---------------------------------------------------------------- orders

    public async Task<(long Total, long Value, List<Row> Rows)> PackagesAsync(DateTime? start, DateTime? end, string? status, string? q, Guid? sellerId, string? paymentMethod,
        int? lateHours, int limit)
    {
        var w = new List<string> { "s.status <> 'pending_payment'" };
        if (start.HasValue) w.Add("s.created_at >= @start AND s.created_at < @end");
        if (!string.IsNullOrEmpty(status)) w.Add("s.status = @status");
        if (sellerId.HasValue) w.Add("s.seller_id = @sellerId");
        if (!string.IsNullOrEmpty(paymentMethod)) w.Add("o.payment_method = @paymentMethod");
        if (lateHours is > 0) w.Add("s.status IN ('placed','confirmed','packed') AND s.created_at < @lateBefore");
        if (!string.IsNullOrEmpty(q)) w.Add("(s.number LIKE @like OR o.number LIKE @like OR u.phone LIKE @like OR u.name LIKE @like OR s.tracking_number LIKE @like)");
        var from = "FROM sub_orders s JOIN orders o ON o.id = s.order_id JOIN sellers se ON se.id = s.seller_id JOIN users u ON u.id = o.user_id WHERE " + string.Join(" AND ", w);
        var p = new { start, end, status, sellerId, paymentMethod, lateBefore = DateTimeFunctions.UtcNow().AddHours(-(lateHours ?? 0)), like = SqlHelpers.Contains((q ?? "").Trim()), limit };
        var total = await CountAsync($"SELECT COUNT(*) {from}", p);
        var value = await CountAsync($"SELECT COALESCE(SUM(s.total), 0) {from}", p);
        var rows = await RowsAsync("SELECT s.number, s.order_id, s.created_at, s.status, s.total, s.tracking_number, o.number AS order_number, o.payment_method, " +
                                   $"(o.ship_to->>'$.city') AS city, (o.ship_to->>'$.state_code') AS state_code, se.display_name AS seller, u.name AS customer, u.phone {from} " +
                                   "ORDER BY s.created_at DESC LIMIT @limit", p);
        return (total, value, rows);
    }

    public Task<OrderModel?> OrderByNumberAsync(string number) => db.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE number = @number", new { number });

    public Task<OrderModel?> OrderAsync(Guid id) => db.QueryFirstOrDefaultAsync<OrderModel>("SELECT * FROM orders WHERE id = @id", new { id });

    public Task<SubOrderModel?> SubByNumberOrAwbAsync(string reference) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE number = @reference OR tracking_number = @reference LIMIT 1", new { reference });

    public Task<SubOrderModel?> SubByNumberAsync(string number) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE UPPER(number) = @number", new { number = number.Trim().ToUpperInvariant() });

    public Task<SubOrderModel?> SubAsync(Guid id) => db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE id = @id", new { id });

    public Task<List<Row>> OrderSubsAsync(Guid orderId) =>
        RowsAsync("SELECT s.*, se.display_name AS seller FROM sub_orders s JOIN sellers se ON se.id = s.seller_id WHERE s.order_id = @orderId ORDER BY s.number", new { orderId });

    public async Task<List<OrderItemModel>> ItemsForSubsAsync(IEnumerable<Guid> subIds)
    {
        var ids = subIds.ToList();
        return ids.Count == 0 ? [] : (await db.QueryAsync<OrderItemModel>("SELECT * FROM order_items WHERE sub_order_id IN @ids", new { ids })).ToList();
    }

    public async Task<List<PaymentModel>> PaymentsAsync(Guid orderId) =>
        (await db.QueryAsync<PaymentModel>("SELECT * FROM payments WHERE order_id = @orderId ORDER BY created_at", new { orderId })).ToList();

    public async Task<List<RefundModel>> RefundsForOrderAsync(Guid orderId) =>
        (await db.QueryAsync<RefundModel>("SELECT * FROM refunds WHERE order_id = @orderId ORDER BY created_at", new { orderId })).ToList();

    public async Task<List<OrderEventModel>> EventsAsync(Guid orderId) =>
        (await db.QueryAsync<OrderEventModel>("SELECT * FROM order_events WHERE order_id = @orderId ORDER BY created_at LIMIT 40", new { orderId })).ToList();

    public async Task<List<ReturnRequestModel>> ReturnsForSubsAsync(IEnumerable<Guid> subIds)
    {
        var ids = subIds.ToList();
        return ids.Count == 0 ? [] : (await db.QueryAsync<ReturnRequestModel>("SELECT * FROM return_requests WHERE sub_order_id IN @ids", new { ids })).ToList();
    }

    public Task<UserModel?> UserAsync(Guid id) => db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id });

    // ---------------------------------------------------------------- customers

    public async Task<(long Total, List<Row> Rows)> CustomersAsync(string? q, DateTime? start, DateTime? end, bool topSpenders, int limit)
    {
        var agg = "SELECT user_id, COUNT(*) AS n, COALESCE(SUM(grand_total - refunded_total), 0) AS spent, MAX(placed_at) AS last FROM orders WHERE status = 'placed'" +
                  (start.HasValue ? " AND placed_at >= @start AND placed_at < @end" : "") + " GROUP BY user_id";
        var w = "u.is_admin = 0 AND u.deleted_at IS NULL" + (!string.IsNullOrEmpty(q) ? " AND (u.name LIKE @like OR u.phone LIKE @like OR u.email LIKE @like)" : "");
        var order = "ORDER BY u.created_at DESC";
        if (topSpenders || start.HasValue)
        {
            w += " AND a.n IS NOT NULL";
            order = "ORDER BY a.spent IS NULL, a.spent DESC";
        }
        var from = $"FROM users u LEFT JOIN ({agg}) a ON a.user_id = u.id WHERE {w}";
        var p = new { start, end, like = SqlHelpers.Contains((q ?? "").Trim()), limit };
        var total = await CountAsync($"SELECT COUNT(*) {from}", p);
        return (total, await RowsAsync($"SELECT u.id, u.name, u.phone, u.email, u.created_at, u.is_active, a.n, a.spent, a.last {from} {order} LIMIT @limit", p));
    }

    public async Task<UserModel?> CustomerByRefAsync(string email, string? phone, Guid? id)
    {
        var w = new List<string> { "email = @email" };
        if (phone != null) w.Add("phone = @phone");
        if (id.HasValue) w.Add("id = @id");
        return await db.QueryFirstOrDefaultAsync<UserModel>($"SELECT * FROM users WHERE ({string.Join(" OR ", w)}) AND is_admin = 0 LIMIT 1", new { email, phone, id });
    }

    public async Task<List<UserModel>> CustomersByNameAsync(string text) =>
        (await db.QueryAsync<UserModel>("SELECT * FROM users WHERE name LIKE @like AND is_admin = 0 LIMIT 2", new { like = SqlHelpers.Contains(text) })).ToList();

    public async Task<(Row Agg, List<OrderModel> Recent, long Returns, long Cancelled, List<Row> Tickets)> CustomerDetailAsync(Guid userId)
    {
        var p = new { userId };
        var agg = (await OneAsync("SELECT COUNT(*) AS n, COALESCE(SUM(grand_total - refunded_total), 0) AS spent, MIN(placed_at) AS first, MAX(placed_at) AS last " +
                                  "FROM orders WHERE user_id = @userId AND status = 'placed'", p))!;
        var recent = (await db.QueryAsync<OrderModel>("SELECT * FROM orders WHERE user_id = @userId ORDER BY created_at DESC LIMIT 10", p)).ToList();
        var returns = await CountAsync("SELECT COUNT(*) FROM return_requests r JOIN sub_orders s ON s.id = r.sub_order_id JOIN orders o ON o.id = s.order_id WHERE o.user_id = @userId", p);
        var cancelled = await CountAsync("SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id WHERE o.user_id = @userId AND s.status = 'cancelled'", p);
        var tickets = await RowsAsync("SELECT number, subject, status FROM support_tickets WHERE user_id = @userId ORDER BY created_at DESC LIMIT 5", p);
        return (agg, recent, returns, cancelled, tickets);
    }

    // ---------------------------------------------------------------- catalogue and stock

    public async Task<(long Total, List<Row> Rows)> ProductsAsync(string? q, string? status, Guid? sellerId, Guid? categoryId, int? maxStock, string sort, int limit)
    {
        var w = new List<string>();
        if (!string.IsNullOrEmpty(status)) w.Add("p.status = @status");
        if (sellerId.HasValue) w.Add("p.seller_id = @sellerId");
        if (categoryId.HasValue) w.Add("p.category_id = @categoryId");
        if (!string.IsNullOrEmpty(q)) w.Add("(p.title LIKE @like OR p.brand LIKE @like OR p.id IN (SELECT product_id FROM variants WHERE sku LIKE @like))");
        var where = w.Count > 0 ? "WHERE " + string.Join(" AND ", w) : "";
        var having = maxStock.HasValue ? "HAVING stock <= @maxStock" : "";
        var order = sort switch
        {
            "best_selling" => "p.sold_count DESC", "rating" => "p.rating_avg DESC", "price_high" => "p.price_from DESC", "price_low" => "p.price_from ASC",
            "stock_low" => "stock ASC", _ => "p.updated_at DESC",
        };
        var inner = "SELECT p.id, p.title, p.status, p.price_from, p.mrp_from, p.sold_count, p.rating_avg, p.rating_count, p.updated_at, se.display_name AS seller, c.name AS category, " +
                    "COALESCE(SUM(v.stock), 0) AS stock, MIN(v.sku) AS sku FROM products p JOIN sellers se ON se.id = p.seller_id JOIN categories c ON c.id = p.category_id " +
                    $"LEFT JOIN variants v ON v.product_id = p.id AND v.is_active = 1 {where} GROUP BY p.id, se.display_name, c.name {having}";
        var p = new { status, sellerId, categoryId, like = SqlHelpers.Contains((q ?? "").Trim()), maxStock, limit };
        var total = await CountAsync($"SELECT COUNT(*) FROM ({inner}) x", p);
        return (total, await RowsAsync($"{inner} ORDER BY {order} LIMIT @limit", p));
    }

    public async Task<(long Total, List<Row> Rows)> StockAlertsAsync(int threshold, Guid? sellerId, int limit)
    {
        var inner = "SELECT v.sku, p.title, v.options, se.display_name AS seller, COALESCE(SUM(il.quantity), 0) AS qty, p.sold_count FROM variants v " +
                    "JOIN products p ON p.id = v.product_id JOIN sellers se ON se.id = v.seller_id LEFT JOIN inventory_levels il ON il.variant_id = v.id " +
                    "WHERE p.status = 'approved' AND v.is_active = 1" + (sellerId.HasValue ? " AND v.seller_id = @sellerId" : "") +
                    " GROUP BY v.id, p.title, se.display_name, p.sold_count HAVING qty <= @threshold";
        var p = new { threshold, sellerId, limit };
        var total = await CountAsync($"SELECT COUNT(*) FROM ({inner}) x", p);
        return (total, await RowsAsync($"{inner} ORDER BY qty ASC, p.sold_count DESC LIMIT @limit", p));
    }

    // ---------------------------------------------------------------- sellers

    public async Task<(long Total, List<Row> Rows)> SellersAsync(string? q, string? status, DateTime? start, DateTime? end, int limit)
    {
        var sales = "SELECT seller_id, COALESCE(SUM(total), 0) AS sales, COUNT(id) AS packages FROM sub_orders WHERE status NOT IN ('pending_payment','cancelled')" +
                    (start.HasValue ? " AND created_at >= @start AND created_at < @end" : "") + " GROUP BY seller_id";
        var w = new List<string>();
        if (!string.IsNullOrEmpty(status)) w.Add("se.status = @status");
        if (!string.IsNullOrEmpty(q)) w.Add("(se.display_name LIKE @like OR se.legal_name LIKE @like OR se.gstin LIKE @like OR se.pickup_city LIKE @like)");
        var from = $"FROM sellers se LEFT JOIN ({sales}) sa ON sa.seller_id = se.id LEFT JOIN (SELECT seller_id, COUNT(*) AS n FROM products WHERE status = 'approved' GROUP BY seller_id) lv " +
                   "ON lv.seller_id = se.id " + (w.Count > 0 ? "WHERE " + string.Join(" AND ", w) : "");
        var p = new { start, end, status, like = SqlHelpers.Contains((q ?? "").Trim()), limit };
        var total = await CountAsync($"SELECT COUNT(*) {from}", p);
        return (total, await RowsAsync("SELECT se.id, se.display_name, se.legal_name, se.status, se.pickup_city, se.gstin, se.rating_avg, se.contact_phone, se.contact_email, " +
                                       $"sa.sales, sa.packages, lv.n {from} ORDER BY sa.sales IS NULL, sa.sales DESC, se.created_at DESC LIMIT @limit", p));
    }

    public Task<SellerModel?> SellerAsync(Guid id) => db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id });

    public async Task<List<SellerModel>> SellersExactAsync(string text) =>
        (await db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE display_name = @text OR gstin = @upper OR legal_name = @text",
            new { text, upper = text.ToUpperInvariant() })).ToList();

    public async Task<List<SellerModel>> SellersLikeAsync(string text) =>
        (await db.QueryAsync<SellerModel>("SELECT * FROM sellers WHERE display_name LIKE @like LIMIT 2", new { like = SqlHelpers.Contains(text.Trim()) })).ToList();

    public Task<CategoryModel?> CategoryAsync(Guid id) => db.QueryFirstOrDefaultAsync<CategoryModel>("SELECT * FROM categories WHERE id = @id", new { id });

    public async Task<List<CategoryModel>> CategoriesExactAsync(string text) =>
        (await db.QueryAsync<CategoryModel>("SELECT * FROM categories WHERE name = @text OR slug = @slug", new { text, slug = text.ToLowerInvariant() })).ToList();

    public async Task<List<CategoryModel>> CategoriesLikeAsync(string text) =>
        (await db.QueryAsync<CategoryModel>("SELECT * FROM categories WHERE name LIKE @like LIMIT 2", new { like = SqlHelpers.Contains(text.Trim()) })).ToList();

    public async Task<(long DueNow, long OnHold, Dictionary<string, long> Listings, long Late)> SellerMoneyAsync(Guid sellerId)
    {
        var p = new { sellerId, now = DateTimeFunctions.UtcNow(), lateBefore = DateTimeFunctions.UtcNow().AddHours(-48) };
        var due = await CountAsync("SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE seller_id = @sellerId AND payout_id IS NULL AND available_at <= @now", p);
        var hold = await CountAsync("SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE seller_id = @sellerId AND payout_id IS NULL AND available_at > @now", p);
        var listings = (await RowsAsync("SELECT status, COUNT(*) AS n FROM products WHERE seller_id = @sellerId GROUP BY status", p)).ToDictionary(r => r.S("status"), r => r.L("n"));
        var late = await CountAsync("SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND status IN ('placed','confirmed','packed') AND created_at < @lateBefore", p);
        return (due, hold, listings, late);
    }

    // ---------------------------------------------------------------- returns, refunds, support, payouts, coupons

    public async Task<(long Total, List<Row> ByStatus, List<Row> ByReason, List<Row> Rows)> ReturnsAsync(DateTime? start, DateTime? end, string? status, Guid? sellerId, int limit)
    {
        var range = start.HasValue ? "r.created_at >= @start AND r.created_at < @end" : "1=1";
        var w = range + (string.IsNullOrEmpty(status) ? "" : " AND r.status = @status") + (sellerId.HasValue ? " AND r.seller_id = @sellerId" : "");
        var p = new { start, end, status, sellerId, limit };
        var from = $"FROM return_requests r JOIN sub_orders s ON s.id = r.sub_order_id JOIN sellers se ON se.id = r.seller_id WHERE {w}";
        var total = await CountAsync($"SELECT COUNT(*) {from}", p);
        var byStatus = await RowsAsync($"SELECT r.status AS k, COUNT(*) AS n FROM return_requests r WHERE {range} GROUP BY r.status", p);
        var byReason = await RowsAsync($"SELECT r.reason AS k, COUNT(*) AS n FROM return_requests r WHERE {range} GROUP BY r.reason", p);
        var rows = await RowsAsync($"SELECT r.id, r.number, r.created_at, r.status, r.reason, r.refund_amount, s.number AS package, se.display_name AS seller {from} ORDER BY r.created_at DESC LIMIT @limit", p);
        return (total, byStatus, byReason, rows);
    }

    public async Task<(List<Row> ByStatus, long TotalValue, List<Row> Rows)> RefundsAsync(string? status, DateTime? start, DateTime? end, int limit)
    {
        var w = (string.IsNullOrEmpty(status) ? "1=1" : "r.status = @status") + (start.HasValue ? " AND r.created_at >= @start AND r.created_at < @end" : "");
        var p = new { status, start, end, limit };
        var byStatus = await RowsAsync("SELECT status AS k, COUNT(*) AS n FROM refunds GROUP BY status", p);
        var value = await CountAsync($"SELECT COALESCE(SUM(r.amount_paise), 0) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE {w}", p);
        var rows = await RowsAsync($"SELECT r.id, r.amount_paise, r.status, r.reason, r.attempts, r.last_error, r.created_at, o.number AS order_number FROM refunds r JOIN orders o ON o.id = r.order_id " +
                                   $"WHERE {w} ORDER BY r.created_at DESC LIMIT @limit", p);
        return (byStatus, value, rows);
    }

    public async Task<(List<Row> ByStatus, long Total, List<Row> Rows)> TicketsAsync(string? status, bool overdueOnly, string? q, int limit)
    {
        var w = new List<string> { "1=1" };
        if (!string.IsNullOrEmpty(status)) w.Add("t.status = @status");
        if (overdueOnly) w.Add("t.status NOT IN ('resolved','closed') AND ((t.acknowledged_at IS NULL AND t.ack_due_at < UTC_TIMESTAMP(6)) OR t.resolve_due_at < UTC_TIMESTAMP(6))");
        if (!string.IsNullOrEmpty(q)) w.Add("(t.number LIKE @like OR t.subject LIKE @like)");
        var from = "FROM support_tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE " + string.Join(" AND ", w);
        var p = new { status, like = SqlHelpers.Contains((q ?? "").Trim()), limit };
        var byStatus = await RowsAsync("SELECT status AS k, COUNT(*) AS n FROM support_tickets GROUP BY status");
        var total = await CountAsync($"SELECT COUNT(*) {from}", p);
        return (byStatus, total, await RowsAsync($"SELECT t.*, o.number AS order_number {from} ORDER BY t.created_at DESC LIMIT @limit", p));
    }

    public async Task<(List<Row> Due, long OnHold, List<Row> ByStatus, List<Row> Rows)> PayoutsAsync(string? status, int limit)
    {
        var p = new { status, limit, now = DateTimeFunctions.UtcNow() };
        var due = await RowsAsync("SELECT se.display_name AS seller, SUM(l.amount) AS amount FROM seller_ledger l JOIN sellers se ON se.id = l.seller_id " +
                                  "WHERE l.payout_id IS NULL AND l.available_at <= @now GROUP BY se.display_name HAVING SUM(l.amount) > 0 ORDER BY SUM(l.amount) DESC", p);
        var hold = await CountAsync("SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE payout_id IS NULL AND available_at > @now", p);
        var byStatus = await RowsAsync("SELECT status AS k, COUNT(*) AS n FROM payouts GROUP BY status");
        var rows = await RowsAsync("SELECT p.*, se.display_name AS seller FROM payouts p JOIN sellers se ON se.id = p.seller_id" + (string.IsNullOrEmpty(status) ? "" : " WHERE p.status = @status") +
                                   " ORDER BY p.created_at DESC LIMIT @limit", p);
        return (due, hold, byStatus, rows);
    }

    public async Task<Dictionary<string, long>> PendingWorkAsync()
    {
        var now = new { lateBefore = DateTimeFunctions.UtcNow().AddHours(-48) };
        return new Dictionary<string, long>
        {
            ["sellers_to_review"] = await CountAsync("SELECT COUNT(*) FROM sellers WHERE status = 'submitted'"),
            ["listings_to_review"] = await CountAsync("SELECT COUNT(*) FROM products WHERE status = 'pending'"),
            ["packages_late_to_ship_48h"] = await CountAsync("SELECT COUNT(*) FROM sub_orders WHERE status IN ('placed','confirmed','packed') AND created_at < @lateBefore", now),
            ["returns_waiting"] = await CountAsync("SELECT COUNT(*) FROM return_requests WHERE status IN ('requested','received')"),
            ["refunds_failed"] = await CountAsync("SELECT COUNT(*) FROM refunds WHERE status = 'failed'"),
            ["tickets_reply_overdue"] = await CountAsync("SELECT COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed') AND acknowledged_at IS NULL AND ack_due_at < UTC_TIMESTAMP(6)"),
            ["tickets_open"] = await CountAsync("SELECT COUNT(*) FROM support_tickets WHERE status IN ('open')"),
            ["reviews_to_moderate"] = await CountAsync("SELECT COUNT(*) FROM reviews WHERE status = 'pending'"),
            ["payouts_failed"] = await CountAsync("SELECT COUNT(*) FROM payouts WHERE status = 'failed'"),
            ["out_of_stock_options"] = await CountAsync("SELECT COUNT(*) FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'approved' AND v.is_active = 1 AND v.stock <= 0"),
        };
    }

    public async Task<List<CouponModel>> CouponsAsync(bool activeOnly) =>
        (await db.QueryAsync<CouponModel>("SELECT * FROM coupons" + (activeOnly ? " WHERE is_active = 1" : "") + " ORDER BY created_at DESC LIMIT 100")).ToList();

    public Task<CouponModel?> CouponByCodeAsync(string code) =>
        db.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE UPPER(code) = @code", new { code = code.Trim().ToUpperInvariant() });

    // ---------------------------------------------------------------- GST TCS (GSTR-8 basis)

    public async Task<(List<Row> Sales, List<Row> ReturnedValue, List<Row> ReturnedTcs, List<Row> ReturnSubs)> TcsAsync(DateTime start, DateTime end)
    {
        var p = new { start, end };
        var sales = await RowsAsync(
            "SELECT se.id, se.legal_name, se.gstin, s.is_interstate, SUM(s.taxable_total) AS taxable, SUM(s.tcs_paise) AS tcs, COUNT(*) AS n FROM sub_orders s " +
            "JOIN orders o ON o.id = s.order_id JOIN sellers se ON se.id = s.seller_id WHERE o.placed_at >= @start AND o.placed_at < @end AND s.status <> 'cancelled' " +
            "GROUP BY se.id, se.legal_name, se.gstin, s.is_interstate ORDER BY se.legal_name", p);
        var rv = await RowsAsync(
            "SELECT s.id, SUM(i.taxable_value * ri.qty / i.qty) AS v FROM sub_orders s JOIN return_requests r ON r.sub_order_id = s.id JOIN return_items ri ON ri.return_id = r.id " +
            "JOIN order_items i ON i.id = ri.order_item_id WHERE r.received_at >= @start AND r.received_at < @end GROUP BY s.id", p);
        var rt = await RowsAsync("SELECT sub_order_id AS id, SUM(amount) AS v FROM seller_ledger WHERE kind = 'tcs_reversal' AND created_at >= @start AND created_at < @end GROUP BY sub_order_id", p);
        var ids = rv.Concat(rt).Select(r => r.S("id")).Where(x => x.Length > 0).Distinct().ToList();
        var subs = ids.Count == 0 ? [] : await RowsAsync(
            "SELECT s.id AS sub_id, s.is_interstate, se.id, se.legal_name, se.gstin FROM sub_orders s JOIN sellers se ON se.id = s.seller_id WHERE s.id IN @ids", new { ids });
        return (sales, rv, rt, subs);
    }

    // ---------------------------------------------------------------- live data for file comparison

    public Task<List<Row>> LiveOrdersAsync(List<string> keys) =>
        RowsAsync("SELECT number AS k, grand_total AS total, status, payment_method AS payment FROM orders WHERE UPPER(number) IN @keys", new { keys });

    public Task<List<Row>> LivePackagesAsync(List<string> keys) =>
        RowsAsync("SELECT number AS k, total, status, tracking_number AS awb FROM sub_orders WHERE UPPER(number) IN @keys", new { keys });

    public Task<List<Row>> LiveProductsAsync(List<string> keys) =>
        RowsAsync("SELECT v.sku AS k, v.price_paise AS price, v.mrp_paise AS mrp, v.stock, p.status FROM variants v JOIN products p ON p.id = v.product_id WHERE UPPER(v.sku) IN @keys", new { keys });

    public Task<List<Row>> LivePayoutsAsync(List<string> keys) =>
        RowsAsync("SELECT number, utr, amount, status FROM payouts WHERE UPPER(number) IN @keys OR UPPER(utr) IN @keys", new { keys });

    public Task<List<Row>> LiveCustomersAsync(List<string> phones, List<string> emails) =>
        RowsAsync("SELECT u.phone, u.email, u.name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'placed') AS orders FROM users u " +
                  "WHERE u.phone IN @phones OR LOWER(u.email) IN @emails", new { phones = phones.Count > 0 ? phones : [""], emails = emails.Count > 0 ? emails : [""] });

    public Task<List<Row>> LiveSellersAsync(List<string> keys) =>
        RowsAsync("SELECT gstin AS k, status, display_name AS store FROM sellers WHERE UPPER(gstin) IN @keys", new { keys });

    // ---------------------------------------------------------------- changes the assistant runs after Confirm

    public Task<ProductModel?> ProductAsync(Guid id) => db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id });

    public async Task<List<ProductModel>> ProductsByTitleAsync(string title) =>
        (await db.QueryAsync<ProductModel>("SELECT * FROM products WHERE LOWER(title) = @title LIMIT 2", new { title = title.Trim().ToLowerInvariant() })).ToList();

    public Task<RefundModel?> RefundAsync(Guid id) => db.QueryFirstOrDefaultAsync<RefundModel>("SELECT * FROM refunds WHERE id = @id", new { id });

    public Task<ReturnRequestModel?> ReturnByNumberAsync(string number) =>
        db.QueryFirstOrDefaultAsync<ReturnRequestModel>("SELECT * FROM return_requests WHERE UPPER(number) = @number", new { number = number.Trim().ToUpperInvariant() });

    public Task<SupportTicketModel?> TicketByNumberAsync(string number) =>
        db.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE UPPER(number) = @number", new { number = number.Trim().ToUpperInvariant() });

    public Task<ReviewModel?> ReviewAsync(Guid id) => db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @id", new { id });

    public Task<UserModel?> CustomerForActionAsync(Guid? id, string? email, string? phone) =>
        db.QueryFirstOrDefaultAsync<UserModel>(
            "SELECT * FROM users WHERE is_admin = 0 AND " + (id.HasValue ? "id = @id" : email != null ? "LOWER(email) = @email" : "phone = @phone"),
            new { id, email = email?.ToLowerInvariant(), phone });

    public Task<int> ExecAsync(string sql, object? p = null, IUnitOfWork? uow = null) => uow != null ? uow.ExecuteAsync(sql, p) : db.ExecuteAsync(sql, p);

    public Task<IUnitOfWork> BeginAsync() => db.BeginAsync();
}
