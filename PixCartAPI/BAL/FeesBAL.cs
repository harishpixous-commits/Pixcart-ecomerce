/*
 * Customer fees and the bill at checkout (Admin -> Checkout and fees). Stored in platform_settings["checkout"].
 * Port of the reference services/fees.py: same keys, defaults, limits, messages and fee maths, so the rebuilt API
 * answers exactly like the live one. The marketplace's own fees (handling, small cart, platform, bad weather, late
 * night) include GST at fees_gst_bps; delivery and COD fees belong to the seller's package.
 */

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DAL;
using Utils;

namespace BAL;

public partial class FeesBAL(SettingsDAL settings) : Interface.IFeesBAL
{
    public const string Key = "checkout";
    public static readonly string[] FeeCodes = ["handling", "small_cart", "platform", "surge", "late_night"];
    public const int SurgeHoursMax = 72;
    private static readonly TimeZoneInfo Ist = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");

    public static JsonObject Defaults() => new()
    {
        ["delivery_label"] = "Delivery fee",
        ["delivery_info"] = "Charged for each seller's package. Free when your items from that seller reach the free-delivery amount.",
        ["handling_enabled"] = false,
        ["handling_paise"] = 0,
        ["handling_list_paise"] = 0,        // shown struck through when higher than the fee (a discounted fee)
        ["handling_free_above_paise"] = 0,  // 0 = always charged
        ["handling_label"] = "Handling fee",
        ["handling_info"] = "Covers careful packing and handling of your order.",
        ["small_cart_enabled"] = false,
        ["small_cart_paise"] = 0,
        ["small_cart_below_paise"] = 9900,  // charged when the item total is below this
        ["small_cart_label"] = "Small cart fee",
        ["small_cart_info"] = "Small orders cost more to pack and deliver.",
        ["platform_enabled"] = false,
        ["platform_paise"] = 0,
        ["platform_label"] = "Platform fee",
        ["platform_info"] = "Helps us run the store and keep improving it.",
        ["surge_enabled"] = false,          // bad weather or very high demand
        ["surge_paise"] = 0,
        ["surge_until"] = "",               // switches itself off at this moment (UTC, ISO 8601); empty = until staff switch it off
        ["surge_label"] = "Bad weather fee",
        ["surge_info"] = "Charged during heavy rain or very high demand, when deliveries take longer and cost more.",
        ["late_night_enabled"] = false,
        ["late_night_paise"] = 0,
        ["late_night_from"] = "23:00",      // India time, 24-hour clock; the window may run past midnight
        ["late_night_to"] = "06:00",
        ["late_night_label"] = "Late night fee",
        ["late_night_info"] = "Orders placed late at night cost more to pack and deliver.",
        ["fees_gst_bps"] = 1800,            // GST included in the marketplace's own fees
        ["fees_sac_code"] = "998599",       // SAC on the marketplace's tax invoice for its fees (other support services)
        ["fee_invoice_prefix"] = "MKT",     // that invoice's number series: MKT/26-27/000001
        ["fees_refund_on_cancel"] = true,   // refunded when every package of the order is cancelled
        ["tip_enabled"] = false,
        ["tip_presets"] = new JsonArray(1000, 2000, 3000),
        ["tip_max_paise"] = 50000,
        ["gstin_enabled"] = true,           // "Add GSTIN" for business purchases (the GSTIN goes on the tax invoices)
        ["instructions_enabled"] = true,    // delivery instructions for the delivery partner or courier
        ["no_bag_enabled"] = false,         // "I don't need a bag"
        ["cancellation_note"] = "You can cancel until your order is shipped. After delivery, use returns if the product allows them.",
    };

    private static readonly IReadOnlyDictionary<string, (int Lo, int Hi)> Ints = new Dictionary<string, (int, int)>
    {
        ["handling_paise"] = (0, 100_000), ["handling_list_paise"] = (0, 100_000), ["handling_free_above_paise"] = (0, 100_000_000),
        ["small_cart_paise"] = (0, 100_000), ["small_cart_below_paise"] = (0, 10_000_000), ["platform_paise"] = (0, 100_000),
        ["fees_gst_bps"] = (0, 2800), ["tip_max_paise"] = (0, 500_000), ["surge_paise"] = (0, 100_000), ["late_night_paise"] = (0, 100_000),
    };
    private static readonly IReadOnlyDictionary<string, int> Texts = new Dictionary<string, int>
    {
        ["delivery_label"] = 40, ["delivery_info"] = 300, ["handling_label"] = 40, ["handling_info"] = 300, ["small_cart_label"] = 40,
        ["small_cart_info"] = 300, ["platform_label"] = 40, ["platform_info"] = 300, ["surge_label"] = 40, ["surge_info"] = 300,
        ["late_night_label"] = 40, ["late_night_info"] = 300, ["cancellation_note"] = 600,
    };
    private static readonly string[] Times = ["late_night_from", "late_night_to"];
    private static readonly IReadOnlyDictionary<string, (Regex Re, string Message)> Codes = new Dictionary<string, (Regex, string)>
    {
        ["fees_sac_code"] = (SacRe(), "The SAC code is 4 to 8 digits, like 998599"),
        ["fee_invoice_prefix"] = (PrefixRe(), "The invoice prefix is 2 to 4 capital letters or digits, like MKT"),
    };

