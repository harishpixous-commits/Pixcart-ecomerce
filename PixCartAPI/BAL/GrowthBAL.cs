using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

public partial class GrowthBAL(SettingsDAL settings, CatalogSupportDAL support, IAccessBAL access, IAuditBAL audit, IMySqlDapperHelper db, AppSettings app) : IGrowthBAL
{
    public const string Key = "growth";
    private enum K { Bool, Int, Text, Label, List, Choice }
    private sealed record F(string Name, object Default, K Kind, long Lo = 0, long Hi = 0, string[]? Opts = null);

    private static readonly Dictionary<string, F[]> Schema = new()
    {
        ["loyalty"] = [new("enabled", false, K.Bool), new("points_per_100", 1, K.Int, 0, 100), new("point_value_paise", 100, K.Int, 1, 10000),
            new("min_redeem_points", 100, K.Int, 1, 100000), new("max_redeem_percent", 20, K.Int, 1, 100), new("expiry_days", 365, K.Int, 0, 3650),
            new("tier_silver_points", 500, K.Int, 0, 10000000), new("tier_gold_points", 2000, K.Int, 0, 10000000),
                new("silver_bonus_percent", 0, K.Int, 0, 500), new("gold_bonus_percent", 0, K.Int, 0, 500),
                new("silver_free_delivery", false, K.Bool), new("gold_free_delivery", false, K.Bool),
                new("first_order_points", 0, K.Int, 0, 10000), new("review_points", 0, K.Int, 0, 10000), new("review_min_chars", 30, K.Int, 0, 2000), new("expiry_reminder", false, K.Bool),
            new("on_account_delete", "keep", K.Choice, 0, 0, ["keep", "zero"])],
        ["referral"] = [new("enabled", false, K.Bool), new("referrer_reward_paise", 10000, K.Int, 0, 1000000), new("friend_reward_paise", 5000, K.Int, 0, 1000000),
            new("min_order_paise", 49900, K.Int, 0, 10000000), new("max_per_user", 20, K.Int, 1, 1000)],
        ["abandoned_cart"] = [new("enabled", false, K.Bool), new("first_reminder_hours", 4, K.Int, 1, 720), new("second_reminder_hours", 24, K.Int, 1, 720),
            new("max_reminders", 2, K.Int, 1, 5), new("min_cart_paise", 29900, K.Int, 0, 10000000), new("offer_coupon", "", K.Text, 0, 30)],
        ["flash_sales"] = [new("enabled", false, K.Bool), new("max_duration_hours", 48, K.Int, 1, 720), new("max_discount_percent", 70, K.Int, 1, 95), new("show_countdown", true, K.Bool)],
        ["gift_cards"] = [new("enabled", false, K.Bool), new("min_paise", 10000, K.Int, 100, 10000000), new("max_paise", 1000000, K.Int, 100, 100000000), new("validity_days", 365, K.Int, 1, 3650), new("allow_purchase", false, K.Bool), new("staff_refund", false, K.Bool)],
        ["scorecard"] = [new("enabled", false, K.Bool), new("window_days", 30, K.Int, 7, 365), new("ship_within_hours", 48, K.Int, 1, 720),
            new("late_warn_percent", 10, K.Int, 0, 100), new("late_critical_percent", 25, K.Int, 0, 100),
            new("cancel_warn_percent", 5, K.Int, 0, 100), new("cancel_critical_percent", 10, K.Int, 0, 100),
            new("return_warn_percent", 15, K.Int, 0, 100), new("return_critical_percent", 30, K.Int, 0, 100),
            new("min_orders", 10, K.Int, 1, 10000), new("auto_suspend", false, K.Bool)],
        ["cod_risk"] = [new("enabled", false, K.Bool), new("max_cod_paise", 500000, K.Int, 0, 100000000), new("block_after_refused", 2, K.Int, 1, 20),
            new("new_account_max_cod_paise", 200000, K.Int, 0, 100000000), new("blocked_pincodes", Array.Empty<string>(), K.List, 0, 500)],
        ["seo"] = [new("sitemap_enabled", true, K.Bool), new("sitemap_include_categories", true, K.Bool), new("sitemap_include_sellers", false, K.Bool), new("sitemap_include_collections", true, K.Bool)],
        ["return_photos"] = [new("enabled", false, K.Bool), new("required_for_defects", false, K.Bool), new("max_photos", 3, K.Int, 1, 6)],
        ["newsletter"] = [new("enabled", false, K.Bool), new("title", "Get offers in your inbox", K.Label, 0, 60)],
        ["auto_discounts"] = [new("enabled", false, K.Bool)],
        ["wishlist_share"] = [new("enabled", false, K.Bool)],
        ["new_badge"] = [new("enabled", false, K.Bool), new("days", 14, K.Int, 1, 90)],
        ["promo_popup"] = [new("enabled", false, K.Bool), new("title", "Welcome", K.Label, 0, 60), new("body", "Today's best deals are live.", K.Label, 0, 200), new("button_label", "Shop now", K.Label, 0, 30), new("link", "/search?sort=discount", K.Label, 0, 200), new("delay_seconds", 5, K.Int, 0, 60)],
        ["bulk_edit"] = [new("enabled", true, K.Bool), new("max_rows", 500, K.Int, 1, 5000)],
        ["campaigns"] = [new("enabled", false, K.Bool), new("max_recipients", 500, K.Int, 1, 5000), new("max_per_day", 3, K.Int, 1, 20)],
        ["return_reasons"] = PlatformSettingsBAL.ReturnReasons.Keys.SelectMany(c => new[] { new F("label_" + c, "", K.Label, 0, 60), new F("off_" + c, false, K.Bool) }).ToArray(),
        ["shipping_zones"] = [new("enabled", false, K.Bool), new("remote_prefixes", "", K.Text, 0, 300), new("remote_surcharge_paise", 6000, K.Int, 0, 100000), new("state_fees", "", K.Text, 0, 400), new("state_free_above", "", K.Text, 0, 400), new("waive_when_free", true, K.Bool)],
        ["bought_together"] = [new("enabled", false, K.Bool), new("max_items", 4, K.Int, 1, 12)],
        ["agents"] = [new("enabled", false, K.Bool), new("expire_hours", 72, K.Int, 1, 720), new("max_per_run", 30, K.Int, 1, 200),
            new("delivery_enabled", false, K.Bool), new("delivery_nudge_hours", 24, K.Int, 1, 720), new("delivery_tracking_hours", 12, K.Int, 1, 720),
            new("delivery_cancel_hours", 168, K.Int, 24, 2160), new("delivery_max_age_days", 30, K.Int, 1, 180),
            new("orderupdate_enabled", false, K.Bool), new("orderupdate_late_hours", 12, K.Int, 1, 720), new("orderupdate_max_age_days", 14, K.Int, 1, 90),
            new("reorder_enabled", false, K.Bool), new("reorder_cover_days", 14, K.Int, 1, 180), new("reorder_window_days", 30, K.Int, 7, 180), new("reorder_min_sold", 3, K.Int, 1, 1000),
            new("marketing_enabled", false, K.Bool), new("marketing_window_days", 30, K.Int, 7, 180), new("marketing_max_sold", 2, K.Int, 0, 1000), new("marketing_min_items", 3, K.Int, 1, 1000), new("marketing_discount_percent", 10, K.Int, 1, 50), new("marketing_valid_days", 7, K.Int, 1, 60),
            new("listing_enabled", false, K.Bool), new("support_enabled", false, K.Bool), new("support_wait_hours", 4, K.Int, 1, 168), new("support_max_age_days", 14, K.Int, 1, 90),
            new("assistant_enabled", false, K.Bool), new("assistant_window_days", 7, K.Int, 1, 60), new("assistant_low_stock", 5, K.Int, 0, 1000), new("assistant_ticket_hours", 24, K.Int, 1, 720)],
        ["ship_reminders"] = [new("enabled", false, K.Bool), new("after_hours", 24, K.Int, 1, 720), new("max_age_days", 14, K.Int, 1, 60)],
        ["review_reminders"] = [new("enabled", false, K.Bool), new("after_days", 5, K.Int, 1, 60), new("max_age_days", 30, K.Int, 1, 180)],
        ["seller_shipping"] = [new("enabled", false, K.Bool), new("min_paise", 0, K.Int, 0, 10000000), new("max_paise", 500000, K.Int, 0, 10000000)],
        ["saved_searches"] = [new("enabled", false, K.Bool), new("max_per_user", 10, K.Int, 1, 50), new("min_hours_between_alerts", 24, K.Int, 1, 720)],
        ["segments"] = [new("enabled", false, K.Bool), new("vip_spend_paise", 2500000, K.Int, 0, 1000000000), new("lapsed_days", 90, K.Int, 7, 1000), new("new_days", 30, K.Int, 1, 365)],
    };

