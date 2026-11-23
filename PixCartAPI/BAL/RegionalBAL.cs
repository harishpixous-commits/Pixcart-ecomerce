using System.Text.Json.Nodes;
using DAL;

namespace BAL;

/// <summary>
/// The shopper-facing side of services/regional.py: the stored regional settings and the currency arithmetic an
/// order needs. Admin editing (clean/save), automatic rate refresh and the public picker config land with the
/// admin module.
/// </summary>
public class RegionalBAL(SettingsDAL settings) : Interface.IRegionalBAL
{
    public const string Key = "regional";
    public const string Base = "INR";

    /// <summary>ISO 4217 currencies whose smallest unit is not 1/100 (everything else has two decimals).</summary>
    public static readonly IReadOnlyDictionary<string, int> MinorDigitsMap = new Dictionary<string, int>
    {
        ["BHD"] = 3, ["IQD"] = 3, ["JOD"] = 3, ["KWD"] = 3, ["LYD"] = 3, ["OMR"] = 3, ["TND"] = 3,
        ["BIF"] = 0, ["CLP"] = 0, ["DJF"] = 0, ["GNF"] = 0, ["ISK"] = 0, ["JPY"] = 0, ["KMF"] = 0, ["KRW"] = 0,
        ["PYG"] = 0, ["RWF"] = 0, ["UGX"] = 0, ["UYI"] = 0, ["VND"] = 0, ["VUV"] = 0, ["XAF"] = 0, ["XOF"] = 0, ["XPF"] = 0,
    };

    public static int MinorDigits(string code) => MinorDigitsMap.TryGetValue(code, out var d) ? d : 2;

    /// <summary>The defaults (reference: DEFAULTS). Rates are units of the currency per one rupee.</summary>
    public static JsonObject Defaults() => new()
    {
        ["currencies"] = new JsonArray(
            Currency("INR", "1", true, false), Currency("USD", "0.012", false, true), Currency("EUR", "0.011", false, true),
            Currency("GBP", "0.0095", false, true), Currency("AED", "0.044", false, true)),
        ["default_currency"] = "INR",
        ["markup_bps"] = 0,
        ["charge_in"] = "base",
        ["auto_rates"] = true,
        ["rates_updated_at"] = null,
        ["rates_source"] = "",
        ["languages"] = new JsonArray(Language("en", true), Language("hi", false), Language("ta", false)),
        ["default_language"] = "en",
        ["ai_translate"] = true,
        ["ai_translate_daily_max"] = 4000,
        ["show_switcher"] = true,
        ["detect_region"] = true,
        ["regions"] = new JsonArray(
            Region("IN", "INR", "en"), Region("US", "USD", "en"), Region("GB", "GBP", "en"), Region("AE", "AED", "en")),
        ["pay_methods"] = new JsonObject
        {
            ["upi"] = true, ["card"] = true, ["netbanking"] = true, ["wallet"] = true, ["emi"] = true, ["paylater"] = true,
        },
        ["card_networks"] = new JsonArray("visa", "mastercard", "rupay", "amex", "diners"),
        ["save_cards"] = true,
    };

    private static JsonObject Currency(string code, string rate, bool enabled, bool auto) =>
        new() { ["code"] = code, ["rate"] = rate, ["enabled"] = enabled, ["auto"] = auto };

    private static JsonObject Language(string code, bool enabled) => new() { ["code"] = code, ["enabled"] = enabled };

    private static JsonObject Region(string country, string currency, string language) =>
        new() { ["country"] = country, ["currency"] = currency, ["language"] = language };

    public async Task<JsonObject> GetRegionalAsync()
    {
        var outp = Defaults();
        var stored = await settings.GetAsync(Key);
        if (stored is not null)
        {
            foreach (var kv in stored)
                if (outp.ContainsKey(kv.Key)) outp[kv.Key] = kv.Value?.DeepClone();
            var methods = outp["pay_methods"]!.AsObject();
            if (stored["pay_methods"] is JsonObject sm)
                foreach (var kv in sm) methods[kv.Key] = kv.Value?.DeepClone();
        }
        return outp;
    }

    public decimal? CurrencyRate(JsonObject cfg, string code)
    {
        foreach (var c in cfg["currencies"]!.AsArray().OfType<JsonObject>())
        {
            if (c["code"]?.GetValue<string>() != code || !c["enabled"]!.GetValue<bool>()) continue;
            var rate = decimal.Parse(c["rate"]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
            var markup = cfg["markup_bps"]?.GetValue<int>() ?? 0;
            if (code != Base && markup != 0) rate *= 1 + markup / 10_000m;
            return rate;
        }
        return null;
    }

    public int ConvertMinor(long paise, decimal rate, string code)
    {
        var units = paise / 100m * rate;
        var scaled = units * (decimal)Math.Pow(10, MinorDigits(code));
        return (int)Math.Round(scaled, 0, MidpointRounding.AwayFromZero);
    }

    public (string Currency, decimal Rate, int? Amount) ChargePlan(JsonObject cfg, string? currency, long grandTotalPaise)
    {
        var code = (currency ?? Base).ToUpperInvariant();
        if (cfg["charge_in"]?.GetValue<string>() != "shopper" || code == Base) return (Base, 1m, null);
        var rate = CurrencyRate(cfg, code);
        if (rate is null) return (Base, 1m, null);
        var amount = ConvertMinor(grandTotalPaise, rate.Value, code);
        return amount <= 0 ? (Base, 1m, null) : (code, rate.Value, amount);
    }
}
