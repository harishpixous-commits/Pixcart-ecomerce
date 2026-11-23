using DAL;
using Model.DomainModel;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Running deals (reference: services/deals.py). While a deal runs, the version's selling price is the deal price,
/// so the cart, checkout, invoices, GST, commission and payouts all work unchanged. sync starts and ends deals;
/// lightning deals also stop when their quantity is sold.
/// </summary>
public class DealsBAL(CatalogSupportDAL support, DealsDAL deals, CatalogDAL catalog, IMySqlDapperHelper db) : Interface.IDealsBAL, Interface.IDealSync
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
}