    [GeneratedRegex(@"^([01]\d|2[0-3]):[0-5]\d$")] private static partial Regex HhMmRe();
    [GeneratedRegex(@"^\d{4,8}$")] private static partial Regex SacRe();
    [GeneratedRegex(@"^[A-Z0-9]{2,4}$")] private static partial Regex PrefixRe();
    [GeneratedRegex(@"^[\w&.,()'/ -]{2,160}$")] private static partial Regex GstinNameRe();

    /// <summary>A 24-hour clock time like "23:00".</summary>
    public static bool ValidTime(string? v) => v is not null && HhMmRe().IsMatch(v);

    /// <summary>The merged checkout settings (defaults plus saved values; unknown saved keys ignored).</summary>
    public async Task<JsonObject> GetAsync() => SettingsDAL.Merge(Defaults(), await settings.GetAsync(Key));

    private static DateTimeOffset? Until(JsonObject ck)
    {
        var s = ck.Str("surge_until");
        return s.Length > 0 && DateTimeOffset.TryParse(s, out var d) ? d : null;
    }

    /// <summary>surge_hours (how long to charge the bad weather fee from now; 0 = until switched off) as surge_until.</summary>
    public static string SurgeHoursUntil(int hours, DateTimeOffset? now = null)
    {
        if (hours < 0 || hours > SurgeHoursMax)
            throw new AppException($"Charge the bad weather fee for 1 to {SurgeHoursMax} hours, or until you switch it off", "invalid_setting");
        return hours == 0 ? "" : ((now ?? DateTimeOffset.UtcNow) + TimeSpan.FromHours(hours)).ToString("o");
    }

    private static string Rupees(long paise) => paise % 100 == 0 ? $"₹{paise / 100m:#,0}" : $"₹{paise / 100m:#,0.00}";

    /// <summary>(taxable value, GST) inside a GST-inclusive amount.</summary>
    public static (long Taxable, long Gst) GstSplit(long amount, int bps)
    {
        var taxable = bps != 0 ? (long)Math.Round(amount * 10_000m / (10_000 + bps), MidpointRounding.AwayFromZero) : amount;
        return (taxable, amount - taxable);
    }

    /// <summary>The bad weather fee is being charged right now.</summary>
    public static bool SurgeActive(JsonObject ck, DateTimeOffset? now = null)
    {
        if (!ck.Bool("surge_enabled") || ck.Int("surge_paise") <= 0) return false;
        var until = Until(ck);
        return until is null || (now ?? DateTimeOffset.UtcNow) < until;
    }

    private static int Minutes(string hhmm) => int.Parse(hhmm[..2]) * 60 + int.Parse(hhmm[3..]);

    /// <summary>India time is inside the late night window (which may run past midnight, like 23:00 to 06:00).</summary>
    public static bool InNightWindow(JsonObject ck, DateTimeOffset? now = null)
    {
        var t = TimeZoneInfo.ConvertTime(now ?? DateTimeOffset.UtcNow, Ist);
        var m = t.Hour * 60 + t.Minute;
        int start = Minutes(ck.Str("late_night_from")), end = Minutes(ck.Str("late_night_to"));
        return start < end ? start <= m && m < end : m >= start || m < end;
    }

    /// <summary>"23:00" -> "11 pm", "06:30" -> "6:30 am".</summary>
    public static string Clock(string hhmm)
    {
        int h = int.Parse(hhmm[..2]), m = int.Parse(hhmm[3..]);
        return $"{(h % 12 == 0 ? 12 : h % 12)}{(m != 0 ? $":{m:00}" : "")} {(h < 12 ? "am" : "pm")}";
    }

    /// <summary>For the admin page: whether the time-bound fees are being charged at this moment.</summary>
    public static JsonObject Status(JsonObject ck, DateTimeOffset? now = null)
    {
        var until = Until(ck);
        var n = now ?? DateTimeOffset.UtcNow;
        return new JsonObject
        {
            ["surge_active"] = SurgeActive(ck, n),
            ["surge_until"] = until?.ToString("o"),
            ["surge_ended"] = ck.Bool("surge_enabled") && until is not null && n >= until,
            ["late_night_active"] = ck.Bool("late_night_enabled") && ck.Int("late_night_paise") > 0 && InNightWindow(ck, n),
            ["night_window_now"] = InNightWindow(ck, n),
        };
    }