    private static JsonNode Def(F f)
    {
        if (f.Kind == K.List) return new JsonArray();
        if (f.Default is bool b) return JsonValue.Create(b);
        if (f.Default is int i) return JsonValue.Create(i);
        return JsonValue.Create((string)f.Default)!;
    }

    public static JsonObject Defaults()
    {
        var o = new JsonObject();
        foreach (var (sec, fs) in Schema)
        {
            var s = new JsonObject();
            foreach (var f in fs) s[f.Name] = Def(f);
            o[sec] = s;
        }
        return o;
    }

    public async Task<JsonObject> GetAsync() => SettingsDAL.Merge(Defaults(), await settings.GetAsync(Key));

    private static JsonNode Clean(string sec, F f, JsonNode? v)
    {
        string bad(string m) => $"{sec}.{f.Name} {m}";
        switch (f.Kind)
        {
            case K.Bool:
                if (v?.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)) throw new AppException(bad("must be on or off"), "invalid_setting");
                return v.GetValueKind() == JsonValueKind.True;
            case K.Int:
                if (!SettingsJson.IsWholeNumber(v, out var n) || n < f.Lo || n > f.Hi) throw new AppException(bad($"must be a whole number between {f.Lo} and {f.Hi}"), "invalid_setting");
                return n;
            case K.Text:
                if (v?.GetValueKind() != JsonValueKind.String || v.GetValue<string>().Trim().Length > f.Hi) throw new AppException(bad("is too long"), "invalid_setting");
                return v.GetValue<string>().Trim().ToUpperInvariant();
            case K.Choice:
                if (v?.GetValueKind() != JsonValueKind.String || !f.Opts!.Contains(v.GetValue<string>())) throw new AppException(bad("must be one of: " + string.Join(", ", f.Opts!)), "invalid_setting");
                return v.GetValue<string>();
            case K.Label:
                if (v?.GetValueKind() != JsonValueKind.String || v.GetValue<string>().Trim().Length > f.Hi) throw new AppException(bad("is too long"), "invalid_setting");
                return string.Join(' ', v.GetValue<string>().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            default:
                if (v is not JsonArray a || a.Count > f.Hi) throw new AppException(bad("has too many entries"), "invalid_setting");
                var items = a.Select(x => SettingsJson.Text(x).Trim()).Where(x => x.Length == 6 && x.All(char.IsAsciiDigit)).Distinct();
                return new JsonArray(items.Select(x => (JsonNode)x).ToArray());
        }
    }

