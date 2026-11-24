using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>AI run log, subject snapshots and KPI queries (reference: app/ai/service.py loaders + usage,
/// services/analytics.py kpis).</summary>
public class AiDAL(IMySqlDapperHelper db)
{
    // ---------------------------------------------------------------- ai_runs

    public Task InsertRunAsync(AiRunModel r, IUnitOfWork uow) => uow.ExecuteAsync(
        "INSERT INTO ai_runs (task, subject_type, subject_id, seller_id, inputs, output, final_text, status, mode, model," +
        " input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, latency_ms, error, created_by, reviewed_by," +
        " created_at, reviewed_at, id)" +
        " VALUES (@Task, @SubjectType, @SubjectId, @SellerId, CAST(@Inputs AS JSON), CAST(@Output AS JSON), @FinalText," +
        " @Status, @Mode, @Model, @InputTokens, @OutputTokens, @CacheCreationTokens, @CacheReadTokens, @LatencyMs, @Error," +
        " @CreatedBy, @ReviewedBy, @CreatedAt, @ReviewedAt, @Id)", r);

    public Task<AiRunModel?> RunByIdAsync(Guid id) => db.QueryFirstOrDefaultAsync<AiRunModel>(
        "SELECT * FROM ai_runs WHERE id = @id", new { id });

    public Task FinishRunAsync(Guid id, string status, string finalText, Guid reviewedBy, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE ai_runs SET status = @status, final_text = @finalText, reviewed_by = @reviewedBy, reviewed_at = @now WHERE id = @id",
            new { id, status, finalText, reviewedBy, now });

    public sealed class UsageRow
    {
        public long Runs { get; set; }
        public long InputTokens { get; set; }
        public long OutputTokens { get; set; }
        public long CacheReadTokens { get; set; }
    }

    /// <summary>Reference: ai.service.usage_this_month (live runs only, from the IST month start).</summary>
    public async Task<UsageRow> UsageThisMonthAsync(DateTime monthStart) => await db.QueryFirstOrDefaultAsync<UsageRow>(
        "SELECT COUNT(*) AS Runs," +
        " COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) AS InputTokens," +
        " COALESCE(SUM(output_tokens), 0) AS OutputTokens, COALESCE(SUM(cache_read_tokens), 0) AS CacheReadTokens" +
        " FROM ai_runs WHERE created_at >= @monthStart AND mode = 'live'", new { monthStart }) ?? new UsageRow();

    public Task<IEnumerable<(string Task, long C)>> RunsByTaskThisMonthAsync(DateTime monthStart, bool appliedOnly) =>
        db.QueryAsync<(string, long)>(
            "SELECT task, COUNT(*) FROM ai_runs WHERE created_at >= @monthStart" +
            (appliedOnly ? " AND status IN ('applied', 'sent')" : "") + " GROUP BY task",
            new { monthStart });

    public sealed class RunRow
    {
        public Guid Id { get; set; }
        public string Task { get; set; } = "";
        public string SubjectType { get; set; } = "";
        public string SubjectId { get; set; } = "";
        public string Status { get; set; } = "";
        public string Mode { get; set; } = "";
        public string Model { get; set; } = "";
        public string Output { get; set; } = "null";
        public string FinalText { get; set; } = "";
        public string Error { get; set; } = "";
        public int InputTokens { get; set; }
        public int OutputTokens { get; set; }
        public int CacheCreationTokens { get; set; }
        public int CacheReadTokens { get; set; }
        public int LatencyMs { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? ReviewedAt { get; set; }
        public string? ByName { get; set; }
    }

    /// <summary>Reference: routers/ai.py runs list (newest first, 30 per page, joined author name).</summary>
    public async Task<(IEnumerable<RunRow> Items, long Total)> RunsPageAsync(string? task, string? status, int page)
    {
        const string from = " FROM ai_runs r LEFT JOIN users u ON u.id = r.created_by" +
            " WHERE (@task IS NULL OR r.task = @task) AND (@status IS NULL OR r.status = @status)";
        var total = await db.ExecuteScalarAsync<long>("SELECT COUNT(*)" + from, new { task, status });
        var items = await db.QueryAsync<RunRow>(
            "SELECT r.task AS Task, r.subject_type AS SubjectType, r.subject_id AS SubjectId, r.status AS Status," +
            " r.mode AS Mode, r.model AS Model, r.output AS Output, r.final_text AS FinalText, r.error AS Error," +
            " r.input_tokens AS InputTokens, r.output_tokens AS OutputTokens, r.cache_creation_tokens AS CacheCreationTokens," +
            " r.cache_read_tokens AS CacheReadTokens, r.latency_ms AS LatencyMs, r.created_at AS CreatedAt," +
            " r.reviewed_at AS ReviewedAt, r.id AS Id, u.name AS ByName" + from +
            " ORDER BY r.created_at DESC LIMIT 30 OFFSET @offset",
            new { task, status, offset = (page - 1) * 30 });
        return (items, total);
    }

    // ---------------------------------------------------------------- subject snapshots

    public sealed class ProductSnapshotRow
    {
        public Guid Id { get; set; }
        public Guid SellerId { get; set; }
        public string Title { get; set; } = "";
        public string Brand { get; set; } = "";
        public string Description { get; set; } = "";
        public string Highlights { get; set; } = "[]";
        public string Specs { get; set; } = "{}";
        public string HsnCode { get; set; } = "";
        public long GstBps { get; set; }
        public string CategoryName { get; set; } = "";
    }

    public Task<ProductSnapshotRow?> ProductSnapshotAsync(Guid id) => db.QueryFirstOrDefaultAsync<ProductSnapshotRow>(
        "SELECT p.id AS Id, p.seller_id AS SellerId, p.title AS Title, p.brand AS Brand, p.description AS Description," +
        " p.highlights AS Highlights, p.specs AS Specs, p.hsn_code AS HsnCode, p.gst_bps AS GstBps," +
        " COALESCE(c.name, '') AS CategoryName FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = @id",
        new { id });

    public sealed class VariantPriceRow
    {
        public long MrpPaise { get; set; }
        public long PricePaise { get; set; }
    }

    public Task<IEnumerable<VariantPriceRow>> ProductVariantPricesAsync(Guid productId) => db.QueryAsync<VariantPriceRow>(
        "SELECT mrp_paise AS MrpPaise, price_paise AS PricePaise FROM variants WHERE product_id = @productId AND is_active = 1",
        new { productId });

    public Task<IEnumerable<(int Rating, string Body)>> PublishedReviewsAsync(Guid productId, int limit = 60) =>
        db.QueryAsync<(int, string)>(
            "SELECT rating, body FROM reviews WHERE product_id = @productId AND status = 'published'" +
            " ORDER BY created_at DESC LIMIT @limit", new { productId, limit });

    public Task<SupportTicketModel?> TicketAsync(Guid id) => db.QueryFirstOrDefaultAsync<SupportTicketModel>(
        "SELECT * FROM support_tickets WHERE id = @id", new { id });

    /// <summary>Category name for the listing writer's input (reference: routers/ai.py _inputs).</summary>
    public Task<string?> CategoryNameAsync(Guid categoryId) =>
        db.ExecuteScalarAsync<string?>("SELECT name FROM categories WHERE id = @categoryId", new { categoryId });

    public Task<IEnumerable<TicketMessageModel>> TicketMessagesAsync(Guid ticketId) => db.QueryAsync<TicketMessageModel>(
        "SELECT * FROM ticket_messages WHERE ticket_id = @ticketId AND is_internal = 0 ORDER BY created_at",
        new { ticketId });

    public sealed class SubBriefRow
    {
        public string Number { get; set; } = "";
        public string Status { get; set; } = "";
        public string SellerName { get; set; } = "";
        public string TrackingNumber { get; set; } = "";
    }

    public Task<IEnumerable<SubBriefRow>> SubsWithSellerAsync(Guid orderId) => db.QueryAsync<SubBriefRow>(
        "SELECT s.number AS Number, s.status AS Status, sel.display_name AS SellerName, s.tracking_number AS TrackingNumber" +
        " FROM sub_orders s JOIN sellers sel ON sel.id = s.seller_id WHERE s.order_id = @orderId",
        new { orderId });

    public sealed class ReviewSnapshotRow
    {
        public Guid ProductId { get; set; }
        public Guid SellerId { get; set; }
        public string ProductTitle { get; set; } = "";
        public int Rating { get; set; }
        public string Title { get; set; } = "";
        public string Body { get; set; } = "";
    }

    public Task<ReviewSnapshotRow?> ReviewSnapshotAsync(Guid id) => db.QueryFirstOrDefaultAsync<ReviewSnapshotRow>(
        "SELECT r.product_id AS ProductId, p.seller_id AS SellerId, p.title AS ProductTitle, r.rating AS Rating," +
        " r.title AS Title, r.body AS Body FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.id = @id",
        new { id });

    public Task<UserModel?> UserBriefAsync(Guid id) => db.QueryFirstOrDefaultAsync<UserModel>(
        "SELECT id, name, created_at, deleted_at FROM users WHERE id = @id", new { id });

    // ---------------------------------------------------------------- KPIs (reference: services/analytics.py)

    public sealed class KpiPeriodRow
    {
        public long Orders { get; set; }
        public long Packages { get; set; }
        public long Gmv { get; set; }
        public long Cancelled { get; set; }
        public long Commission { get; set; }
        public long Returned { get; set; }
        public long Discounts { get; set; }
    }

    /// <summary>Reference: analytics.kpis period aggregate (packages exclude pending_payment).</summary>
    public async Task<KpiPeriodRow> KpiPeriodAsync(DateTime a, DateTime b) => await db.QueryFirstOrDefaultAsync<KpiPeriodRow>(
        "SELECT COUNT(DISTINCT order_id) AS Orders, COUNT(*) AS Packages," +
        " COALESCE(SUM(IF(status != 'cancelled', total, 0)), 0) AS Gmv," +
        " COALESCE(SUM(IF(status = 'cancelled', 1, 0)), 0) AS Cancelled," +
        " COALESCE(SUM(IF(status != 'cancelled', commission_paise, 0)), 0) AS Commission," +
        " COALESCE(SUM(returned_total), 0) AS Returned," +
        " COALESCE(SUM(IF(status != 'cancelled', platform_discount + seller_discount, 0)), 0) AS Discounts" +
        " FROM sub_orders WHERE status != 'pending_payment' AND created_at >= @a AND created_at < @b",
        new { a, b }) ?? new KpiPeriodRow();

    public Task<long> KpiUnitsAsync(DateTime a, DateTime b) => db.ExecuteScalarAsync<long>(
        "SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN sub_orders s ON s.id = oi.sub_order_id" +
        " WHERE s.status NOT IN ('pending_payment', 'cancelled') AND s.created_at >= @a AND s.created_at < @b",
        new { a, b });

    public Task<long> KpiReturnsCountAsync(DateTime a, DateTime b) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM return_requests WHERE created_at >= @a AND created_at < @b", new { a, b });

    public Task<long> KpiDeliveredAsync(DateTime a, DateTime b) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM sub_orders WHERE status != 'pending_payment' AND status = 'delivered'" +
        " AND delivered_at >= @a AND delivered_at < @b", new { a, b });

    public Task<double?> KpiShipHoursAsync(DateTime a, DateTime b) => db.ExecuteScalarAsync<double?>(
        "SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, shipped_at) / 3600) FROM sub_orders" +
        " WHERE status != 'pending_payment' AND shipped_at >= @a AND shipped_at < @b", new { a, b });

    private sealed class ViewsCartsRow
    {
        public long Views { get; set; }
        public long Carts { get; set; }
    }

    public async Task<(long Views, long Carts)> KpiViewsCartsAsync(DateOnly startD, DateOnly endD)
    {
        var r = await db.QueryFirstOrDefaultAsync<ViewsCartsRow>(
            "SELECT COALESCE(SUM(views), 0) AS Views, COALESCE(SUM(add_to_cart), 0) AS Carts FROM product_daily_stats" +
            " WHERE day >= @startD AND day <= @endD", new { startD, endD });
        return (r?.Views ?? 0, r?.Carts ?? 0);
    }

    public sealed class KpiDayRow
    {
        public DateTime D { get; set; }
        public long Orders { get; set; }
        public long Gmv { get; set; }
    }

    public Task<IEnumerable<KpiDayRow>> KpiDailyAsync(DateTime a, DateTime b) => db.QueryAsync<KpiDayRow>(
        "SELECT DATE(CONVERT_TZ(created_at, '+00:00', '+05:30')) AS D, COUNT(DISTINCT order_id) AS Orders," +
        " COALESCE(SUM(IF(status != 'cancelled', total, 0)), 0) AS Gmv FROM sub_orders" +
        " WHERE status != 'pending_payment' AND created_at >= @a AND created_at < @b GROUP BY D ORDER BY D",
        new { a, b });

    public sealed class KpiTopProductRow
    {
        public Guid ProductId { get; set; }
        public string Title { get; set; } = "";
        public long Units { get; set; }
        public long Revenue { get; set; }
    }

    public Task<IEnumerable<KpiTopProductRow>> KpiTopProductsAsync(DateTime a, DateTime b) =>
        db.QueryAsync<KpiTopProductRow>(
            "SELECT oi.product_id AS ProductId, oi.title AS Title, SUM(oi.qty) AS Units," +
            " SUM(oi.line_total - oi.seller_discount) AS Revenue FROM order_items oi" +
            " JOIN sub_orders s ON s.id = oi.sub_order_id" +
            " WHERE s.status NOT IN ('pending_payment', 'cancelled') AND s.created_at >= @a AND s.created_at < @b" +
            " GROUP BY oi.product_id, oi.title ORDER BY SUM(oi.line_total) DESC LIMIT 10",
            new { a, b });

    public Task<long> KpiNewCustomersAsync(DateTime a, DateTime b) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM users WHERE created_at >= @a AND created_at < @b AND is_admin = 0", new { a, b });

    private sealed class RepeatRow
    {
        public long Buyers { get; set; }
        public long Repeat { get; set; }
    }

    /// <summary>Reference: analytics.kpis repeat buyers (buyers this period whose lifetime placed orders exceed one).</summary>
    public async Task<(long Repeat, long Buyers)> KpiRepeatBuyersAsync(DateTime a, DateTime b)
    {
        var row = await db.QueryFirstOrDefaultAsync<RepeatRow>(
            "SELECT COUNT(*) AS Buyers, COALESCE(SUM(IF(c > 1, 1, 0)), 0) AS `Repeat` FROM (" +
            " SELECT o.user_id, (SELECT COUNT(*) FROM orders o2 WHERE o2.user_id = o.user_id AND o2.status = 'placed') AS c" +
            " FROM orders o WHERE o.status = 'placed' AND o.placed_at >= @a AND o.placed_at < @b GROUP BY o.user_id) t",
            new { a, b });
        return (row?.Repeat ?? 0, row?.Buyers ?? 0);
    }

    public sealed class KpiTopSellerRow
    {
        public string Name { get; set; } = "";
        public long Packages { get; set; }
        public long Gmv { get; set; }
    }

    public Task<IEnumerable<KpiTopSellerRow>> KpiTopSellersAsync(DateTime a, DateTime b) => db.QueryAsync<KpiTopSellerRow>(
        "SELECT sel.display_name AS Name, COUNT(s.id) AS Packages, COALESCE(SUM(s.total), 0) AS Gmv" +
        " FROM sellers sel JOIN sub_orders s ON s.seller_id = sel.id" +
        " WHERE s.status NOT IN ('pending_payment', 'cancelled') AND s.created_at >= @a AND s.created_at < @b" +
        " GROUP BY sel.display_name ORDER BY SUM(s.total) DESC LIMIT 10", new { a, b });

    public Task<IEnumerable<(string Name, long Gmv)>> KpiTopCategoriesAsync(DateTime a, DateTime b) =>
        db.QueryAsync<(string, long)>(
            "SELECT c.name, SUM(oi.line_total - oi.seller_discount) FROM categories c" +
            " JOIN products p ON p.category_id = c.id JOIN order_items oi ON oi.product_id = p.id" +
            " JOIN sub_orders s ON s.id = oi.sub_order_id" +
            " WHERE s.status NOT IN ('pending_payment', 'cancelled') AND s.created_at >= @a AND s.created_at < @b" +
            " GROUP BY c.name ORDER BY SUM(oi.line_total) DESC LIMIT 8", new { a, b });

    public Task<IEnumerable<(string Method, long C)>> KpiPayMixAsync(DateTime a, DateTime b) =>
        db.QueryAsync<(string, long)>(
            "SELECT payment_method, COUNT(*) FROM orders WHERE status = 'placed' AND placed_at >= @a AND placed_at < @b" +
            " GROUP BY payment_method", new { a, b });

    public Task<long> KpiOverdueTicketsAsync() => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved', 'closed')" +
        " AND acknowledged_at IS NULL AND ack_due_at < UTC_TIMESTAMP(6)");

    // ---------------------------------------------------------------- review summaries (jobs.review_summary_job)

    /// <summary>Reference: jobs.review_summary_job product pick (enough new reviews since the last summary).</summary>
    public Task<IEnumerable<(Guid Id, string Title, int RatingCount)>> ProductsNeedingSummaryAsync(int limit = 20) =>
        db.QueryAsync<(Guid, string, int)>(
            "SELECT id, title, rating_count FROM products WHERE rating_count >= 5" +
            " AND rating_count - review_summary_count >= 5 ORDER BY rating_count DESC LIMIT @limit", new { limit });

    public Task SetReviewSummaryAsync(Guid productId, string text, int ratingCount, IUnitOfWork uow) => uow.ExecuteAsync(
        "UPDATE products SET review_summary = @text, review_summary_count = @ratingCount WHERE id = @productId",
        new { productId, text, ratingCount });

    // ---------------------------------------------------------------- risk briefs (reference: app/ai/briefs.py)

    public sealed class SellerRiskRow
    {
        public long Total { get; set; }
        public long CancelledBySeller { get; set; }
        public long Late { get; set; }
        public long Rto { get; set; }
    }

    /// <summary>Reference: briefs.seller_risk package stats for the last 90 days.</summary>
    public async Task<SellerRiskRow> SellerRiskStatsAsync(Guid sellerId, DateTime since, int dispatchDays)
    {
        return await db.QueryFirstOrDefaultAsync<SellerRiskRow>(
            "SELECT COUNT(*) AS Total," +
            " SUM(IF(status = 'cancelled' AND cancelled_by = 'seller' AND shipped_at IS NULL, 1, 0)) AS CancelledBySeller," +
            " SUM(IF(shipped_at IS NOT NULL AND shipped_at > created_at + INTERVAL @lateDays DAY, 1, 0)) AS Late," +
            " SUM(IF(status = 'cancelled' AND cancelled_by = 'seller' AND shipped_at IS NOT NULL, 1, 0)) AS Rto" +
            " FROM sub_orders WHERE seller_id = @sellerId AND created_at >= @since AND status != 'pending_payment'",
            new { sellerId, since, lateDays = Math.Max(1, dispatchDays) + 1 }) ?? new SellerRiskRow();
    }

    public Task<long> SellerDeliveredSinceAsync(Guid sellerId, DateTime since) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND delivered_at >= @since", new { sellerId, since });

    public Task<long> SellerReturnsSinceAsync(Guid sellerId, DateTime since) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM return_requests WHERE seller_id = @sellerId AND created_at >= @since", new { sellerId, since });

    public Task<long> RejectedListingsAsync(Guid sellerId) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM products WHERE seller_id = @sellerId AND status = 'rejected'", new { sellerId });

    public Task<long> PlacedOrdersByUserAsync(Guid userId) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM orders WHERE user_id = @userId AND status = 'placed'", new { userId });

    public Task<long> CancelledByCustomerAsync(Guid userId) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id" +
        " WHERE o.user_id = @userId AND s.status = 'cancelled' AND s.cancelled_by = 'customer'", new { userId });

    public Task<long> ReturnsByUserAsync(Guid userId) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM return_requests WHERE user_id = @userId", new { userId });

    public Task<long> RtoByPincodeAsync(string pincode) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id" +
        " WHERE JSON_UNQUOTE(JSON_EXTRACT(o.ship_to, '$.pincode')) = @pincode" +
        " AND s.status = 'cancelled' AND s.shipped_at IS NOT NULL", new { pincode });

    public Task<long> TicketsByUserAsync(Guid userId) => db.ExecuteScalarAsync<long>(
        "SELECT COUNT(*) FROM support_tickets WHERE user_id = @userId", new { userId });
}
