using System.Net;
using System.Text.Json.Nodes;
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
    IMySqlDapperHelper db, AppSettings app, CatalogDAL catalogDb, AuditDAL audit, IAccessBAL access,
    ICatalogNotifyBAL notify) : IAdsBAL
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

    // ------------------------------------------------------------------ seller

    /// <summary>Reference: _ads_rules.</summary>
    private static JsonObject Rules(JsonObject cfg) => new()
    {
        ["enabled"] = cfg.Bool("feature_ads"), ["need_approval"] = cfg.Bool("ads_need_approval"),
        ["min_bid_paise"] = cfg.Long("ads_min_bid_paise"), ["min_daily_budget_paise"] = cfg.Long("ads_min_daily_budget_paise"),
        ["gst_bps"] = cfg.Long("commission_gst_bps"),
        ["placements"] = new JsonObject(Placements.Select(kv =>
            new KeyValuePair<string, JsonNode?>(kv.Key, new JsonObject { ["label"] = kv.Value, ["enabled"] = cfg.Bool($"ads_{kv.Key}") })).ToArray()),
        ["attribution_days"] = 7, ["link_hours"] = 48,
        ["paid_clicks_per_address"] = cfg.Int("ads_paid_clicks_per_address"),
        ["paid_clicks_per_network"] = cfg.Int("ads_paid_clicks_per_network"),
    };

    private async Task<JsonObject> CampaignOutAsync(AdsDAL.CampaignFullRow c, Dictionary<Guid, List<AdsDAL.CampaignProductRow>> productsByCampaign,
        Dictionary<Guid, AdsDAL.StatsRow> stats, Dictionary<Guid, (long Orders, long Sales)> sales, Dictionary<Guid, long> spentToday)
    {
        var prods = productsByCampaign.GetValueOrDefault(c.Id) ?? [];
        var imgs = await catalogDb.ImagesForAsync(prods.Select(p => p.ProductId));
        var st = stats.GetValueOrDefault(c.Id);
        var sa = sales.GetValueOrDefault(c.Id);
        var statsJson = st is null
            ? new JsonObject { ["impressions"] = 0, ["clicks"] = 0, ["invalid_clicks"] = 0, ["spend"] = 0, ["orders"] = 0, ["sales"] = 0, ["ctr"] = 0.0, ["acos"] = null }
            : new JsonObject
            {
                ["impressions"] = st.Impressions, ["clicks"] = st.Clicks, ["invalid_clicks"] = st.InvalidClicks,
                ["spend"] = st.Spend, ["orders"] = sa.Orders, ["sales"] = sa.Sales,
                ["ctr"] = st.Impressions > 0 ? Math.Round(100.0 * st.Clicks / st.Impressions, 2) : 0.0,
                ["acos"] = sa.Sales > 0 ? Math.Round(100.0 * st.Spend / (double)sa.Sales, 1) : null,
            };
        return new JsonObject
        {
            ["id"] = c.Id.ToString(), ["name"] = c.Name, ["status"] = c.Status, ["note"] = c.Note,
            ["placements"] = JsonNode.Parse(c.PlacementsJson), ["keywords"] = JsonNode.Parse(c.KeywordsJson),
            ["bid_paise"] = c.BidPaise, ["daily_budget_paise"] = c.DailyBudgetPaise, ["total_budget_paise"] = c.TotalBudgetPaise,
            ["starts_at"] = c.StartsAt.ToString("yyyy-MM-ddTHH:mm:ss"), ["ends_at"] = c.EndsAt?.ToString("yyyy-MM-ddTHH:mm:ss"),
            ["spend_paise"] = c.SpendPaise, ["spent_today_paise"] = spentToday.GetValueOrDefault(c.Id),
            ["products"] = new JsonArray(prods.Select(p => (JsonNode)new JsonObject
            {
                ["id"] = p.ProductId.ToString(), ["title"] = p.Title, ["slug"] = p.Slug,
                ["image"] = imgs.GetValueOrDefault(p.ProductId)?.FirstOrDefault() ?? "",
            }).ToArray()),
            ["stats"] = statsJson,
            ["created_at"] = c.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
        };
    }

    /// <summary>Reference: _campaigns_out.</summary>
    private async Task<List<JsonObject>> CampaignsOutAsync(List<AdsDAL.CampaignFullRow> campaigns, DateTime? since = null)
    {
        var ids = campaigns.Select(c => c.Id).ToList();
        var products = (await ads.CampaignProductsAsync(ids)).GroupBy(p => p.CampaignId).ToDictionary(g => g.Key, g => g.ToList());
        var stats = (await ads.CampaignStatsAsync(ids, since)).ToDictionary(s => s.CampaignId);
        var sales = (await ads.CampaignSalesAsync(ids)).ToDictionary(s => s.CampaignId, s => (s.Orders, s.Sales));
        var today = await ads.SpentTodayMapAsync(ids, TodayIst());
        var outp = new List<JsonObject>();
        foreach (var c in campaigns) outp.Add(await CampaignOutAsync(c, products, stats, sales, today));
        return outp;
    }

    public async Task<JsonObject> SellerListAsync(SellerModel seller)
    {
        var cfg = await platform.GetAsync();
        var campaigns = (await ads.CampaignsForSellerAsync(seller.Id)).ToList();
        var items = await CampaignsOutAsync(campaigns);
        var since = TodayIst().AddDays(-29);
        var report = (await ads.CampaignStatsAsync(campaigns.Select(c => c.Id).ToList(), since)).ToList();
        var sales = (await ads.CampaignSalesAsync(campaigns.Select(c => c.Id).ToList())).ToList();
        var totals = new JsonObject
        {
            ["impressions"] = report.Sum(r => r.Impressions), ["clicks"] = report.Sum(r => r.Clicks),
            ["invalid_clicks"] = report.Sum(r => r.InvalidClicks), ["spend"] = report.Sum(r => r.Spend),
            ["orders"] = sales.Sum(r => r.Orders), ["sales"] = sales.Sum(r => r.Sales),
        };
        var totalSpend = report.Sum(r => r.Spend);
        var totalSales = sales.Sum(r => r.Sales);
        totals["acos"] = totalSales > 0 ? Math.Round(100.0 * totalSpend / totalSales, 1) : null;
        var billing = await ads.AdSpendLedgerAsync(seller.Id);
        return new JsonObject
        {
            ["campaigns"] = new JsonArray(items.Select(i => (JsonNode)i).ToArray()),
            ["rules"] = Rules(cfg),
            ["totals_30d"] = totals,
            ["billing"] = new JsonArray(billing.Select(e => (JsonNode)new JsonObject
            {
                ["amount"] = e.Amount, ["description"] = e.Description, ["at"] = e.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
            }).ToArray()),
        };
    }

    public async Task<List<JsonObject>> SellerProductsAsync(SellerModel seller)
    {
        var rows = (await ads.SellerApprovedProductsAsync(seller.Id)).ToList();
        var imgs = await catalogDb.ImagesForAsync(rows.Select(r => r.Id));
        return rows.Select(p => new JsonObject
        {
            ["id"] = p.Id.ToString(), ["title"] = p.Title, ["image"] = imgs.GetValueOrDefault(p.Id)?.FirstOrDefault() ?? "",
            ["price"] = p.PriceFrom, ["in_stock"] = p.InStock, ["rating_avg"] = (double)p.RatingAvg,
        }).ToList();
    }

    /// <summary>Reference: _check_campaign.</summary>
    private async Task CheckCampaignAsync(SellerModel seller, CampaignBody body, JsonObject cfg)
    {
        if (!cfg.Bool("feature_ads"))
            throw new AppException("Sponsored products are switched off on this marketplace", "ads_off", 400);
        if (body.BidPaise < cfg.Long("ads_min_bid_paise"))
            throw new AppException($"Bid at least ₹{cfg.Long("ads_min_bid_paise") / 100.0:0.00} per click", "bid_too_low", 400);
        if (body.DailyBudgetPaise < cfg.Long("ads_min_daily_budget_paise"))
            throw new AppException($"Set a daily budget of at least ₹{cfg.Long("ads_min_daily_budget_paise") / 100:0}", "budget_too_low", 400);
        var owned = await ads.OwnedApprovedProductIdsAsync(seller.Id, body.ProductIds.Distinct().ToList());
        if (owned.Count != body.ProductIds.Distinct().Count())
            throw new AppException("Choose your own live products", "invalid_products", 400);
    }

    /// <summary>Reference: CampaignIn keywords validator — lowercase, collapse spaces, <= 40 chars, >= 2 chars, unique.</summary>
    private static List<string> CleanKeywords(IEnumerable<string> keywords)
    {
        var outp = new List<string>();
        foreach (var raw in keywords)
        {
            var k = string.Join(' ', raw.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            if (k.Length > 40) k = k[..40];
            if (k.Length >= 2 && !outp.Contains(k)) outp.Add(k);
        }
        return outp;
    }

    public async Task<JsonObject> SellerUpsertAsync(SellerModel seller, UserModel user, CampaignBody body, Guid? campaignId)
    {
        var cfg = await platform.GetAsync();
        var keywords = CleanKeywords(body.Keywords);
        var placements = body.Placements.Distinct().ToList();
        await CheckCampaignAsync(seller, body, cfg);
        var now = DateTimeFunctions.UtcNow();
        var keywordsJson = System.Text.Json.JsonSerializer.Serialize(keywords);
        var placementsJson = System.Text.Json.JsonSerializer.Serialize(placements);
        Guid id;
        await using var uow = await db.BeginAsync();
        if (campaignId is null)
        {
            id = Guid.NewGuid();
            var status = cfg.Bool("ads_need_approval") ? "pending" : "active";
            await ads.InsertCampaignAsync(id, seller.Id, body.Name.Trim(), status, placementsJson, keywordsJson,
                body.BidPaise, body.DailyBudgetPaise, body.TotalBudgetPaise, body.StartsAt ?? now, body.EndsAt, now, uow);
            await ads.SetCampaignProductsAsync(id, body.ProductIds, uow);
            await audit.InsertAsync(new AuditLogModel { ActorUserId = user.Id, Action = "ads.create", EntityType = "ad_campaign", EntityId = id.ToString(), Detail = body.Name.Trim(), CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
        }
        else
        {
            var c = await ads.CampaignForUpdateAsync(campaignId.Value, uow);
            if (c is null || c.SellerId != seller.Id) throw new NotFoundException("Campaign");
            if (c.Status == "ended") throw new ConflictException("This campaign has ended; create a new one");
            var before = (await ads.CampaignProductsAsync([c.Id])).Select(p => p.ProductId).ToHashSet();
            var targetingChanged = !before.SetEquals(body.ProductIds) ||
                System.Text.Json.JsonSerializer.Deserialize<List<string>>(c.KeywordsJson)!.SequenceEqual(keywords) == false;
            var status = c.Status;
            var note = c.Note;
            if (status == "rejected" || (targetingChanged && cfg.Bool("ads_need_approval") && status == "active"))
                (status, note) = ("pending", "");
            await ads.UpdateCampaignAsync(c.Id, body.Name.Trim(), placementsJson, keywordsJson, body.BidPaise, body.DailyBudgetPaise,
                body.TotalBudgetPaise, body.StartsAt ?? c.StartsAt, body.EndsAt, status, note, now, uow);
            await ads.SetCampaignProductsAsync(c.Id, body.ProductIds, uow);
            await audit.InsertAsync(new AuditLogModel { ActorUserId = user.Id, Action = "ads.update", EntityType = "ad_campaign", EntityId = c.Id.ToString(), Detail = body.Name.Trim(), CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
            id = c.Id;
        }
        await uow.CommitAsync();
        return (await CampaignsOutAsync([(await ads.CampaignsForSellerAsync(seller.Id)).First(c => c.Id == id)]))[0];
    }

    public async Task<JsonObject> SellerActionAsync(SellerModel seller, UserModel user, Guid campaignId, string action)
    {
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        var c = await ads.CampaignForUpdateAsync(campaignId, uow);
        if (c is null || c.SellerId != seller.Id) throw new NotFoundException("Campaign");
        string status;
        var note = c.Note;
        if (action == "pause" && c.Status == "active") status = "paused";
        else if (action == "resume" && c.Status == "paused") status = "active";
        else if (action == "end" && c.Status is "pending" or "active" or "paused") { status = "ended"; note = "Ended by the seller"; }
        else throw new AppException($"A {c.Status} campaign cannot be {action}d", "invalid_status", 409);
        await ads.SetCampaignStatusAsync(c.Id, status, note, now, uow);
        await audit.InsertAsync(new AuditLogModel { ActorUserId = user.Id, Action = $"ads.{action}", EntityType = "ad_campaign", EntityId = c.Id.ToString(), Detail = "", CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true, ["status"] = status };
    }

    // ------------------------------------------------------------------ admin

    /// <summary>₹ formatting matching the reference f"{paise/100:,.2f}" (western grouping).</summary>
    private static string Inr(double paise) => (paise / 100).ToString("N2", System.Globalization.CultureInfo.InvariantCulture);

    public async Task<JsonObject> AdminListAsync(UserModel admin, string? status, string q, int page)
    {
        await access.RequireAsync(admin, "marketing");
        var (campaigns, total) = await ads.AdminCampaignsAsync(status, q, (page - 1) * 30, 30);
        var items = await CampaignsOutAsync(campaigns);
        var names = await ads.SellerNamesAsync(campaigns.Select(c => c.SellerId).Distinct().ToList());
        for (var i = 0; i < items.Count; i++)
        {
            items[i]["seller"] = names.GetValueOrDefault(campaigns[i].SellerId, "");
            items[i]["seller_id"] = campaigns[i].SellerId.ToString();
        }
        var since = TodayIst().AddDays(-29);
        var days = (await ads.RevenueByDayAsync(since)).ToList();
        var counts = (await ads.CampaignCountsAsync()).ToDictionary(r => r.Status, r => (JsonNode?)JsonValue.Create(r.N));
        var cfg = await platform.GetAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode)i).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 30,
            ["counts"] = new JsonObject(counts),
            ["rules"] = Rules(cfg),
            ["revenue_30d"] = new JsonObject
            {
                ["impressions"] = days.Sum(d => d.Impressions), ["clicks"] = days.Sum(d => d.Clicks),
                ["invalid_clicks"] = days.Sum(d => d.InvalidClicks), ["spend"] = days.Sum(d => d.Spend),
                ["days"] = new JsonArray(days.Select(d => (JsonNode)new JsonObject
                {
                    ["day"] = d.Day.ToString("yyyy-MM-dd"), ["impressions"] = d.Impressions, ["clicks"] = d.Clicks,
                    ["invalid_clicks"] = d.InvalidClicks, ["spend"] = d.Spend,
                }).ToArray()),
            },
        };
    }

    /// <summary>Reference: ads.bill — post each finished day's spend plus GST to the seller ledger. Returns entries posted.</summary>
    public async Task<int> BillAsync()
    {
        var cfg = await platform.GetAsync();
        var now = DateTimeFunctions.UtcNow();
        var today = TodayIst();
        var posted = 0;
        await using var uow = await db.BeginAsync();
        var rows = await ads.UnbilledAsync(today, uow);
        foreach (var r in rows)
        {
            if (r.Spend > 0)
            {
                var gst = r.Spend * cfg.Long("commission_gst_bps") / 10_000;
                await ads.InsertAdSpendLedgerAsync(r.SellerId, -(r.Spend + gst),
                    $"Sponsored products {r.Day:yyyy-MM-dd}: {r.Clicks} clicks, ₹{Inr(r.Spend)} + GST ₹{Inr(gst)}", now, uow);
                posted++;
            }
            await ads.MarkBilledAsync(r.SellerId, r.Day, uow);
        }
        await uow.CommitAsync();
        return posted;
    }

    public async Task<JsonObject> AdminBillAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "marketing");
        var n = await BillAsync();
        var now = DateTimeFunctions.UtcNow();
        await audit.InsertAsync(new AuditLogModel { ActorUserId = admin.Id, Action = "ads.bill", EntityType = "ads", EntityId = "billing", Detail = $"{n} entries", CreatedAt = now, Id = Guid.NewGuid() });
        return new JsonObject { ["posted"] = n };
    }

    public async Task<JsonObject> AdminActionAsync(UserModel admin, Guid campaignId, string action, string reason)
    {
        await access.RequireAsync(admin, "marketing");
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        var c = await ads.CampaignForUpdateAsync(campaignId, uow);
        if (c is null) throw new NotFoundException("Campaign");
        var allowed = action switch
        {
            "approve" => c.Status == "pending",
            "reject" => c.Status is "pending" or "active" or "paused",
            "pause" => c.Status == "active",
            "resume" => c.Status == "paused",
            "end" => c.Status is "pending" or "active" or "paused",
            _ => false,
        };
        if (!allowed) throw new AppException($"A {c.Status} campaign cannot be {action}d", "invalid_status", 409);
        if (action is "reject" or "end" && reason.Trim().Length < 5)
            throw new AppException("Give the seller a reason (at least 5 characters)", "reason_required", 400);
        var status = action switch
        {
            "approve" => "active", "reject" => "rejected", "pause" => "paused", "resume" => "active", _ => "ended",
        };
        await ads.SetCampaignStatusAsync(c.Id, status, reason.Trim(), now, uow);
        await audit.InsertAsync(new AuditLogModel { ActorUserId = admin.Id, Action = $"ads.{action}", EntityType = "ad_campaign", EntityId = c.Id.ToString(), Detail = reason.Length > 200 ? reason[..200] : reason, CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
        await uow.CommitAsync();
        await notify.NotifySellerAsync(c.SellerId, "listing_update", new Dictionary<string, string>
        {
            ["status"] = $"ad campaign {status}", ["title"] = c.Name,
            ["message"] = reason.Trim().Length > 0 ? reason.Trim() : "Open Advertising in your seller hub for details.",
        }, "/seller/advertising");
        return new JsonObject { ["ok"] = true, ["status"] = status };
    }

    public async Task<JsonObject> SellerReportAsync(SellerModel seller, Guid campaignId, int days)
    {
        var campaigns = (await ads.CampaignsForSellerAsync(seller.Id)).ToList();
        var c = campaigns.FirstOrDefault(x => x.Id == campaignId) ?? throw new NotFoundException("Campaign");
        var since = TodayIst().AddDays(-(days - 1));
        var byDay = await ads.ReportByDayAsync(c.Id, since);
        var byProduct = await ads.ReportByProductAsync(c.Id, since);
        return new JsonObject
        {
            ["days"] = new JsonArray(byDay.Select(d => (JsonNode)new JsonObject
            {
                ["day"] = d.Day.ToString("yyyy-MM-dd"), ["impressions"] = d.Impressions, ["clicks"] = d.Clicks,
                ["invalid_clicks"] = d.InvalidClicks, ["spend"] = d.Spend,
            }).ToArray()),
            ["products"] = new JsonArray(byProduct.Select(p => (JsonNode)new JsonObject
            {
                ["title"] = p.Title, ["impressions"] = p.Impressions, ["clicks"] = p.Clicks,
                ["invalid_clicks"] = p.InvalidClicks, ["spend"] = p.Spend,
            }).ToArray()),
        };
    }
}
