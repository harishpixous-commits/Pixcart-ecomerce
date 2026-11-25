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

    /// <summary>A GST-inclusive amount split into taxable value and CGST/SGST or IGST (reference: core/money.py GstSplit).
    /// Invariant: Taxable + Cgst + Sgst + Igst == gross (no paisa is created or lost).</summary>
    public sealed record GstSplit(long Taxable, long Cgst, long Sgst, long Igst)
    {
        public long Tax => Cgst + Sgst + Igst;
    }

    /// <summary>Splits a GST-inclusive amount (reference: split_inclusive_gst).</summary>
    public static GstSplit SplitInclusiveGst(long gross, int gstBps, bool interstate)
    {
        if (gross < 0) throw new ArgumentOutOfRangeException(nameof(gross), "gross must be non-negative");
        var taxable = (long)Math.Round(gross * 10_000m / (10_000m + gstBps), 0, MidpointRounding.AwayFromZero);
        var tax = gross - taxable;
        if (interstate) return new GstSplit(taxable, 0, 0, tax);
        var cgst = tax / 2;
        return new GstSplit(taxable, cgst, tax - cgst, 0);
    }

    /// <summary>Seller payout for one sub-order (reference: core/money.py Settlement): commission GST (18% by
    /// default), TCS (CGST Act s.52) on the net taxable value, TDS (s.194-O) on the gross.</summary>
    public sealed record Settlement(long Commission, long CommissionGst, long Tcs, long Tds, long Payout);

    /// <summary>(reference: compute_settlement).</summary>
    public static Settlement ComputeSettlement(long gross, long taxable, long commission, int commissionGstBps, int tcsBps, int tdsBps)
    {
        var commissionGst = ApplyBps(commission, commissionGstBps);
        var tcs = ApplyBps(taxable, tcsBps);
        var tds = ApplyBps(gross, tdsBps);
        return new Settlement(commission, commissionGst, tcs, tds, gross - commission - commissionGst - tcs - tds);
    }

    /// <summary>₹ formatting for notification text (reference: core/money.py rupees).</summary>
    public static string Rupees(long paise)
    {
        var sign = paise < 0 ? "-" : "";
        var abs = Math.Abs(paise);
        return $"{sign}₹{abs / 100:#,0}.{abs % 100:00}";
    }
}
