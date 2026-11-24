using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Shopper sponsored products (reference: services/ads.py serve/click). Only genuine clicks are charged; every other
/// click still opens the product, is free and counts as invalid.
/// </summary>
public partial class AdsBAL(AdsDAL ads, IPlatformSettingsBAL platform, IRateLimitBAL rateLimit, ICatalogBAL catalog,
    IMySqlDapperHelper db, AppSettings app) : IAdsBAL
{
    public static readonly IReadOnlyDictionary<string, string> Placements = new Dictionary<string, string>
    {
        ["search"] = "Search results", ["product"] = "Product pages", ["home"] = "Home page",
    };
    private static readonly TimeSpan LinkTtl = TimeSpan.FromHours(48);
    private const int ServePerMinute = 120;
    private const int ClicksPerMinute = 30;

    [GeneratedRegex(@"[^\w]+")]
    private static partial Regex NonWord();

    /// <summary>Reference: ads._digest — keyed hash; visitor ids and addresses are stored only in this form.</summary>
    private string Digest(string kind, string value) =>
        EncryptDecrypt.HmacSha256Hex(app.JwtSecret, $"{kind}|{value}")[..32];

    /// <summary>Reference: ads.address_and_network — IPv4 address and /24, or IPv6 /64 and /48.</summary>
    public static (string Address, string Network) AddressAndNetwork(string ip)
    {
        if (!IPAddress.TryParse(ip, out var addr)) return (ip, ip);
        if (addr.IsIPv4MappedToIPv6) addr = addr.MapToIPv4();
        var bytes = addr.GetAddressBytes();
        var ownBits = addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 32 : 64;
        var netBits = addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? 24 : 48;
        return (Format(bytes, ownBits), Format(bytes, netBits));

        static string Format(byte[] b, int bits)
        {
            var copy = (byte[])b.Clone();
            for (var bit = bits; bit < copy.Length * 8; bit++) copy[bit / 8] &= (byte)~(1 << (7 - bit % 8));
            return new IPAddress(copy).ToString();
        }
    }

    private async Task<bool> WithinAsync(string key, int perMinute)
    {
        try { await rateLimit.RateLimitAsync(key, perMinute, 60); return true; }
        catch (TooManyRequestsException) { return false; }
    }

    private string Mac(string payload) => EncryptDecrypt.HmacSha256Hex(app.JwtSecret, payload)[..24];

    /// <summary>Reference: ads.sign.</summary>
    public string Sign(Guid impressionId, Guid campaignId, Guid productId, string placement, DateTime servedAt)
    {
        var ts = (long)(servedAt.ToUniversalTime() - DateTime.UnixEpoch).TotalSeconds;
        var payload = $"{impressionId:N}.{campaignId:N}.{productId:N}.{placement}.{ts}";
        return Base64UrlEncode($"{payload}.{Mac(payload)}");
    }

    /// <summary>Reference: ads.verify — (impression, campaign, product, placement, time served) or null.</summary>
    public (Guid ImpressionId, Guid CampaignId, Guid ProductId, string Placement, DateTime ServedAt)? Verify(string token)
    {
        try
        {
            var raw = Base64UrlDecode(token);
            var parts = raw.Split('.');
            if (parts.Length != 6) return null;
            var mac = parts[5];
            var payload = string.Join('.', parts[..5]);
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(mac), Encoding.ASCII.GetBytes(Mac(payload)))) return null;
            if (!Placements.ContainsKey(parts[3])) return null;
            var served = DateTime.UnixEpoch.AddSeconds(long.Parse(parts[4]));
            return (Guid.Parse(parts[0]), Guid.Parse(parts[1]), Guid.Parse(parts[2]), parts[3], served);
        }
        catch { return null; } // any malformed token is simply not an ad click
    }

    private static string Base64UrlEncode(string s) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string Base64UrlDecode(string s) =>
        Encoding.UTF8.GetString(Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/') + new string('=', (4 - s.Length % 4) % 4)));

    private static DateTime TodayIst() => DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromMinutes(330)).Date;

    public async Task<List<(ProductModel Product, string Token)>> ServeAsync(string placement, string query, string? productSlug, int? limit, string visitor, string ip)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_ads") || !cfg.Bool($"ads_{placement}")) return [];
        limit ??= cfg.Int("ads_per_rail");
        var words = NonWord().Split(query.ToLowerInvariant()).Where(w => w.Length > 1).ToList();
        string extraWhere = "";
        Guid? excludeId = null;
        if (placement == "search")
        {
            if (words.Count == 0) return [];
            var likes = string.Join(" OR ", words.Take(6).Select((_, i) => $"p.title LIKE @w{i}"));
            extraWhere = $"AND (({likes}) OR p.brand LIKE @brand OR JSON_LENGTH(c.keywords) > 0)";
        }
        ProductModel? prod = null;
        if (placement == "product")
        {
            prod = productSlug is null ? null : await catalog.GetProductBySlugAsync(productSlug);
            if (prod is null) return [];
            excludeId = prod.Id;
            extraWhere = "AND p.category_id = @categoryId AND p.id <> @productId";
        }
        // A flood of requests from one address gets no ads: impressions stay honest and no links are handed out.
        if (!await WithinAsync($"adserve:{AddressAndNetwork(ip).Address}", ServePerMinute)) return [];

        var param = new Dictionary<string, object?>();
        for (var i = 0; i < words.Count && i < 6; i++) param[$"w{i}"] = $"%{words[i]}%";
        if (placement == "search") param["brand"] = $"%{query.Trim()}%";
        if (prod is not null)
        {
            param["categoryId"] = prod.CategoryId;
            param["productId"] = prod.Id;
        }
        var rows = await ads.ServeCandidatesAsync(DateTimeFunctions.UtcNow(), placement, extraWhere, param, limit.Value);

        var picked = new List<(Guid CampaignId, List<string> Keywords, ProductModel Product)>();
        var seen = new HashSet<Guid>();
        var q = query.ToLowerInvariant();
        foreach (var row in rows)
        {
            if (!seen.Add(row.Product.Id) || row.Product.Id == excludeId) continue;
            if (placement == "search" && row.Keywords.Count > 0)
            {
                var titleHit = words.Any(w => row.Product.Title.Contains(w, StringComparison.OrdinalIgnoreCase));
                if (!row.Keywords.Any(k => q.Contains(k)) && !titleHit) continue;
            }
            picked.Add(row);
            if (picked.Count >= limit) break;
        }
        if (picked.Count == 0) return [];

        var now = DateTimeFunctions.UtcNow();
        var visitorHash = Digest("visitor", visitor);
        var nonces = picked.Select(_ => Guid.NewGuid()).ToList();
        await using var uow = await db.BeginAsync();
        await ads.InsertImpressionsAsync(nonces.Select((n, i) => (n, visitorHash)).ToList(), now, uow);
        // one row order for every request, so two pages counting the same ads at once never deadlock
        var day = TodayIst();
        foreach (var (key, i) in picked.Select((r, i) => (r, i)).OrderBy(x => x.r.CampaignId).ThenBy(x => x.r.Product.Id).Select((x, i) => (x.r, i)))
            await ads.CountStatsAsync(key.CampaignId, key.Product.Id, day, 1, 0, 0, 0, uow);
        await uow.CommitAsync();
        return picked.Select((r, i) => (r.Product, Sign(nonces[i], r.CampaignId, r.Product.Id, placement, now))).ToList();
    }

    public async Task<(ProductModel? Product, Guid? ClickId)> ClickAsync(string token, string? visitor, string ip)
    {
        var parsed = Verify(token);
        if (parsed is null) return (null, null);
        var (iid, cid, pid, placement, servedAt) = parsed.Value;
        var p = await catalog.GetProductAsync(pid);
        var (address, network) = AddressAndNetwork(ip);
        if (p is null || !await WithinAsync($"adclick:{address}", ClicksPerMinute)) return (p, null); // a flood only opens the product
        var now = DateTimeFunctions.UtcNow();

        await using var uow = await db.BeginAsync();
        AdsDAL.ImpressionRow? imp = null;
        if (now - servedAt <= LinkTtl) imp = await ads.ImpressionForUpdateAsync(iid, uow);
        var firstUse = imp is { ClickedAt: null };
        if (firstUse) await ads.MarkImpressionClickedAsync(iid, now, uow); // each link is charged at most once
        var c = await ads.CampaignForShareAsync(cid, uow);
        if (c is null)
        {
            await uow.CommitAsync();
            return (p, null);
        }
        var who = visitor is not null ? Digest("visitor", visitor) : "";
        var ipHash = Digest("ip", address);
        var netHash = Digest("net", network);
        var day = TodayIst();
        var valid = firstUse && who == imp!.Visitor; // only the visitor the ad was shown to
        var repeat = valid && await ads.RepeatClickExistsAsync(cid, pid, who, now.AddHours(-24), uow);
        if (valid && !repeat)
        {
            var cfg = await platform.GetAsync();
            var dayStart = DateTime.SpecifyKind(day, DateTimeKind.Unspecified);
            var (byAddress, byNetwork) = await ads.PaidClickCountsAsync(cid, ipHash, netHash, dayStart, uow);
            valid = byAddress < cfg.Int("ads_paid_clicks_per_address") && byNetwork < cfg.Int("ads_paid_clicks_per_network");
        }
        if (!valid)
        {
            await ads.CountStatsAsync(cid, pid, day, 0, 0, 1, 0, uow);
            await uow.CommitAsync();
            return (p, null);
        }
        long cost = 0;
        if (!repeat && c.Status == "active" && c.StartsAt <= now && (c.EndsAt is null || c.EndsAt > now))
        {
            var spent = await ads.SpentTodayAsync(cid, day, uow);
            var room = c.DailyBudgetPaise - spent;
            if (c.TotalBudgetPaise is not null) room = Math.Min(room, c.TotalBudgetPaise.Value - c.SpendPaise);
            cost = Math.Max(0, Math.Min(c.BidPaise, room));
        }
        var clickId = Guid.NewGuid();
        await ads.InsertClickAsync(clickId, cid, pid, placement, who, ipHash, netHash, cost, now, uow);
        await ads.CountStatsAsync(cid, pid, day, 0, repeat ? 0 : 1, 0, cost, uow);
        await ads.AddCampaignSpendAsync(cid, cost, uow);
        if (c.TotalBudgetPaise is not null && c.SpendPaise + cost >= c.TotalBudgetPaise)
            await ads.EndCampaignAsync(cid, "The total budget is used up", uow);
        await uow.CommitAsync();
        return (p, clickId);
    }

    public Task ClaimAsync(Guid clickId, Guid userId) =>
        ads.ClaimClickAsync(clickId, userId, DateTimeFunctions.UtcNow().AddHours(-2));
}
