namespace DAL;

using System.Text.RegularExpressions;

/// <summary>Live records an uploaded file is compared with (reference: assistant/uploads._live).</summary>
public partial class AssistantQueriesDAL
{
    private sealed class LiveRow
    {
        public string? K1 { get; set; }
        public string? K2 { get; set; }
        public long? N1 { get; set; }
        public long? N2 { get; set; }
        public long? N3 { get; set; }
        public string? S1 { get; set; }
        public string? S2 { get; set; }
    }

    /// <summary>
    /// Reference: uploads._live — normalised key → the live fields of that record, for "orders", "packages", "products",
    /// "payouts", "customers" or "sellers". Money stays in paise. Keys are looked up 1,000 at a time.
    /// </summary>
    public async Task<Dictionary<string, Dictionary<string, object?>>> CompareLiveAsync(string entity, IReadOnlyList<string> keys)
    {
        var outp = new Dictionary<string, Dictionary<string, object?>>();
        for (var i = 0; i < keys.Count; i += 1000)
        {
            var chunk = keys.Skip(i).Take(1000).ToList();
            var ups = chunk.Select(k => k.ToUpperInvariant()).ToList();
            switch (entity)
            {
                case "orders":
                    foreach (var r in await db.QueryAsync<LiveRow>(
                                 "SELECT number AS K1, grand_total AS N1, status AS S1, payment_method AS S2 FROM orders WHERE UPPER(number) IN @ups", new { ups }))
                        outp[r.K1!.ToUpperInvariant()] = new() { ["total"] = r.N1, ["status"] = r.S1, ["payment"] = r.S2 };
                    break;
                case "packages":
                    foreach (var r in await db.QueryAsync<LiveRow>(
                                 "SELECT number AS K1, total AS N1, status AS S1, tracking_number AS S2 FROM sub_orders WHERE UPPER(number) IN @ups", new { ups }))
                        outp[r.K1!.ToUpperInvariant()] = new() { ["total"] = r.N1, ["status"] = r.S1, ["awb"] = r.S2 };
                    break;
                case "products":
                    foreach (var r in await db.QueryAsync<LiveRow>(
                                 "SELECT v.sku AS K1, v.price_paise AS N1, v.mrp_paise AS N2, v.stock AS N3, p.status AS S1 FROM variants v " +
                                 "JOIN products p ON p.id = v.product_id WHERE UPPER(v.sku) IN @ups", new { ups }))
                        outp[r.K1!.ToUpperInvariant()] = new() { ["price"] = r.N1, ["mrp"] = r.N2, ["stock"] = r.N3, ["status"] = r.S1 };
                    break;
                case "payouts":
                    foreach (var r in await db.QueryAsync<LiveRow>(
                                 "SELECT number AS K1, utr AS K2, amount AS N1, status AS S1 FROM payouts WHERE UPPER(number) IN @ups OR UPPER(utr) IN @ups", new { ups }))
                    {
                        var rec = new Dictionary<string, object?> { ["amount"] = r.N1, ["status"] = r.S1, ["utr"] = r.K2 };
                        outp[r.K1!.ToUpperInvariant()] = rec;
                        if (!string.IsNullOrEmpty(r.K2)) outp[r.K2.ToUpperInvariant()] = rec;
                    }
                    break;
                case "customers":
                    var phones = chunk.Select(k => Regex.Replace(k, @"\D", "")).Select(d => d.Length > 10 ? d[^10..] : d).ToList();
                    var emails = chunk.Where(k => k.Contains('@')).Select(k => k.ToLowerInvariant()).ToList();
                    if (emails.Count == 0) emails.Add("\0"); // an empty IN list is not valid SQL
                    foreach (var r in await db.QueryAsync<LiveRow>(
                                 "SELECT u.phone AS K1, u.email AS K2, u.name AS S1, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'placed') AS N1 " +
                                 "FROM users u WHERE u.phone IN @phones OR LOWER(u.email) IN @emails", new { phones, emails }))
                    {
                        var rec = new Dictionary<string, object?> { ["orders"] = r.N1 ?? 0, ["name"] = r.S1 ?? "" };
                        if (!string.IsNullOrEmpty(r.K1)) outp[r.K1] = rec;
                        if (!string.IsNullOrEmpty(r.K2)) outp[r.K2.ToLowerInvariant()] = rec;
                    }
                    break;
                case "sellers":
                    foreach (var r in await db.QueryAsync<LiveRow>(
                                 "SELECT gstin AS K1, status AS S1, display_name AS S2 FROM sellers WHERE UPPER(gstin) IN @ups", new { ups }))
                        outp[(r.K1 ?? "").ToUpperInvariant()] = new() { ["status"] = r.S1, ["store"] = r.S2 };
                    break;
            }
        }
        return outp;
    }
}
