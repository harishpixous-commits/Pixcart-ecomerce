using System.Text.Json.Nodes;
using BAL.Interface;
using Utils;
namespace BAL;

public partial class GrowthBAL
{
    public const int AutoSuspendMaxPerRun = 5;

    /// <summary>Mirror of services/growth.py auto_suspend_sellers. Admin → Growth → Seller scorecard → auto_suspend: suspends approved
    /// sellers at the critical level with enough orders in the window (5 per run at most). A seller approved again after an automatic
    /// suspension is left alone for one full window, so a reinstated seller is not suspended again for the same old orders.</summary>
    public async Task<int> AutoSuspendAsync(ICatalogNotifyBAL notify)
    {
        var cfg = (JsonObject)(await GetAsync())["scorecard"]!;
        if (!cfg.Bool("enabled") || !cfg.Bool("auto_suspend")) return 0;
        var since = DateTime.UtcNow.AddDays(-cfg.Int("window_days"));
        var done = 0;
        foreach (var node in ((await BuildScorecardAsync(null))["items"] as JsonArray) ?? [])
        {
            var s = (JsonObject)node!;
            if (s["level"]!.GetValue<string>() != "critical" || done >= AutoSuspendMaxPerRun) continue;
            var sid = Guid.Parse(s["seller_id"]!.GetValue<string>());
            var parts = new List<string>();
            foreach (var (key, label) in new[] { ("late", "late shipments"), ("cancel", "seller cancellations"), ("return", "returns") })
            {
                var limit = cfg.Int(key + "_critical_percent"); var pct = s[key + "_percent"]!.GetValue<double>();
                if (limit > 0 && pct >= limit) parts.Add($"{label} {pct.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture)}% (limit {limit}%)");
            }
            var reason = "Automatic: " + string.Join("; ", parts);
            await using var tx = await db.BeginAsync();
            var status = await tx.QueryFirstOrDefaultAsync<string>("SELECT status FROM sellers WHERE id = @sid FOR UPDATE", new { sid });
            var recent = await tx.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM audit_logs WHERE entity_type = 'seller' AND entity_id = @e AND action = 'seller.auto_suspend' AND created_at >= @since", new { e = sid.ToString(), since });
            if (status != "approved" || recent > 0) { await tx.CommitAsync(); continue; }
            await tx.ExecuteAsync("UPDATE sellers SET status = 'suspended', rejection_reason = @r WHERE id = @sid", new { r = reason.Length > 500 ? reason[..500] : reason, sid });
            await tx.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (NULL, 'seller.auto_suspend', 'seller', @e, @d, UTC_TIMESTAMP(6), @id)", new { e = sid.ToString(), d = reason, id = Guid.NewGuid() });
            await tx.CommitAsync();
            await notify.NotifySellerAsync(sid, "seller_kyc_update", new Dictionary<string, string> { ["status"] = "suspended", ["message"] = $"Your store is suspended: {reason}. Contact seller support." }, "/seller/onboarding");
            done++;
        }
        return done;
    }
}
