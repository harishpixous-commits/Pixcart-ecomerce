using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Customer segments for marketing (mirror of services/segments.py). Read-only: counts and lists customers.
/// A customer can sit in several segments. Orders count when they are placed and not cancelled. Off unless staff switch
/// segments on in Admin → Growth.</summary>
public static class Segments
{
    public static readonly IReadOnlyDictionary<string, string> Labels = new Dictionary<string, string>
    {
        ["new"] = "Signed up recently", ["never_ordered"] = "Never placed an order", ["repeat"] = "Two or more orders",
        ["vip"] = "Spent at or above the VIP amount", ["lapsed"] = "Ordered before, but not lately",
    };
    private static readonly Dictionary<string, string> Where = new()
    {
        ["new"] = "created_at >= @newSince", ["never_ordered"] = "orders = 0", ["repeat"] = "orders >= 2",
        ["vip"] = "spent >= @vip", ["lapsed"] = "orders > 0 AND last_order_at < @lapsedBefore",
    };
    private const string Base = @"WITH c AS (
  SELECT u.id, u.name, u.phone, u.email, u.marketing_opt_in, u.created_at,
         COUNT(o.number) AS orders, CAST(COALESCE(SUM(o.grand_total), 0) AS SIGNED) AS spent, MAX(o.placed_at) AS last_order_at
  FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.status <> 'cancelled' AND o.placed_at IS NOT NULL
  WHERE u.is_admin = 0 AND u.is_active = 1 AND u.deleted_at IS NULL
  GROUP BY u.id, u.name, u.phone, u.email, u.marketing_opt_in, u.created_at) ";

    private static async Task<JsonObject> CfgAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        return (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["segments"]!;
    }

    public static async Task<JsonObject> ListAsync(IMySqlDapperHelper db, string? segment)
    {
        var cfg = await CfgAsync(db);
        if (cfg["enabled"]?.GetValue<bool>() != true)
            throw new AppException("Customer segments are switched off. Turn them on in Admin > Growth.", "segments_off", 400);
        if (segment is not null && !Labels.ContainsKey(segment))
            throw new AppException("Unknown segment", "invalid_segment", 400);
        var now = DateTime.UtcNow;
        var p = new { newSince = now.AddDays(-int.Parse(cfg["new_days"]!.ToString())), vip = long.Parse(cfg["vip_spend_paise"]!.ToString()), lapsedBefore = now.AddDays(-int.Parse(cfg["lapsed_days"]!.ToString())) };
        var list = new JsonArray();
        foreach (var (key, label) in Labels)
        {
            var n = await db.QueryFirstOrDefaultAsync<int>(Base + $"SELECT COUNT(*) FROM c WHERE {Where[key]}", p);
            list.Add(new JsonObject { ["key"] = key, ["label"] = label, ["count"] = n });
        }
        var o = new JsonObject { ["segments"] = list };
        if (segment is not null)
        {
            var rows = await db.QueryAsync<Row>(Base + $"SELECT id AS Id, name AS Name, phone AS Phone, email AS Email, marketing_opt_in AS MarketingOptIn, CAST(orders AS SIGNED) AS Orders, CAST(spent AS SIGNED) AS Spent, last_order_at AS LastOrderAt FROM c WHERE {Where[segment]} ORDER BY spent DESC, created_at DESC LIMIT 200", p);
            o["items"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject
            {
                ["id"] = r.Id.ToString(), ["name"] = r.Name, ["phone"] = r.Phone, ["email"] = r.Email, ["marketing_opt_in"] = r.MarketingOptIn,
                ["orders"] = r.Orders, ["spent_paise"] = r.Spent, ["last_order_at"] = r.LastOrderAt?.ToString("o"),
            }).ToArray());
        }
        return o;
    }
    private sealed record Row(Guid Id, string Name, string? Phone, string? Email, bool MarketingOptIn, long Orders, long Spent, DateTime? LastOrderAt);
}
