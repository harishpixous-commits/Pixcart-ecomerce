using Dapper;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Sponsored products reads and counters (reference: services/ads.py).</summary>
public class AdsDAL(IMySqlDapperHelper db)
{
    /// <summary>Reference catalog.public_product_filter (alias p).</summary>
    public const string PublicProduct =
        "p.status = 'approved' AND p.price_from > 0 AND p.seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)";

    public class ServeRow : ProductModel
    {
        public Guid CampaignId { get; set; }
        public string KeywordsJson { get; set; } = "[]";
    }

    /// <summary>Running campaigns on a placement, best bid first (reference: ads.serve main query).</summary>
    public async Task<List<(Guid CampaignId, List<string> Keywords, ProductModel Product)>> ServeCandidatesAsync(
        DateTime now, string placement, string extraWhere, object extra, int limit)
    {
        var sql = $"""
            SELECT c.id AS campaign_id, CAST(c.keywords AS CHAR) AS keywords_json, p.*
            FROM ad_campaigns c
            JOIN ad_campaign_products cp ON cp.campaign_id = c.id
            JOIN products p ON p.id = cp.product_id
            LEFT JOIN (SELECT campaign_id, COALESCE(SUM(spend_paise), 0) AS spent FROM ad_stats WHERE day = @day GROUP BY campaign_id) spent
              ON spent.campaign_id = c.id
            WHERE c.status = 'active' AND c.starts_at <= @now AND (c.ends_at IS NULL OR c.ends_at > @now)
              AND COALESCE(spent.spent, 0) + c.bid_paise <= c.daily_budget_paise
              AND (c.total_budget_paise IS NULL OR c.spend_paise + c.bid_paise <= c.total_budget_paise)
              AND JSON_CONTAINS(c.placements, JSON_ARRAY(@placement))
              AND {PublicProduct} AND p.in_stock = 1 AND p.seller_id = c.seller_id
              {extraWhere}
            ORDER BY c.bid_paise DESC, p.rating_avg DESC, p.sold_count DESC
            LIMIT {limit * 4}
            """;
        var param = new DynamicParameters(extra);
        param.Add("now", now);
        param.Add("placement", placement);
        param.Add("day", TodayIst());
        var rows = await db.QueryAsync<ServeRow>(sql, param);
        return rows.Select(r => (r.CampaignId, System.Text.Json.JsonSerializer.Deserialize<List<string>>(r.KeywordsJson) ?? [], (ProductModel)r)).ToList();
    }

