using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>Back-in-stock and wishlist price-drop alert senders (reference: services/engagement.py
/// send_stock_alerts, send_price_drops; jobs.py alerts_job).</summary>
public partial class EngagementBAL
{
    /// <summary>Customers may see and buy the product (reference: public_product_filter).</summary>
    private const string PublicFilter =
        "p.status = 'approved' AND p.price_from > 0 " +
        "AND p.seller_id IN (SELECT s.id FROM sellers s WHERE s.status = 'approved' AND s.holiday_mode = 0)";

    /// <summary>Reference: send_stock_alerts — tells subscribers a followed version is available again, once each.</summary>
    public async Task<int> SendStockAlertsAsync()
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_stock_alerts")) return 0;
        var rows = (await db.QueryAsync<StockAlertRow>(
            "SELECT a.variant_id AS VariantId, a.user_id AS UserId, p.title AS Title, p.slug AS Slug, v.options AS Options, v.price_paise AS PricePaise " +
            "FROM stock_alerts a JOIN variants v ON v.id = a.variant_id JOIN products p ON p.id = v.product_id " +
            $"WHERE a.active = 1 AND a.notified_at IS NULL AND v.stock > 0 AND v.is_active = 1 AND {PublicFilter} LIMIT 500")).ToList();
        var now = DateTimeFunctions.UtcNow();
        foreach (var r in rows)
        {
            var label = ProductInfo.VariantLabel(r.Options);
            await notify.NotifyUserAsync(r.UserId, "back_in_stock", new Dictionary<string, string>
            {
                ["item"] = r.Title + (label.Length > 0 ? $" ({label})" : ""), ["price"] = Money.Rupees(r.PricePaise),
            }, link: $"/p/{r.Slug}");
            await db.ExecuteAsync("UPDATE stock_alerts SET notified_at = @now, active = 0 WHERE user_id = @userId AND variant_id = @variantId",
                new { now, userId = r.UserId, variantId = r.VariantId });
        }
        return rows.Count;
    }

    /// <summary>Reference: send_price_drops — tells shoppers a wishlisted product is cheaper than when they saved it.</summary>
    public async Task<int> SendPriceDropsAsync()
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_price_alerts")) return 0;
        var pct = cfg.Long("price_alert_min_drop_pct");
        var rows = (await db.QueryAsync<PriceDropRow>(
            "SELECT w.user_id AS UserId, w.product_id AS ProductId, w.price_at_add AS PriceAtAdd, p.title AS Title, p.slug AS Slug, p.price_from AS PriceFrom " +
            "FROM wishlist_items w JOIN products p ON p.id = w.product_id " +
            $"WHERE w.price_at_add IS NOT NULL AND p.in_stock = 1 AND {PublicFilter} " +
            "AND p.price_from * 100 <= w.price_at_add * (100 - @pct) " +
            "AND (w.alerted_price IS NULL OR p.price_from < w.alerted_price) LIMIT 500", new { pct })).ToList();
        foreach (var r in rows)
        {
            await notify.NotifyUserAsync(r.UserId, "price_drop", new Dictionary<string, string>
            {
                ["item"] = r.Title, ["price"] = Money.Rupees(r.PriceFrom), ["old_price"] = Money.Rupees(r.PriceAtAdd),
            }, link: $"/p/{r.Slug}");
            await db.ExecuteAsync("UPDATE wishlist_items SET alerted_price = @price WHERE user_id = @userId AND product_id = @productId",
                new { price = r.PriceFrom, userId = r.UserId, productId = r.ProductId });
        }
        return rows.Count;
    }

    public sealed class StockAlertRow
    {
        public Guid VariantId { get; set; }
        public Guid UserId { get; set; }
        public string Title { get; set; } = "";
        public string Slug { get; set; } = "";
        public string Options { get; set; } = "null";
        public long PricePaise { get; set; }
    }

    public sealed class PriceDropRow
    {
        public Guid UserId { get; set; }
        public Guid ProductId { get; set; }
        public long PriceAtAdd { get; set; }
        public string Title { get; set; } = "";
        public string Slug { get; set; } = "";
        public long PriceFrom { get; set; }
    }
}
