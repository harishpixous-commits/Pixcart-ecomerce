using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using DAL;
using Model.DomainModel;
using Utils;
namespace BAL;

/// <summary>CSV round trip for bulk edit (mirror of services/bulk_edit.py export_csv / apply_csv): download your versions, edit price (rupees),
/// stock and active in a spreadsheet, upload the file. A blank cell means leave it. Rows are checked on their own; dry_run only previews.</summary>
public partial class SellerProductsBAL
{
    public const int BulkCsvMaxBytes = 1024 * 1024;

    private async Task<JsonObject> BulkCfgAsync()
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var cfg = (JsonObject)SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["bulk_edit"]!;
        if (cfg["enabled"]?.GetValue<bool>() != true) throw new AppException("Bulk edit is switched off by the marketplace", "bulk_edit_off", 400);
        return cfg;
    }

    private static string CsvSafe(string t) => t.Length > 0 && "=+-@".Contains(t[0]) ? "'" + t : t;
    private static string BulkCell(string t) => t.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + t.Replace("\"", "\"\"") + "\"" : t;

    public async Task<string> BulkEditCsvExportAsync(SellerModel s)
    {
        var max = int.Parse((await BulkCfgAsync())["max_rows"]!.ToString());
        var rows = await db.QueryAsync<(Guid Id, string Sku, string Title, long Price, int Stock, bool Active)>(
            "SELECT v.id AS Id, v.sku AS Sku, p.title AS Title, v.price_paise AS Price, v.stock AS Stock, v.is_active AS Active FROM variants v JOIN products p ON p.id=v.product_id WHERE v.seller_id=@sid ORDER BY p.title, v.sku LIMIT @max", new { sid = s.Id, max });
        var sb = new StringBuilder("id,sku,product,price,stock,active\r\n");
        foreach (var r in rows) sb.Append($"{r.Id},{BulkCell(CsvSafe(r.Sku))},{BulkCell(CsvSafe(r.Title))},{(r.Price / 100m).ToString("0.00", CultureInfo.InvariantCulture)},{r.Stock},{(r.Active ? "yes" : "no")}\r\n");
        return sb.ToString();
    }

    private static List<List<string>> ParseCsv(string text)
    {
        var rows = new List<List<string>>(); var row = new List<string>(); var cell = new StringBuilder(); bool q = false;
        for (int i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (q) { if (c == '"') { if (i + 1 < text.Length && text[i + 1] == '"') { cell.Append('"'); i++; } else q = false; } else cell.Append(c); }
            else if (c == '"') q = true;
            else if (c == ',') { row.Add(cell.ToString()); cell.Clear(); }
            else if (c is '\r' or '\n') { if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++; row.Add(cell.ToString()); cell.Clear(); if (row.Count > 1 || row[0].Length > 0) rows.Add(row); row = new(); }
            else cell.Append(c);
        }
        if (cell.Length > 0 || row.Count > 0) { row.Add(cell.ToString()); if (row.Count > 1 || row[0].Length > 0) rows.Add(row); }
        return rows;
    }

    public async Task<JsonObject> BulkEditCsvApplyAsync(UserModel user, SellerModel s, byte[] data, string filename, bool dryRun)
    {
        if (s.Status == "suspended") throw new ConflictException("Your seller account is suspended", "seller_suspended");
        var cfg = await BulkCfgAsync();
        var max = int.Parse(cfg["max_rows"]!.ToString());
        if (data.Length > BulkCsvMaxBytes) throw new AppException("File is too large (1 MB max)", "file_too_large", 400);
        string text;
        try { text = new UTF8Encoding(false, true).GetString(data).TrimStart('\uFEFF'); }
        catch (ArgumentException) { throw new AppException("Save the file as CSV (UTF-8)", "invalid_file", 400); }
        var table = ParseCsv(text);
        var head = table.Count > 0 ? table[0].Select(h => h.Trim().ToLowerInvariant()).ToList() : [];
        if (!head.Intersect(["id", "sku"]).Any() || !head.Intersect(["price", "stock", "active"]).Any()) throw new AppException("The file needs an id or sku column and at least one of price, stock, active", "invalid_file", 400);
        var body = table.Skip(1).ToList();
        if (body.Count < 1 || body.Count > max) throw new AppException($"The file needs between 1 and {max} rows", "invalid_rows", 400);
        string Cell(List<string> r, string name) { var i = head.IndexOf(name); return i >= 0 && i < r.Count ? r[i].Trim() : ""; }

        await using var tx = await db.BeginAsync();
        await rateLimit.RateLimitAsync($"bulk-edit-csv:{s.Id}", 60, 3600, tx);
        var found = new Dictionary<Guid, VariantModel>();
        // A row with no id is matched on its SKU, among this seller's own versions (a SKU shared by two versions is refused).
        var skuHit = new Dictionary<int, List<Guid>>();
        for (var k = 0; k < body.Count; k++)
            if (Cell(body[k], "id") == "" && Cell(body[k], "sku") != "")
                skuHit[k] = (await tx.QueryAsync<Guid>("SELECT id FROM variants WHERE seller_id = @sid AND LOWER(sku) = @sku LIMIT 2", new { sid = s.Id, sku = Cell(body[k], "sku").TrimStart('\'').ToLowerInvariant() })).ToList();
        string IdOf(int k) => skuHit.TryGetValue(k, out var h) && h.Count == 1 ? h[0].ToString() : Cell(body[k], "id");
        for (var k = 0; k < body.Count; k++) if (Guid.TryParse(IdOf(k), out var g) && !found.ContainsKey(g) && await dal.VariantAsync(s.Id, g, tx) is { } v) found[g] = v;
        var busy = await deals.ActiveVariantIdsAsync(found.Keys.ToList());
        var rows = new JsonArray(); int changed = 0, n = 1; var seen = new HashSet<Guid>(); var touched = new HashSet<Guid>();
        foreach (var r in body)
        {
            n++;
            var ri = n - 2; var bySku = Cell(r, "id") == "" && Cell(r, "sku") != "";
            var item = new JsonObject { ["row"] = n, ["id"] = IdOf(ri), ["sku"] = null, ["ok"] = false, ["reason"] = null, ["changes"] = new JsonObject() };
            rows.Add(item);
            if (bySku && skuHit[ri].Count > 1) { item["reason"] = "ambiguous_sku"; continue; }
            if (!Guid.TryParse(IdOf(ri), out var vid)) { item["reason"] = bySku ? "unknown_sku" : "bad_id"; continue; }
            item["id"] = vid.ToString();
            if (!found.TryGetValue(vid, out var v)) { item["reason"] = "not_yours"; continue; }
            item["sku"] = v.Sku;
            if (!seen.Add(vid)) { item["reason"] = "duplicate_row"; continue; }
            string? reason = null; var ch = (JsonObject)item["changes"]!; long? newPrice = null; int? newStock = null; bool? newActive = null;
            var ps = Cell(r, "price");
            if (ps != "")
            {
                if (!decimal.TryParse(ps.Replace(",", ""), NumberStyles.Number, CultureInfo.InvariantCulture, out var rupees)) reason ??= "bad_number";
                else
                {
                    var paise = (long)Math.Round(rupees * 100, MidpointRounding.ToEven);
                    if (paise != v.PricePaise)
                    {
                        newPrice = paise; ch["price"] = new JsonObject { ["before"] = v.PricePaise, ["after"] = paise };
                        if (busy.Contains(vid)) reason ??= "deal_running"; else if (paise < 1 || paise > v.MrpPaise) reason ??= "price_out_of_range";
                    }
                }
            }
            var ss = Cell(r, "stock");
            if (ss != "")
            {
                if (!int.TryParse(ss, NumberStyles.Integer, CultureInfo.InvariantCulture, out var qty)) reason ??= "bad_number";
                else
                {
                    if (qty < 0 || qty > 1_000_000) reason ??= "stock_out_of_range";
                    if (qty != v.Stock) { newStock = qty; ch["stock"] = new JsonObject { ["before"] = v.Stock, ["after"] = qty }; }
                }
            }
            var ac = Cell(r, "active").ToLowerInvariant();
            if (ac != "")
            {
                if (ac is not ("yes" or "no" or "true" or "false" or "1" or "0")) reason ??= "bad_active";
                else { var flag = ac is "yes" or "true" or "1"; if (flag != v.IsActive) { newActive = flag; ch["active"] = new JsonObject { ["before"] = v.IsActive, ["after"] = flag }; } }
            }
            if (reason is null && newPrice is null && newStock is null && newActive is null) reason = "no_change";
            item["reason"] = reason;
            if (reason is not null) continue;
            item["ok"] = true; changed++;
            if (dryRun) continue;
            if (newPrice is { } np) v.PricePaise = np;
            if (newActive is { } na) v.IsActive = na;
            if (newStock is { } nq)
            {
                var wh = await inventory.DefaultWarehouseAsync(s, uow: tx);
                if (wh is null) { await inventory.SetVariantStockAsync(v.Id, nq, tx); v.Stock = nq; }
                else await inventory.SetQuantityAsync(v, wh.Id, Math.Max(0, nq - await dal.OtherStockAsync(v.Id, wh.Id, tx)), null, "Bulk edit (CSV)", tx);
            }
            await dal.SaveVariantAsync(v, tx); touched.Add(v.ProductId);
        }
        if (!dryRun)
        {
            foreach (var pid in touched) await catalog.RefreshAggregatesAsync(pid, tx);
            if (changed > 0) await audit.AuditAsync(user, "variant.bulk_edit_csv", "seller", s.Id.ToString(), $"x{changed} from {filename}", tx);
        }
        await tx.CommitAsync();
        return new JsonObject { ["dry_run"] = dryRun, ["changed"] = changed, ["skipped"] = rows.Count - changed, ["rows"] = rows };
    }
}