    private static DateTime TodayIst() =>
        DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromMinutes(330)).Date; // reference: today_ist

    /// <summary>One impression per ad shown (reference: ads.serve insert).</summary>
    public Task InsertImpressionsAsync(IReadOnlyList<(Guid Id, string VisitorHash)> rows, DateTime now, IUnitOfWork uow)
    {
        var sql = new System.Text.StringBuilder("INSERT INTO ad_impressions (id, visitor, created_at) VALUES ");
        var param = new DynamicParameters();
        for (var i = 0; i < rows.Count; i++)
        {
            if (i > 0) sql.Append(',');
            sql.Append($"(@id{i}, @visitor{i}, @now)");
            param.Add($"id{i}", rows[i].Id);
            param.Add($"visitor{i}", rows[i].VisitorHash);
        }
        param.Add("now", now);
        return uow.ExecuteAsync(sql.ToString(), param);
    }

    /// <summary>Daily counters upsert (reference: ads._count; MySQL ON DUPLICATE KEY for pg on_conflict).</summary>
    public Task CountStatsAsync(Guid campaignId, Guid productId, DateTime day, int impressions, int clicks, int invalidClicks, long spend, IUnitOfWork uow) =>
        uow.ExecuteAsync("""
            INSERT INTO ad_stats (campaign_id, product_id, day, impressions, clicks, invalid_clicks, spend_paise, billed)
            VALUES (@campaignId, @productId, @day, @impressions, @clicks, @invalidClicks, @spend, 0)
            ON DUPLICATE KEY UPDATE impressions = impressions + @impressions, clicks = clicks + @clicks,
                invalid_clicks = invalid_clicks + @invalidClicks, spend_paise = spend_paise + @spend
            """, new { campaignId, productId, day, impressions, clicks, invalidClicks, spend });

    public class ImpressionRow
    {
        public Guid Id { get; set; }
        public string Visitor { get; set; } = "";
        public DateTime? ClickedAt { get; set; }
    }

    /// <summary>Reference: ads.click impression FOR UPDATE.</summary>
    public Task<ImpressionRow?> ImpressionForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<ImpressionRow>("SELECT id, visitor, clicked_at FROM ad_impressions WHERE id = @id FOR UPDATE", new { id });

    public Task MarkImpressionClickedAsync(Guid id, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE ad_impressions SET clicked_at = @now WHERE id = @id", new { id, now });

    public class CampaignRow
    {
        public Guid Id { get; set; }
        public string Status { get; set; } = "";
        public DateTime StartsAt { get; set; }
        public DateTime? EndsAt { get; set; }
        public long BidPaise { get; set; }
        public long DailyBudgetPaise { get; set; }
        public long? TotalBudgetPaise { get; set; }
        public long SpendPaise { get; set; }
    }

    /// <summary>Reference: ads.click campaign FOR NO KEY UPDATE -> MySQL FOR SHARE.</summary>
    public Task<CampaignRow?> CampaignForShareAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<CampaignRow>(
            "SELECT id, status, starts_at, ends_at, bid_paise, daily_budget_paise, total_budget_paise, spend_paise FROM ad_campaigns WHERE id = @id FOR SHARE", new { id });

    /// <summary>A repeat click by the same visitor on the same product within 24h (reference: ads.click repeat).</summary>
    public async Task<bool> RepeatClickExistsAsync(Guid campaignId, Guid productId, string visitorHash, DateTime since, IUnitOfWork uow) =>
        await uow.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM ad_clicks WHERE campaign_id = @campaignId AND product_id = @productId AND visitor = @visitorHash AND created_at > @since",
            new { campaignId, productId, visitorHash, since }) > 0;

    /// <summary>Paid clicks today from the same address / network (reference: ads.click by_address/by_network).</summary>
    public async Task<(long ByAddress, long ByNetwork)> PaidClickCountsAsync(Guid campaignId, string ipHash, string netHash, DateTime dayStart, IUnitOfWork uow)
    {
        var row = await uow.QueryFirstOrDefaultAsync<PaidCountsRow>("""
            SELECT COALESCE(SUM(ip_hash = @ipHash), 0) AS by_address, COALESCE(SUM(net_hash = @netHash), 0) AS by_network
            FROM ad_clicks WHERE campaign_id = @campaignId AND cost_paise > 0 AND created_at >= @dayStart
            """, new { campaignId, ipHash, netHash, dayStart });
        return (row?.ByAddress ?? 0, row?.ByNetwork ?? 0);
    }

    public class PaidCountsRow
    {
        public long ByAddress { get; set; }
        public long ByNetwork { get; set; }
    }

    public async Task<long> SpentTodayAsync(Guid campaignId, DateTime day, IUnitOfWork uow) =>
        await uow.ExecuteScalarAsync<long?>("SELECT COALESCE(SUM(spend_paise), 0) FROM ad_stats WHERE campaign_id = @campaignId AND day = @day",
            new { campaignId, day }) ?? 0;

    public Task InsertClickAsync(Guid id, Guid campaignId, Guid productId, string placement, string visitorHash,
        string ipHash, string netHash, long cost, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync("""
            INSERT INTO ad_clicks (id, campaign_id, product_id, placement, visitor, ip_hash, net_hash, cost_paise, created_at)
            VALUES (@id, @campaignId, @productId, @placement, @visitorHash, @ipHash, @netHash, @cost, @now)
            """, new { id, campaignId, productId, placement, visitorHash, ipHash, netHash, cost, now });

    public Task AddCampaignSpendAsync(Guid campaignId, long cost, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE ad_campaigns SET spend_paise = spend_paise + @cost WHERE id = @campaignId", new { campaignId, cost });

    public Task EndCampaignAsync(Guid campaignId, string note, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE ad_campaigns SET status = 'ended', note = @note WHERE id = @campaignId", new { campaignId, note });

    // ------------------------------------------------------------------ seller / shared reporting

    public class CampaignFullRow
    {
        public Guid Id { get; set; }
        public Guid SellerId { get; set; }
        public string Name { get; set; } = "";
        public string Status { get; set; } = "";
        public string PlacementsJson { get; set; } = "[]";
        public string KeywordsJson { get; set; } = "[]";
        public long BidPaise { get; set; }
        public long DailyBudgetPaise { get; set; }
        public long? TotalBudgetPaise { get; set; }
        public DateTime StartsAt { get; set; }
        public DateTime? EndsAt { get; set; }
        public long SpendPaise { get; set; }
        public string Note { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    private const string CampaignCols =
        "id, seller_id, name, status, CAST(placements AS CHAR) AS placements_json, CAST(keywords AS CHAR) AS keywords_json, " +
        "bid_paise, daily_budget_paise, total_budget_paise, starts_at, ends_at, spend_paise, note, created_at";

    /// <summary>A seller's campaigns, newest first (reference: seller_ads).</summary>
    public Task<IEnumerable<CampaignFullRow>> CampaignsForSellerAsync(Guid sellerId) =>
        db.QueryAsync<CampaignFullRow>($"SELECT {CampaignCols} FROM ad_campaigns WHERE seller_id = @sellerId ORDER BY created_at DESC", new { sellerId });

    public Task<CampaignFullRow?> CampaignForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<CampaignFullRow>($"SELECT {CampaignCols} FROM ad_campaigns WHERE id = @id FOR UPDATE", new { id });

    public class CampaignProductRow
    {
        public Guid CampaignId { get; set; }
        public Guid ProductId { get; set; }
        public string Title { get; set; } = "";
        public string Slug { get; set; } = "";
    }

    /// <summary>Products of the given campaigns with titles (reference: _campaign_products).</summary>
    public Task<IEnumerable<CampaignProductRow>> CampaignProductsAsync(IReadOnlyList<Guid> campaignIds) =>
        campaignIds.Count == 0
            ? Task.FromResult(Enumerable.Empty<CampaignProductRow>())
            : db.QueryAsync<CampaignProductRow>(
                "SELECT cp.campaign_id, p.id AS product_id, p.title, p.slug FROM ad_campaign_products cp JOIN products p ON p.id = cp.product_id WHERE cp.campaign_id IN @campaignIds ORDER BY cp.seq",
                new { campaignIds });

    /// <summary>Approved products the seller owns, of the given ids (reference: _check_campaign ownership check).</summary>
    public async Task<HashSet<Guid>> OwnedApprovedProductIdsAsync(Guid sellerId, IReadOnlyList<Guid> ids) =>
        ids.Count == 0
            ? []
            : (await db.QueryAsync<Guid>("SELECT id FROM products WHERE id IN @ids AND seller_id = @sellerId AND status = 'approved'",
                new { ids, sellerId })).ToHashSet();

    /// <summary>The seller's approved products for the picker (reference: seller_ads_products).</summary>
    public Task<IEnumerable<ProductModel>> SellerApprovedProductsAsync(Guid sellerId) =>
        db.QueryAsync<ProductModel>(
            "SELECT * FROM products WHERE seller_id = @sellerId AND status = 'approved' ORDER BY title LIMIT 300", new { sellerId });

    public class SpentRow
    {
        public Guid CampaignId { get; set; }
        public long Spent { get; set; }
    }

    public async Task<Dictionary<Guid, long>> SpentTodayMapAsync(IReadOnlyList<Guid> campaignIds, DateTime day) =>
        campaignIds.Count == 0
            ? []
            : (await db.QueryAsync<SpentRow>(
                "SELECT campaign_id, COALESCE(SUM(spend_paise), 0) AS spent FROM ad_stats " +
                "WHERE campaign_id IN @campaignIds AND day = @day GROUP BY campaign_id", new { campaignIds, day }))
                .ToDictionary(r => r.CampaignId, r => r.Spent);

    public class StatsRow
    {
        public Guid CampaignId { get; set; }
        public long Impressions { get; set; }
        public long Clicks { get; set; }
        public long InvalidClicks { get; set; }
        public long Spend { get; set; }
    }

    /// <summary>Lifetime or date-bounded counters per campaign (reference: ads.campaign_report stats part).</summary>
    public Task<IEnumerable<StatsRow>> CampaignStatsAsync(IReadOnlyList<Guid> campaignIds, DateTime? since) =>
        campaignIds.Count == 0
            ? Task.FromResult(Enumerable.Empty<StatsRow>())
            : db.QueryAsync<StatsRow>(
                "SELECT campaign_id, COALESCE(SUM(impressions), 0) AS impressions, COALESCE(SUM(clicks), 0) AS clicks, " +
                "COALESCE(SUM(invalid_clicks), 0) AS invalid_clicks, COALESCE(SUM(spend_paise), 0) AS spend " +
                $"FROM ad_stats WHERE campaign_id IN @campaignIds{(since is null ? "" : " AND day >= @since")} GROUP BY campaign_id",
                new { campaignIds, since });

    public class SalesRow
    {
        public Guid CampaignId { get; set; }
        public long Orders { get; set; }
        public long Sales { get; set; }
    }

    /// <summary>Attributed orders and sales per campaign (reference: ads.campaign_report attribution part, 7 days).</summary>
    public Task<IEnumerable<SalesRow>> CampaignSalesAsync(IReadOnlyList<Guid> campaignIds) =>
        campaignIds.Count == 0
            ? Task.FromResult(Enumerable.Empty<SalesRow>())
            : db.QueryAsync<SalesRow>(
                "SELECT k.campaign_id, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(oi.line_total), 0) AS sales " +
                "FROM ad_clicks k " +
                "JOIN orders o ON o.user_id = k.user_id AND o.created_at >= k.created_at AND o.created_at <= k.created_at + INTERVAL 7 DAY " +
                "JOIN sub_orders so ON so.order_id = o.id " +
                "JOIN order_items oi ON oi.sub_order_id = so.id AND oi.product_id = k.product_id " +
                "WHERE k.campaign_id IN @campaignIds AND k.user_id IS NOT NULL " +
                "AND so.status IN ('placed','confirmed','packed','shipped','delivered') GROUP BY k.campaign_id",
                new { campaignIds });

    public class LedgerRow
    {
        public long Amount { get; set; }
        public string Description { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    /// <summary>Recent ad-spend ledger entries (reference: seller_ads billing).</summary>
    public Task<IEnumerable<LedgerRow>> AdSpendLedgerAsync(Guid sellerId) =>
        db.QueryAsync<LedgerRow>(
            "SELECT amount, description, created_at FROM seller_ledger WHERE seller_id = @sellerId AND kind = 'ad_spend' ORDER BY created_at DESC LIMIT 10",
            new { sellerId });

    public Task InsertCampaignAsync(Guid id, Guid sellerId, string name, string status, string placementsJson, string keywordsJson,
        long bid, long daily, long? total, DateTime startsAt, DateTime? endsAt, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "INSERT INTO ad_campaigns (id, seller_id, name, status, placements, keywords, bid_paise, daily_budget_paise, " +
            "total_budget_paise, starts_at, ends_at, spend_paise, note, created_at, updated_at) " +
            "VALUES (@id, @sellerId, @name, @status, CAST(@placementsJson AS JSON), CAST(@keywordsJson AS JSON), @bid, @daily, " +
            "@total, @startsAt, @endsAt, 0, '', @now, @now)",
            new { id, sellerId, name, status, placementsJson, keywordsJson, bid, daily, total, startsAt, endsAt, now });

    /// <summary>Full update of a campaign's editable fields (reference: seller_update_campaign).</summary>
    public Task UpdateCampaignAsync(Guid id, string name, string placementsJson, string keywordsJson, long bid, long daily,
        long? total, DateTime startsAt, DateTime? endsAt, string status, string note, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE ad_campaigns SET name = @name, placements = CAST(@placementsJson AS JSON), keywords = CAST(@keywordsJson AS JSON), " +
            "bid_paise = @bid, daily_budget_paise = @daily, total_budget_paise = @total, starts_at = @startsAt, " +
            "ends_at = @endsAt, status = @status, note = @note, updated_at = @now WHERE id = @id",
            new { id, name, placementsJson, keywordsJson, bid, daily, total, startsAt, endsAt, status, note, now });

    /// <summary>Replace the campaign's products (reference: _set_products).</summary>
    public async Task SetCampaignProductsAsync(Guid campaignId, IReadOnlyList<Guid> productIds, IUnitOfWork uow)
    {
        await uow.ExecuteAsync("DELETE FROM ad_campaign_products WHERE campaign_id = @campaignId", new { campaignId });
        foreach (var pid in productIds.Distinct())
            await uow.ExecuteAsync("INSERT INTO ad_campaign_products (campaign_id, product_id) VALUES (@campaignId, @pid)", new { campaignId, pid });
    }

    public Task SetCampaignStatusAsync(Guid id, string status, string note, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE ad_campaigns SET status = @status, note = @note, updated_at = @now WHERE id = @id",
            new { id, status, note, now });

    public class DayStatsRow
    {
        public DateTime Day { get; set; }
        public long Impressions { get; set; }
        public long Clicks { get; set; }
        public long InvalidClicks { get; set; }
        public long Spend { get; set; }
    }

    /// <summary>Per-day counters for one campaign (reference: seller_campaign_report by_day).</summary>
    public Task<IEnumerable<DayStatsRow>> ReportByDayAsync(Guid campaignId, DateTime since) =>
        db.QueryAsync<DayStatsRow>(
            "SELECT day, COALESCE(SUM(impressions), 0) AS impressions, COALESCE(SUM(clicks), 0) AS clicks, " +
            "COALESCE(SUM(invalid_clicks), 0) AS invalid_clicks, COALESCE(SUM(spend_paise), 0) AS spend " +
            "FROM ad_stats WHERE campaign_id = @campaignId AND day >= @since GROUP BY day ORDER BY day",
            new { campaignId, since });

    public class ProductStatsRow
    {
        public string Title { get; set; } = "";
        public long Impressions { get; set; }
        public long Clicks { get; set; }
        public long InvalidClicks { get; set; }
        public long Spend { get; set; }
    }

    /// <summary>Per-product counters for one campaign (reference: seller_campaign_report by_product).</summary>
    public Task<IEnumerable<ProductStatsRow>> ReportByProductAsync(Guid campaignId, DateTime since) =>
        db.QueryAsync<ProductStatsRow>(
            "SELECT p.title, COALESCE(SUM(s.impressions), 0) AS impressions, COALESCE(SUM(s.clicks), 0) AS clicks, " +
            "COALESCE(SUM(s.invalid_clicks), 0) AS invalid_clicks, COALESCE(SUM(s.spend_paise), 0) AS spend " +
            "FROM ad_stats s JOIN products p ON p.id = s.product_id " +
            "WHERE s.campaign_id = @campaignId AND s.day >= @since GROUP BY p.title ORDER BY SUM(s.clicks) DESC",
            new { campaignId, since });

    // ------------------------------------------------------------------ admin / billing

    /// <summary>All campaigns with optional status and name/seller search (reference: admin_ads).</summary>
    public async Task<(List<CampaignFullRow> Items, long Total)> AdminCampaignsAsync(string? status, string q, int offset, int size)
    {
        var where = "1=1";
        if (status is not null && status != "all") where += " AND c.status = @status";
        if (q.Trim().Length > 0)
            where += " AND (c.name LIKE @like OR c.seller_id IN (SELECT id FROM sellers WHERE display_name LIKE @like))";
        var param = new { status, like = $"%{q.Trim()}%", offset, size };
        var total = await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM ad_campaigns c WHERE {where}", param);
        var rows = await db.QueryAsync<CampaignFullRow>(
            $"SELECT {CampaignCols} FROM ad_campaigns c WHERE {where} " +
            "ORDER BY c.status = 'pending' DESC, c.created_at DESC LIMIT @size OFFSET @offset", param);
        return (rows.ToList(), total);
    }

    public class StatusCountRow
    {
        public string Status { get; set; } = "";
        public long N { get; set; }
    }

    /// <summary>Campaign counts by status (reference: admin_ads counts).</summary>
    public Task<IEnumerable<StatusCountRow>> CampaignCountsAsync() =>
        db.QueryAsync<StatusCountRow>("SELECT status, COUNT(*) AS n FROM ad_campaigns GROUP BY status");

    /// <summary>All-campaign counters per day (reference: admin_ads revenue_30d days).</summary>
    public Task<IEnumerable<DayStatsRow>> RevenueByDayAsync(DateTime since) =>
        db.QueryAsync<DayStatsRow>(
            "SELECT day, COALESCE(SUM(impressions), 0) AS impressions, COALESCE(SUM(clicks), 0) AS clicks, " +
            "COALESCE(SUM(invalid_clicks), 0) AS invalid_clicks, COALESCE(SUM(spend_paise), 0) AS spend " +
            "FROM ad_stats WHERE day >= @since GROUP BY day ORDER BY day", new { since });

    public class SellerNameRow
    {
        public Guid Id { get; set; }
        public string DisplayName { get; set; } = "";
    }

    public async Task<Dictionary<Guid, string>> SellerNamesAsync(IReadOnlyList<Guid> ids) =>
        ids.Count == 0
            ? []
            : (await db.QueryAsync<SellerNameRow>("SELECT id, display_name FROM sellers WHERE id IN @ids", new { ids }))
                .ToDictionary(r => r.Id, r => r.DisplayName);

    public class UnbilledRow
    {
        public Guid SellerId { get; set; }
        public DateTime Day { get; set; }
        public long Spend { get; set; }
        public long Clicks { get; set; }
    }

    /// <summary>Finished days not yet billed, per seller (reference: ads.bill).</summary>
    public Task<IEnumerable<UnbilledRow>> UnbilledAsync(DateTime today, IUnitOfWork uow) =>
        uow.QueryAsync<UnbilledRow>(
            "SELECT c.seller_id, s.day, COALESCE(SUM(s.spend_paise), 0) AS spend, COALESCE(SUM(s.clicks), 0) AS clicks " +
            "FROM ad_stats s JOIN ad_campaigns c ON c.id = s.campaign_id " +
            "WHERE s.billed = 0 AND s.day < @today GROUP BY c.seller_id, s.day", new { today });

    public Task MarkBilledAsync(Guid sellerId, DateTime day, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE ad_stats SET billed = 1 WHERE day = @day AND billed = 0 " +
            "AND campaign_id IN (SELECT id FROM ad_campaigns WHERE seller_id = @sellerId)", new { sellerId, day });

    public Task InsertAdSpendLedgerAsync(Guid sellerId, long amount, string description, DateTime now, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "INSERT INTO seller_ledger (id, seller_id, sub_order_id, return_id, kind, amount, description, available_at, payout_id, created_at) " +
            "VALUES (@id, @sellerId, NULL, NULL, 'ad_spend', @amount, @description, @now, NULL, @now)",
            new { id = Guid.NewGuid(), sellerId, amount, description, now });

    /// <summary>Reference: ads_claim — link a recent unclaimed click to the signed-in shopper.</summary>
    public Task ClaimClickAsync(Guid clickId, Guid userId, DateTime cutoff) =>
        db.ExecuteAsync("UPDATE ad_clicks SET user_id = @userId WHERE id = @clickId AND user_id IS NULL AND created_at > @cutoff",
            new { clickId, userId, cutoff });
}