    public async Task<JsonObject> SettingsAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "marketing");
        return new JsonObject { ["settings"] = await GetAsync(), ["defaults"] = Defaults() };
    }

    public async Task<JsonObject> UpdateAsync(UserModel admin, JsonObject body, string permission = "marketing")
    {
        await access.RequireAsync(admin, permission);
        var clean = new JsonObject();
        foreach (var (sec, vals) in body)
        {
            if (!Schema.TryGetValue(sec, out var fs) || vals is not JsonObject vo) throw new AppException($"Unknown section: {sec}", "invalid_setting");
            var c = new JsonObject();
            foreach (var (k, v) in vo)
            {
                var f = fs.FirstOrDefault(x => x.Name == k) ?? throw new AppException($"Unknown setting: {sec}.{k}", "invalid_setting");
                c[k] = Clean(sec, f, v);
            }
            clean[sec] = c;
        }
        var cur = await GetAsync();
        JsonObject Merged(string sec) => SettingsDAL.Merge((JsonObject)cur[sec]!, clean[sec] as JsonObject ?? new());
        if (clean.ContainsKey("loyalty"))
        {
            var m = Merged("loyalty");
            if (m.Int("tier_gold_points") != 0 && m.Int("tier_gold_points") <= m.Int("tier_silver_points")) throw new AppException("Gold tier needs more points than silver", "invalid_setting");
        }
        if (clean.ContainsKey("scorecard"))
        {
            var m = Merged("scorecard");
            foreach (var a in new[] { "late", "cancel", "return" })
                if (m.Int(a + "_critical_percent") < m.Int(a + "_warn_percent")) throw new AppException($"{a}: critical level must not be below the warning level", "invalid_setting");
        }
        await using var tx = await db.BeginAsync();
        var saved = await settings.GetForUpdateAsync(Key, tx.Transaction);
        foreach (var (sec, vals) in clean)
        {
            var s = saved[sec] as JsonObject ?? new JsonObject();
            foreach (var (k, v) in (JsonObject)vals!) s[k] = v?.DeepClone();
            saved[sec] = s;
        }
        await settings.SaveAsync(Key, saved, tx.Transaction);
        var detail = string.Join(", ", body.Select(x => x.Key).Order());
        await audit.AuditAsync(admin, "settings.growth", "settings", "growth", detail[..Math.Min(200, detail.Length)], tx);
        await tx.CommitAsync();
        return new JsonObject { ["settings"] = await GetAsync(), ["defaults"] = Defaults() };
    }

    private static string Level(double pct, int warn, int crit) => crit > 0 && pct >= crit ? "critical" : warn > 0 && pct >= warn ? "warning" : "ok";

    private sealed record Row(Guid SellerId, string Name, string Status, DateTime CreatedAt, DateTime? ShippedAt, string CancelledBy, long ReturnedTotal);

    public async Task<JsonObject> ScorecardAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "dashboard");
        return await BuildScorecardAsync(null);
    }

    public async Task<JsonObject> MyScorecardAsync(Guid sellerId)
    {
        var cfg = (JsonObject)(await GetAsync())["scorecard"]!;
        if (!cfg.Bool("enabled")) return new JsonObject { ["enabled"] = false };
        var mine = ((await BuildScorecardAsync(sellerId))["items"] as JsonArray)?.FirstOrDefault() as JsonObject
            ?? new JsonObject { ["orders"] = 0, ["late"] = 0, ["cancelled_by_seller"] = 0, ["returned"] = 0, ["late_percent"] = 0.0, ["cancel_percent"] = 0.0, ["return_percent"] = 0.0, ["level"] = "not_enough_orders" };
        var limits = new JsonObject();
        foreach (var (k, v) in cfg) if (k.EndsWith("_percent")) limits[k] = v?.DeepClone();
        return new JsonObject { ["enabled"] = true, ["window_days"] = cfg.Int("window_days"), ["ship_within_hours"] = cfg.Int("ship_within_hours"), ["min_orders"] = cfg.Int("min_orders"), ["limits"] = limits, ["you"] = mine };
    }

    private async Task<JsonObject> BuildScorecardAsync(Guid? sellerId)
    {
        var cfg = (JsonObject)(await GetAsync())["scorecard"]!;
        var now = DateTime.UtcNow;
        var since = now.AddDays(-cfg.Int("window_days"));
        var limit = TimeSpan.FromHours(cfg.Int("ship_within_hours"));
        var rows = await db.QueryAsync<Row>(
            "SELECT so.seller_id AS SellerId, s.display_name AS Name, so.status AS Status, so.created_at AS CreatedAt, so.shipped_at AS ShippedAt, " +
            "so.cancelled_by AS CancelledBy, so.returned_total AS ReturnedTotal FROM sub_orders so JOIN sellers s ON s.id = so.seller_id " +
            "WHERE so.created_at >= @since AND so.status <> 'pending_payment'" + (sellerId != null ? " AND so.seller_id = @sellerId" : ""), new { since, sellerId });
        var items = new List<(int Rank, int Orders, JsonObject Item)>();
        foreach (var g in rows.GroupBy(r => r.SellerId))
        {
            int orders = 0, late = 0, cancelled = 0, returned = 0;
            foreach (var r in g)
            {
                orders++;
                if (r.Status == "cancelled") { if (r.CancelledBy == "seller") cancelled++; continue; }
                DateTime? shipped = r.ShippedAt ?? (r.Status is "placed" or "confirmed" or "packed" ? now : null);
                if (shipped != null && shipped - r.CreatedAt > limit) late++;
                if (r.ReturnedTotal > 0) returned++;
            }
            double P(int x) => Math.Round(100.0 * x / orders, 1);
            var levels = new[] { Level(P(late), cfg.Int("late_warn_percent"), cfg.Int("late_critical_percent")), Level(P(cancelled), cfg.Int("cancel_warn_percent"), cfg.Int("cancel_critical_percent")), Level(P(returned), cfg.Int("return_warn_percent"), cfg.Int("return_critical_percent")) };
            var level = orders < cfg.Int("min_orders") ? "not_enough_orders" : levels.Contains("critical") ? "critical" : levels.Contains("warning") ? "warning" : "ok";
            var rank = level switch { "critical" => 0, "warning" => 1, "ok" => 2, _ => 3 };
            items.Add((rank, orders, new JsonObject
            {
                ["seller_id"] = g.Key.ToString(), ["seller"] = g.First().Name, ["orders"] = orders, ["late"] = late, ["cancelled_by_seller"] = cancelled, ["returned"] = returned,
                ["late_percent"] = P(late), ["cancel_percent"] = P(cancelled), ["return_percent"] = P(returned), ["level"] = level,
            }));
        }
        return new JsonObject
        {
            ["enabled"] = cfg.Bool("enabled"), ["window_days"] = cfg.Int("window_days"),
            ["items"] = new JsonArray(items.OrderBy(x => x.Rank).ThenByDescending(x => x.Orders).Select(x => (JsonNode)x.Item).ToArray()),
        };
    }

    public async Task<JsonObject> RedeemPointsAsync(Guid userId, int points)
    {
        await using var tx = await db.BeginAsync();
        var r = await LoyaltyPoints.RedeemAsync(tx, userId, points);
        await tx.CommitAsync();
        return r;
    }

    /// <summary>Flash sales → show_countdown (on by default): product pages and tiles hide the ticking clock when off.</summary>
    public static async Task<bool> ShowDealCountdownAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        return ((JsonObject)SettingsDAL.Merge(Defaults(), saved)["flash_sales"]!).Bool("show_countdown");
    }

    public async Task<JsonObject> LoyaltyAsync(Guid userId)
    {
        await using (var tx = await db.BeginAsync()) { if (await LoyaltyPoints.RestoreExpiredAsync(tx, userId) > 0) await tx.CommitAsync(); }
        var cfg = (JsonObject)(await GetAsync())["loyalty"]!;
        var balance = await db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE user_id = @userId", new { userId });
        var lifetime = await db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE user_id = @userId AND points > 0", new { userId });
        var rows = await db.QueryAsync<(string Kind, int Points, string Note, DateTime At)>(
            "SELECT kind AS Kind, points AS Points, note AS Note, created_at AS At FROM loyalty_ledger WHERE user_id = @userId ORDER BY created_at DESC, id LIMIT 50", new { userId });
        return new JsonObject
        {
            ["enabled"] = cfg.Bool("enabled"), ["balance"] = balance, ["lifetime"] = lifetime, ["tier"] = LoyaltyPoints.Tier(cfg, lifetime), ["bonus_percent"] = LoyaltyPoints.BonusPercent(cfg, LoyaltyPoints.Tier(cfg, lifetime)),
            ["review_points"] = cfg.Int("review_points"), ["first_order_points"] = lifetime == 0 ? cfg.Int("first_order_points") : 0, // ways to earn the member can still use
            ["free_delivery"] = cfg.Bool("enabled") && LoyaltyPoints.TierFreeDelivery(cfg, LoyaltyPoints.Tier(cfg, lifetime)),
            ["value_paise"] = balance * cfg.Int("point_value_paise"),
            ["expiring_soon"] = await LoyaltyPoints.ExpiringSoonAsync(db, userId, cfg), ["expiring_days"] = LoyaltyPoints.ExpiryWarnDays, // points that lapse within that many days
            ["history"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject { ["kind"] = r.Kind, ["points"] = r.Points, ["note"] = r.Note, ["at"] = DateTime.SpecifyKind(r.At, DateTimeKind.Utc).ToString("o") }).ToArray()),
        };
    }

    public async Task<JsonObject> AdjustPointsAsync(UserModel admin, Guid userId, int points, string note)
    {
        await access.RequireAsync(admin, "marketing");
        if (points == 0) throw new AppException("Enter a number of points other than zero", "invalid_points");
        note = note.Trim();
        await using var tx = await db.BeginAsync();
        var cur = await tx.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points),0) FROM loyalty_ledger WHERE user_id = @userId FOR UPDATE", new { userId });
        if (cur + points < 0) throw new AppException("That would take the balance below zero", "balance_too_low");
        await tx.ExecuteAsync("INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @userId, NULL, 'adjust', @points, @note, @now)",
            new { id = Guid.NewGuid(), userId, points, note, now = DateTime.UtcNow });
        await audit.AuditAsync(admin, "loyalty.adjust", "user", userId, $"{points:+#;-#} points", tx);
        await tx.CommitAsync();
        return await LoyaltyAsync(userId);
    }

    public async Task<string?> SitemapAsync()
    {
        var cfg = (JsonObject)(await GetAsync())["seo"]!;
        if (!cfg.Bool("sitemap_enabled")) return null;
        var b = app.PublicWebUrl.TrimEnd('/');
        var urls = new List<string> { b + "/" };
        if (cfg.Bool("sitemap_include_categories")) urls.AddRange((await db.QueryAsync<string>("SELECT slug FROM categories WHERE is_active = 1 ORDER BY slug")).Select(x => $"{b}/c/{x}"));
        urls.AddRange((await db.QueryAsync<string>("SELECT slug FROM products WHERE status = 'approved' ORDER BY slug LIMIT 50000")).Select(x => $"{b}/p/{x}"));
        if (cfg.Bool("sitemap_include_sellers")) urls.AddRange((await db.QueryAsync<string>("SELECT slug FROM sellers WHERE status = 'approved' ORDER BY slug")).Select(x => $"{b}/store/{x}"));
        if (cfg.Bool("sitemap_include_collections")) urls.AddRange((await db.QueryAsync<string>("SELECT slug FROM product_collections WHERE is_active = 1 ORDER BY slug")).Select(x => $"{b}/collections/{x}"));
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">" +
               string.Concat(urls.Select(u => "<url><loc>" + System.Security.SecurityElement.Escape(u) + "</loc></url>")) + "</urlset>";
    }

    public string RobotsTxt() =>
        "User-agent: *\nAllow: /\nDisallow: /seller\nDisallow: /admin\nDisallow: /checkout\nDisallow: /cart\nDisallow: /orders\nDisallow: /account\nDisallow: /api\n\nSitemap: " + app.PublicWebUrl.TrimEnd('/') + "/sitemap.xml\n";
}