    /// <summary>
    /// The marketplace's own fees for an order with this item total (before coupons). Each line carries its GST split.
    /// night overrides the clock for the late night fee (the admin preview); now defaults to this moment.
    /// </summary>
    public static JsonArray OrderFees(JsonObject ck, long itemsTotal, DateTimeOffset? now = null, bool? night = null)
    {
        var lines = new JsonArray();

        void Add(string code, long amount, long listAmount = 0, string hint = "")
        {
            var (taxable, gst) = GstSplit(amount, ck.Int("fees_gst_bps"));
            lines.Add(new JsonObject
            {
                ["code"] = code, ["label"] = ck.Str($"{code}_label"), ["info"] = ck.Str($"{code}_info"), ["amount"] = amount,
                ["list_amount"] = listAmount > amount ? listAmount : 0, ["taxable"] = taxable, ["gst"] = gst,
                ["gst_bps"] = ck.Int("fees_gst_bps"), ["hint"] = hint,
            });
        }

        if (itemsTotal <= 0) return lines;
        if (ck.Bool("handling_enabled") && ck.Int("handling_paise") > 0)
        {
            var freeAbove = ck.Int("handling_free_above_paise");
            if (!(freeAbove > 0 && itemsTotal >= freeAbove))
                Add("handling", ck.Int("handling_paise"), ck.Int("handling_list_paise"),
                    freeAbove > 0 ? $"Free handling on orders of {Rupees(freeAbove)} or more" : "");
        }
        if (ck.Bool("small_cart_enabled") && ck.Int("small_cart_paise") > 0 && itemsTotal < ck.Int("small_cart_below_paise"))
            Add("small_cart", ck.Int("small_cart_paise"), 0, $"No small cart fee on orders of {Rupees(ck.Int("small_cart_below_paise"))} or more");
        if (ck.Bool("platform_enabled") && ck.Int("platform_paise") > 0)
            Add("platform", ck.Int("platform_paise"));
        if (SurgeActive(ck, now))
            Add("surge", ck.Int("surge_paise"));
        var isNight = night ?? InNightWindow(ck, now);
        if (ck.Bool("late_night_enabled") && ck.Int("late_night_paise") > 0 && isNight)
            Add("late_night", ck.Int("late_night_paise"), 0, $"On orders placed between {Clock(ck.Str("late_night_from"))} and {Clock(ck.Str("late_night_to"))}");
        return lines;
    }

    public static long TipAmount(JsonObject ck, long? tip)
    {
        if (tip is null or 0) return 0;
        if (!ck.Bool("tip_enabled")) throw new AppException("Tips are not available right now", "invalid_tip");
        if (tip < 0 || tip > ck.Int("tip_max_paise")) throw new AppException($"A tip can be at most {Rupees(ck.Int("tip_max_paise"))}", "invalid_tip");
        return tip.Value;
    }

    /// <summary>Short nudges under the bill: how much more for free delivery or to drop the small cart fee.</summary>
    public static JsonArray Hints(JsonObject ck, JsonObject cfg, long itemsTotal, JsonArray groups)
    {
        var outp = new List<string>();
        if (ck.Bool("small_cart_enabled") && ck.Int("small_cart_paise") > 0 && itemsTotal > 0 && itemsTotal < ck.Int("small_cart_below_paise"))
            outp.Add($"Add items worth {Rupees(ck.Int("small_cart_below_paise") - itemsTotal)} to avoid the small cart fee");
        foreach (var g in groups.OfType<JsonObject>())
        {
            var gap = g["free_shipping_gap"]?.GetValue<long>() ?? 0;
            if (gap > 0 && (g["shipping_fee"]?.GetValue<long>() ?? 0) > 0)
                outp.Add($"Add items worth {Rupees(gap)} from {g["seller"]?["name"]?.GetValue<string>()} for free delivery");
        }
        if (ck.Bool("handling_enabled") && ck.Int("handling_free_above_paise") > 0 && itemsTotal > 0 && itemsTotal < ck.Int("handling_free_above_paise"))
            outp.Add($"Add items worth {Rupees(ck.Int("handling_free_above_paise") - itemsTotal)} for free handling");
        return new JsonArray(outp.Take(3).Select(s => JsonValue.Create(s)).ToArray<JsonNode?>());
    }

    /// <summary>Options the checkout screen needs.</summary>
    public static JsonObject Public(JsonObject ck) => new()
    {
        ["tip_enabled"] = ck.Bool("tip_enabled"), ["tip_presets"] = ck["tip_presets"]?.DeepClone(), ["tip_max_paise"] = ck.Int("tip_max_paise"),
        ["gstin_enabled"] = ck.Bool("gstin_enabled"), ["instructions_enabled"] = ck.Bool("instructions_enabled"),
        ["no_bag_enabled"] = ck.Bool("no_bag_enabled"), ["cancellation_note"] = ck.Str("cancellation_note"),
        ["delivery_label"] = ck.Str("delivery_label"), ["delivery_info"] = ck.Str("delivery_info"),
    };

    public static string CheckBusiness(string name)
    {
        name = string.Join(" ", name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (!GstinNameRe().IsMatch(name)) throw new AppException("Enter the business name as registered for GST", "invalid_gstin");
        return name;
    }
}
