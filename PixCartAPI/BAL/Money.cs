namespace BAL;

/// <summary>
/// Money and tax arithmetic (reference: core/money.py). All amounts are integer paise; all rates are basis points.
/// Prices shown to customers are GST-inclusive (B2C display in India), so tax is extracted from the inclusive amount.
/// </summary>
public static class Money
{
    /// <summary>amount * bps / 10000, rounded half-up to the nearest paisa.</summary>
    public static long ApplyBps(long amount, int bps) =>
        (long)Math.Round(amount * (decimal)bps / 10_000m, 0, MidpointRounding.AwayFromZero);

    /// <summary>Splits paise proportionally with the largest-remainder method so the parts add up exactly
    /// (reference: coupons._allocate).</summary>
    public static Dictionary<Guid, long> Allocate(long totalDiscount, IReadOnlyDictionary<Guid, long> weights)
    {
        var baseSum = weights.Values.Sum();
        if (baseSum <= 0 || totalDiscount <= 0) return weights.ToDictionary(kv => kv.Key, _ => 0L);
        var raw = weights.ToDictionary(kv => kv.Key, kv => totalDiscount * (decimal)kv.Value / baseSum);
        var outp = raw.ToDictionary(kv => kv.Key, kv => (long)Math.Floor(kv.Value));
        var left = totalDiscount - outp.Values.Sum();
        foreach (var k in raw.OrderByDescending(kv => kv.Value - Math.Floor(kv.Value)).Select(kv => kv.Key).Take((int)left))
            outp[k] += 1;
        return outp;
    }
}
