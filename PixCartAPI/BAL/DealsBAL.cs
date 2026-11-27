using DAL;
using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Running deals (reference: services/deals.py). While a deal runs, the version's selling price is the deal price,
/// so the cart, checkout, invoices, GST, commission and payouts all work unchanged. sync starts and ends deals;
/// lightning deals also stop when their quantity is sold.
/// </summary>
public class DealsBAL(CatalogSupportDAL support, DealsDAL deals, CatalogDAL catalog, IMySqlDapperHelper db,
    IPlatformSettingsBAL platform, AuditDAL audit, IAccessBAL access, ICatalogNotifyBAL notify) : Interface.IDealsBAL, Interface.IDealSync
{
    private static DateTime _lastSync = DateTime.MinValue; // monotonic gate, as the reference's _last_sync

    /// <summary>Units still offered at the deal price, for versions with a running lightning deal (one with a quantity).</summary>
    public async Task<Dictionary<Guid, int>> UnitsLeftAsync(IEnumerable<Guid> variantIds)
    {
        var ids = variantIds.Distinct().ToList();
        if (ids.Count == 0) return [];
        var rows = await support.DealQuantitiesAsync(ids);
        return rows.Where(r => r.QtyLimit is not null).ToDictionary(r => r.VariantId, r => Math.Max(0, r.QtyLimit!.Value - r.SoldQty));
    }

    /// <summary>Start due deals and end finished ones (reference: sync). Commits its own unit of work; returns how
    /// many deals changed.</summary>
    public async Task<int> SyncAsync(bool force = false)
    {
        if (!force && (DateTime.UtcNow - _lastSync).TotalSeconds < 10) return 0;
        _lastSync = DateTime.UtcNow;
        var now = DateTime.UtcNow;
        var changed = 0;
        await using var uow = await db.BeginAsync();
        foreach (var d in await deals.ActiveEndedAsync(now, uow))
        {
            await EndAsync(d, "The deal time is over", uow);
            changed++;
        }
        changed += await deals.EndMissedApprovedAsync(now, uow);
        foreach (var d in await deals.DueToStartAsync(now, uow))
        {
            await StartAsync(d, uow);
            changed++;
        }
        await uow.CommitAsync();
        return changed;
    }

    /// <summary>Called while an order is placed (the version rows are already locked): counts units sold at the deal
    /// price and ends a lightning deal when its quantity is gone (reference: record_sale). Runs in the order's unit
    /// of work.</summary>
    public async Task RecordSaleAsync(Guid variantId, int qty, IUnitOfWork uow)
    {
        var d = await deals.ActiveDealForUpdateAsync(variantId, uow);
        if (d is null) return;
        d.SoldQty += qty;
        if (d.QtyLimit is not null && d.SoldQty >= d.QtyLimit)
            await EndAsync(d, "All deal units were claimed", uow);
        else
            await deals.UpdateDealAsync(d, uow);
    }

    /// <summary>Reference: deals._start. A deal whose product is no longer on sale, or whose price is already at or
    /// below the deal price, ends instead of starting.</summary>
    private async Task StartAsync(DealModel d, IUnitOfWork uow)
    {
        var v = await deals.VariantForUpdateAsync(d.VariantId, uow);
        var p = await deals.GetProductAsync(d.ProductId, uow);
        if (v is null || !v.IsActive || p is null || p.Status != "approved")
        {
            d.Status = "ended";
            d.Note = "The product was not on sale when the deal was due to start";
        }
        else if (d.DealPricePaise >= v.PricePaise)
        {
            d.Status = "ended";
            d.Note = "The selling price was already at or below the deal price";
        }
        else
        {
            d.RegularPricePaise = v.PricePaise;
            await deals.SetVariantPriceAsync(v.Id, d.DealPricePaise, uow);
            d.Status = "active";
            await catalog.RefreshAggregatesAsync(p.Id, uow);
        }
        await deals.UpdateDealAsync(d, uow);
    }

    /// <summary>Reference: deals._end. Restores the version's regular price when the deal price is still showing.</summary>
    private async Task EndAsync(DealModel d, string note, IUnitOfWork uow, string status = "ended")
    {
        var v = await deals.VariantForUpdateAsync(d.VariantId, uow);
        if (d.Status == "active" && v is not null && d.RegularPricePaise is { } regular && v.PricePaise == d.DealPricePaise)
            await deals.SetVariantPriceAsync(v.Id, Math.Min(regular, v.MrpPaise), uow);
        d.Status = status;
        d.Note = note.Length > 300 ? note[..300] : note;
        await deals.UpdateDealAsync(d, uow);
        var p = await deals.GetProductAsync(d.ProductId, uow);
        if (p is not null) await catalog.RefreshAggregatesAsync(p.Id, uow);
    }

    /// <summary>A version row locked inside the order's transaction.</summary>
    public Task<VariantModel?> VariantForUpdateAsync(Guid variantId, IUnitOfWork uow) =>
        deals.VariantForUpdateAsync(variantId, uow);

    /// <summary>Units bought at a still-running deal's price came back (the order was cancelled or never paid):
    /// they are on offer at the deal price again (reference: deals.release_sale).</summary>
    public async Task ReleaseSaleAsync(Guid variantId, int qty, long unitPrice, IUnitOfWork uow)
    {
        var d = await deals.ActiveDealForUpdateAsync(variantId, uow);
        if (d is null || unitPrice != d.DealPricePaise) return;
        d.SoldQty = Math.Max(0, d.SoldQty - qty);
        await deals.UpdateDealAsync(d, uow);
    }

    // ------------------------------------------------------------------ seller / admin surfaces

    /// <summary>Reference: deals.KINDS.</summary>
    public static readonly IReadOnlyDictionary<string, string> Kinds = new Dictionary<string, string>
    {
        ["lightning"] = "Lightning deal", ["deal_of_day"] = "Deal of the Day", ["limited"] = "Limited time deal",
    };

    /// <summary>Reference: routers/promotions.py _rules (deal feature rules for the forms).</summary>
    public static JsonObject Rules(JsonObject cfg) => new()
    {
        ["enabled"] = cfg.Bool("feature_deals"), ["need_approval"] = cfg.Bool("deals_need_approval"),
        ["min_discount_pct"] = cfg.Int("deal_min_discount_pct"),
        ["max_hours_lightning"] = cfg.Int("deal_max_hours_lightning"), ["max_hours_day"] = cfg.Int("deal_max_hours_day"),
        ["max_days_limited"] = cfg.Int("deal_max_days_limited"),
        ["kinds"] = new JsonObject(Kinds.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
    };

    /// <summary>Reference: deals._rules — how long each kind may run.</summary>
    private static TimeSpan MaxRun(JsonObject cfg, string kind) => kind switch
    {
        "lightning" => TimeSpan.FromHours(cfg.Int("deal_max_hours_lightning")),
        "deal_of_day" => TimeSpan.FromHours(cfg.Int("deal_max_hours_day")),
        _ => TimeSpan.FromDays(cfg.Int("deal_max_days_limited")),
    };

    private async Task<List<JsonObject>> DealRowsAsync(IEnumerable<DealsDAL.DealListRow> rows)
    {
        var list = rows.ToList();
        var imgs = await catalog.ImagesForAsync(list.Select(r => r.ProductId).Distinct());
        return list.Select(d => DealRow(d, imgs)).ToList();
    }

    /// <summary>Reference: deals.deal_rows one row.</summary>
    private static JsonObject DealRow(DealsDAL.DealListRow d, Dictionary<Guid, List<string>> imgs)
    {
        var regular = d.RegularPricePaise ?? d.VariantPrice;
        return new JsonObject
        {
            ["id"] = d.Id.ToString(), ["kind"] = d.Kind, ["kind_label"] = Kinds.GetValueOrDefault(d.Kind, d.Kind),
            ["status"] = d.Status, ["note"] = d.Note,
            ["product"] = d.ProductTitle, ["slug"] = d.ProductSlug, ["product_id"] = d.ProductId.ToString(),
            ["variant_id"] = d.VariantId.ToString(), ["variant"] = ProductInfo.VariantLabel(d.VariantOptions),
            ["image"] = imgs.GetValueOrDefault(d.ProductId)?.FirstOrDefault() ?? "", ["stock"] = d.VariantStock,
            ["seller"] = d.SellerName, ["seller_id"] = d.SellerId.ToString(),
            ["deal_price"] = d.DealPricePaise, ["regular_price"] = regular, ["mrp"] = d.VariantMrp,
            ["discount_pct"] = d.VariantMrp > 0 ? (long)Math.Round(100.0 * (d.VariantMrp - d.DealPricePaise) / d.VariantMrp) : 0,
            ["starts_at"] = DateTimeFunctions.Iso(d.StartsAt), ["ends_at"] = DateTimeFunctions.Iso(d.EndsAt),
            ["qty_limit"] = d.QtyLimit, ["sold_qty"] = d.SoldQty,
            ["created_at"] = DateTimeFunctions.Iso(d.CreatedAt),
        };
    }

    /// <summary>Reference: seller_deals.</summary>
    public async Task<JsonObject> SellerListAsync(SellerModel seller, string? status)
    {
        await SyncAsync();
        var items = await DealRowsAsync(await deals.SellerDealsAsync(seller.Id, status));
        var counts = await deals.DealStatusCountsAsync(seller.Id);
        var cfg = await platform.GetAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode)i).ToArray()),
            ["counts"] = new JsonObject(counts.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
            ["rules"] = Rules(cfg),
        };
    }

    /// <summary>Reference: seller_deal_options.</summary>
    public async Task<JsonObject> SellerOptionsAsync(SellerModel seller, string q)
    {
        var products = (await deals.SellerLiveProductsAsync(seller.Id, q)).ToList();
        var imgs = await catalog.ImagesForAsync(products.Select(p => p.Id));
        var variants = (await deals.ActiveVariantsForAsync(products.Select(p => p.Id).ToList()))
            .GroupBy(v => v.ProductId).ToDictionary(g => g.Key, g => g.ToList());
        var busy = await deals.ActiveVariantIdsAsync(variants.Values.SelectMany(v => v).Select(v => v.Id).ToList());
        return new JsonObject
        {
            ["products"] = new JsonArray(products.Where(p => variants.ContainsKey(p.Id)).Select(p => (JsonNode)new JsonObject
            {
                ["id"] = p.Id.ToString(), ["title"] = p.Title,
                ["image"] = imgs.GetValueOrDefault(p.Id)?.FirstOrDefault() ?? "",
                ["variants"] = new JsonArray(variants[p.Id].Select(v => (JsonNode)new JsonObject
                {
                    ["id"] = v.Id.ToString(), ["label"] = ProductInfo.VariantLabel(v.Options) is { Length: > 0 } l ? l : "Single version",
                    ["price"] = v.PricePaise, ["mrp"] = v.MrpPaise, ["stock"] = v.Stock, ["in_deal"] = busy.Contains(v.Id),
                }).ToArray()),
            }).ToArray()),
        };
    }

    /// <summary>Reference: deals.create (+ seller_create_deal). Returns the created deal's id.</summary>
    public async Task<Guid> CreateAsync(SellerModel seller, UserModel user, Guid variantId, string kind, long dealPrice,
        DateTime startsAt, DateTime endsAt, int? qtyLimit)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_deals"))
            throw new AppException("Deals are switched off on this marketplace", "deals_off", 400);
        if (!Kinds.ContainsKey(kind))
            throw new AppException("Choose the kind of deal", "invalid_kind", 400);
        var v = await deals.VariantAsync(variantId);
        if (v is null || v.SellerId != seller.Id)
            throw new AppException("Choose one of your product versions", "invalid_variant", 400);
        var p = await catalog.GetProductAsync(v.ProductId);
        if (p is null || p.Status != "approved" || !v.IsActive)
            throw new AppException("Deals can only run on live products", "not_live", 400);
        var now = DateTimeFunctions.UtcNow();
        if (startsAt < now.AddMinutes(-5))
            throw new AppException("The deal cannot start in the past", "invalid_window", 400);
        if (endsAt <= startsAt)
            throw new AppException("The deal must end after it starts", "invalid_window", 400);
        var max = MaxRun(cfg, kind);
        if (endsAt - startsAt > max)
        {
            var text = max < TimeSpan.FromDays(2) ? $"{(int)max.TotalHours} hours" : $"{max.Days} days";
            throw new AppException($"A {Kinds[kind].ToLower()} can run for at most {text}", "too_long", 400);
        }
        var maxPrice = v.PricePaise * (100 - cfg.Int("deal_min_discount_pct")) / 100;
        if (dealPrice > maxPrice)
            throw new AppException(
                FormattableString.Invariant($"The deal price must be at least {cfg.Int("deal_min_discount_pct")}% below the selling price (₹{maxPrice / 100.0:N2} or less)"),
                "discount_too_small", 400);
        if (kind == "lightning")
        {
            if (qtyLimit is null or < 1)
                throw new AppException("A lightning deal needs the number of units offered", "qty_required", 400);
            if (qtyLimit > v.Stock)
                throw new AppException($"You have {v.Stock} in stock; offer at most that many units", "qty_above_stock", 400);
        }
        else qtyLimit = qtyLimit ?? null;
        if (await deals.OverlapExistsAsync(v.Id, startsAt, endsAt, now))
            throw new AppException("This version already has a deal at that time", "deal_overlap", 409);
        var d = new DealModel
        {
            Id = Guid.NewGuid(), SellerId = seller.Id, ProductId = p.Id, VariantId = v.Id, Kind = kind,
            DealPricePaise = dealPrice, StartsAt = startsAt, EndsAt = endsAt, QtyLimit = qtyLimit, SoldQty = 0,
            Status = cfg.Bool("deals_need_approval") ? "pending" : "approved", Note = "", CreatedAt = now, UpdatedAt = now,
        };
        await using (var uow = await db.BeginAsync())
        {
            await deals.InsertDealAsync(d, uow);
            await audit.InsertAsync(new AuditLogModel { ActorUserId = user.Id, Action = "deal.create", EntityType = "deal", EntityId = d.Id.ToString(), Detail = $"{kind} at {dealPrice}", CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
            await uow.CommitAsync();
        }
        await SyncAsync(force: true);
        return d.Id;
    }

    /// <summary>Reference: seller_cancel_deal.</summary>
    public async Task SellerCancelAsync(SellerModel seller, UserModel user, Guid dealId)
    {
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        var d = await deals.DealForUpdateAsync(dealId, uow);
        if (d is null || d.SellerId != seller.Id) throw new NotFoundException("Deal");
        await CancelAsync(d, "Cancelled by the seller", uow);
        await audit.InsertAsync(new AuditLogModel { ActorUserId = user.Id, Action = "deal.cancel", EntityType = "deal", EntityId = d.Id.ToString(), CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
        await uow.CommitAsync();
    }

    /// <summary>Reference: deals.cancel.</summary>
    private async Task CancelAsync(DealModel d, string note, IUnitOfWork uow)
    {
        if (d.Status is not ("pending" or "approved" or "active"))
            throw new AppException($"A {d.Status} deal cannot be cancelled", "invalid_status", 409);
        await EndAsync(d, note, uow, status: "cancelled");
    }

    /// <summary>Reference: admin_deals.</summary>
    public async Task<JsonObject> AdminListAsync(UserModel admin, string? status, string q, int page)
    {
        await access.RequireAsync(admin, "catalog");
        await SyncAsync();
        var (rows, total) = await deals.AdminDealsAsync(status, q, (page - 1) * 30, 30);
        var items = await DealRowsAsync(rows);
        var counts = await deals.DealStatusCountsAsync(null);
        var cfg = await platform.GetAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode)i).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 30,
            ["counts"] = new JsonObject(counts.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
            ["rules"] = Rules(cfg),
        };
    }

    private static readonly TimeSpan IstOffset = TimeSpan.FromMinutes(330);

    /// <summary>Reference: admin_deal_action.</summary>
    public async Task<JsonObject> AdminActionAsync(UserModel admin, Guid dealId, string action, string reason)
    {
        await access.RequireAsync(admin, "catalog");
        var now = DateTimeFunctions.UtcNow();
        Guid sellerId;
        string title;
        string status;
        string message;
        await using (var uow = await db.BeginAsync())
        {
            var d = await deals.DealForUpdateAsync(dealId, uow);
            if (d is null) throw new NotFoundException("Deal");
            var p = await deals.GetProductAsync(d.ProductId, uow);
            if (action == "approve")
            {
                if (d.Status != "pending") throw new AppException($"A {d.Status} deal cannot be approved", "invalid_status", 409);
                if (d.EndsAt <= now) throw new AppException("This deal's time has already passed", "expired", 409);
                d.Status = "approved";
                d.Note = "";
                message = $"Your {Kinds[d.Kind].ToLower()} was approved. It runs from {(d.StartsAt + IstOffset):dd MMM, hh:mm tt}.";
            }
            else if (action == "reject")
            {
                if (d.Status != "pending") throw new AppException($"A {d.Status} deal cannot be rejected", "invalid_status", 409);
                if (reason.Trim().Length < 5)
                    throw new AppException("Give the seller a reason (at least 5 characters)", "reason_required", 400);
                d.Status = "rejected";
                d.Note = reason.Trim();
                message = $"Your deal was not approved: {d.Note}";
            }
            else
            {
                if (reason.Trim().Length < 5)
                    throw new AppException("Give the seller a reason (at least 5 characters)", "reason_required", 400);
                await CancelAsync(d, $"Stopped by the marketplace: {reason.Trim()}", uow);
                message = d.Note;
            }
            if (action != "cancel") await deals.UpdateDealAsync(d, uow);
            await audit.InsertAsync(new AuditLogModel { ActorUserId = admin.Id, Action = $"deal.{action}", EntityType = "deal", EntityId = d.Id.ToString(), Detail = reason.Length > 200 ? reason[..200] : reason, CreatedAt = now, Id = Guid.NewGuid() }, uow.Transaction);
            sellerId = d.SellerId;
            title = p?.Title ?? "";
            status = d.Status;
            await uow.CommitAsync();
        }
        await notify.NotifySellerAsync(sellerId, "listing_update", new Dictionary<string, string>
        {
            ["status"] = $"deal {status}", ["title"] = title, ["message"] = message,
        }, "/seller/deals");
        await SyncAsync(force: true);
        return new JsonObject { ["ok"] = true, ["status"] = status };
    }
}
