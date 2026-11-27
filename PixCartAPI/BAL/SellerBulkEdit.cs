using System.Text.Json.Nodes;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;

/// <summary>Bulk edit of a seller's versions (mirror of services/bulk_edit.py): price by percent, stock, on/off. Off or capped by
/// Admin → Growth → Bulk edit. Each row is checked alone; rows that cannot change are skipped with a reason. dry_run only previews.</summary>
public partial class SellerProductsBAL
{
    public static readonly string[] BulkActions = ["price_percent", "stock_set", "stock_add", "activate", "deactivate"];

    public async Task<JsonObject> BulkEditAsync(UserModel user, SellerModel s, List<Guid> ids, string action, int? value, bool dryRun)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["bulk_edit"]!;
        if (cfg["enabled"]?.GetValue<bool>() != true) throw new AppException("Bulk edit is switched off by the marketplace", "bulk_edit_off", 400);
        var max = int.Parse(cfg["max_rows"]!.ToString());
        ids = ids.Distinct().ToList();
        if (ids.Count < 1 || ids.Count > max) throw new AppException($"Choose between 1 and {max} versions", "invalid_rows", 400);
        if (!BulkActions.Contains(action)) throw new AppException("Unknown bulk action", "invalid_action", 400);
        if (action is "price_percent" or "stock_set" or "stock_add" && value is null) throw new AppException("This action needs a number", "value_required", 400);
        if (action == "price_percent" && value is < -90 or > 500) throw new AppException("Price change must be between -90% and +500%", "invalid_value", 400);
        if (action == "stock_set" && value is < 0 or > 1_000_000) throw new AppException("Stock must be between 0 and 1,000,000", "invalid_value", 400);
        var rows = new JsonArray(); int changed = 0;
        await using var tx = await db.BeginAsync();
        var found = new Dictionary<Guid, VariantModel>();
        foreach (var id in ids) if (await dal.VariantAsync(s.Id, id, tx) is { } v) found[id] = v;
        var busy = action == "price_percent" ? await deals.ActiveVariantIdsAsync(found.Keys.ToList()) : [];
        var touched = new HashSet<Guid>();
        foreach (var id in ids)
        {
            if (!found.TryGetValue(id, out var v)) { rows.Add(new JsonObject { ["id"] = id.ToString(), ["sku"] = null, ["ok"] = false, ["reason"] = "not_yours" }); continue; }
            long before, after; string? reason = null;
            if (action == "price_percent")
            {
                before = v.PricePaise; after = (long)Math.Round(v.PricePaise * (100 + value!.Value) / 100.0, MidpointRounding.AwayFromZero);
                if (busy.Contains(v.Id)) reason = "deal_running"; else if (after < 1 || after > v.MrpPaise) reason = "price_out_of_range";
            }
            else if (action is "stock_set" or "stock_add")
            {
                before = v.Stock; after = action == "stock_set" ? value!.Value : v.Stock + value!.Value;
                if (after < 0 || after > 1_000_000) reason = "stock_out_of_range";
            }
            else { before = v.IsActive ? 1 : 0; after = action == "activate" ? 1 : 0; }
            var ok = reason is null && before != after;
            rows.Add(new JsonObject { ["id"] = id.ToString(), ["sku"] = v.Sku, ["ok"] = ok, ["reason"] = reason ?? (before == after ? "no_change" : null), ["before"] = action is "activate" or "deactivate" ? before == 1 : before, ["after"] = action is "activate" or "deactivate" ? after == 1 : after });
            if (!ok) continue;
            changed++;
            if (dryRun) continue;
            if (action == "price_percent") v.PricePaise = after;
            else if (action is "activate" or "deactivate") v.IsActive = after == 1;
            else
            {
                var wh = await inventory.DefaultWarehouseAsync(s, uow: tx);
                if (wh is null) { await inventory.SetVariantStockAsync(v.Id, (int)after, tx); v.Stock = (int)after; }
                else await inventory.SetQuantityAsync(v, wh.Id, Math.Max(0, (int)after - await dal.OtherStockAsync(v.Id, wh.Id, tx)), null, "Bulk edit", tx);
            }
            await dal.SaveVariantAsync(v, tx); touched.Add(v.ProductId);
        }
        if (!dryRun)
        {
            foreach (var pid in touched) await catalog.RefreshAggregatesAsync(pid, tx);
            if (changed > 0) await audit.AuditAsync(user, "variant.bulk_edit", "seller", s.Id.ToString(), $"{action} {value} x{changed}", tx);
        }
        await tx.CommitAsync();
        return new JsonObject { ["dry_run"] = dryRun, ["changed"] = changed, ["skipped"] = rows.Count - changed, ["rows"] = rows };
    }
}
