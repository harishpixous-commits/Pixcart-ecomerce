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

    /// <summary>Reference: ads_claim — link a recent unclaimed click to the signed-in shopper.</summary>
    public Task ClaimClickAsync(Guid clickId, Guid userId, DateTime cutoff) =>
        db.ExecuteAsync("UPDATE ad_clicks SET user_id = @userId WHERE id = @clickId AND user_id IS NULL AND created_at > @cutoff",
            new { clickId, userId, cutoff });
}
