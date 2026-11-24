using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>Languages, currencies, regions, payment options and saved cards (reference: services/regional.py, routers/regional.py).</summary>
public partial class RegionalBAL(
    SettingsDAL settings,
    RegionalDAL translations,
    CatalogSupportDAL support,
    IRazorpayClient razorpay,
    IHttpClientFactory http,
    IEnumerable<IAiAvailability> ai,
    ILogger<RegionalBAL> log) : IRegionalBAL
{
    public const string Key = "regional";
    public const string Base = "INR";
    public const string RatesUrl = "https://open.er-api.com/v6/latest/INR"; // free, no key: "Rates by Exchange Rate API"

    /// <summary>ISO 4217 currencies whose smallest unit is not 1/100.</summary>
    public static readonly IReadOnlyDictionary<string, int> MinorDigitsTable = new Dictionary<string, int>
    {
        ["BHD"] = 3, ["IQD"] = 3, ["JOD"] = 3, ["KWD"] = 3, ["LYD"] = 3, ["OMR"] = 3, ["TND"] = 3,
        ["BIF"] = 0, ["CLP"] = 0, ["DJF"] = 0, ["GNF"] = 0, ["ISK"] = 0, ["JPY"] = 0, ["KMF"] = 0, ["KRW"] = 0, ["PYG"] = 0, ["RWF"] = 0, ["UGX"] = 0,
        ["UYI"] = 0, ["VND"] = 0, ["VUV"] = 0, ["XAF"] = 0, ["XOF"] = 0, ["XPF"] = 0,
    };

    public static readonly string[] PopularCurrencies =
    [
        "INR", "USD", "EUR", "GBP", "AED", "SAR", "QAR", "KWD", "OMR", "BHD", "SGD", "MYR", "THB", "IDR", "PHP", "VND", "JPY", "CNY", "HKD", "KRW", "AUD",
        "NZD", "CAD", "CHF", "SEK", "NOK", "DKK", "PLN", "ZAR", "LKR", "NPR", "BDT", "PKR", "MVR", "KES", "NGN", "EGP", "TRY", "BRL", "MXN", "RUB",
    ];

    public static readonly string[] PopularLanguages =
    [
        "en", "hi", "ta", "te", "kn", "ml", "mr", "bn", "gu", "pa", "or", "as", "ur", "ar", "fr", "de", "es", "pt", "it", "nl", "ru", "tr", "zh", "ja", "ko",
        "id", "ms", "th", "vi", "fil", "si", "ne", "sw",
    ];

    public static readonly HashSet<string> Rtl = ["ar", "ur", "fa", "he", "ps", "sd", "ug", "yi", "dv"];
    public static readonly string[] PayMethods = ["upi", "card", "netbanking", "wallet", "emi", "paylater"];
    public static readonly string[] CardNetworks = ["visa", "mastercard", "rupay", "amex", "diners", "maestro", "discover", "jcb"];

    private static JsonObject Cur(string code, string rate, bool enabled, bool auto) => new() { ["code"] = code, ["rate"] = rate, ["enabled"] = enabled, ["auto"] = auto };

    public static JsonObject Defaults() => new()
    {
        ["currencies"] = new JsonArray(Cur("INR", "1", true, false), Cur("USD", "0.012", false, true), Cur("EUR", "0.011", false, true),
            Cur("GBP", "0.0095", false, true), Cur("AED", "0.044", false, true)),
        ["default_currency"] = "INR",
        ["markup_bps"] = 0,
        ["charge_in"] = "base",
        ["auto_rates"] = true,
        ["rates_updated_at"] = null,
        ["rates_source"] = "",
        ["languages"] = new JsonArray(
            new JsonObject { ["code"] = "en", ["enabled"] = true }, new JsonObject { ["code"] = "hi", ["enabled"] = false }, new JsonObject { ["code"] = "ta", ["enabled"] = false }),
        ["default_language"] = "en",
        ["ai_translate"] = true,
        ["ai_translate_daily_max"] = 4000,
        ["show_switcher"] = true,
        ["detect_region"] = true,
        ["regions"] = new JsonArray(
            new JsonObject { ["country"] = "IN", ["currency"] = "INR", ["language"] = "en" }, new JsonObject { ["country"] = "US", ["currency"] = "USD", ["language"] = "en" },
            new JsonObject { ["country"] = "GB", ["currency"] = "GBP", ["language"] = "en" }, new JsonObject { ["country"] = "AE", ["currency"] = "AED", ["language"] = "en" }),
        ["pay_methods"] = new JsonObject(PayMethods.Select(m => new KeyValuePair<string, JsonNode?>(m, true))),
        ["card_networks"] = new JsonArray("visa", "mastercard", "rupay", "amex", "diners"),
        ["save_cards"] = true,
    };

    [GeneratedRegex("^[A-Z]{3}$")]
    private static partial Regex CodeRx();

    [GeneratedRegex("^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$")]
    private static partial Regex LangRx();

    [GeneratedRegex("^[A-Z]{2}$")]
    private static partial Regex CountryRx();

    public int MinorDigits(string code) => MinorDigitsTable.GetValueOrDefault(code, 2);

    public async Task<JsonObject> GetAsync()
    {
        var saved = await settings.GetAsync(Key);
        var outp = SettingsDAL.Merge(Defaults(), saved);
        var pm = (JsonObject)Defaults()["pay_methods"]!.DeepClone();
        foreach (var (k, v) in saved["pay_methods"] as JsonObject ?? []) pm[k] = v?.DeepClone();
        outp["pay_methods"] = pm;
        return outp;
    }

    private static string Fmt(decimal d) => d.ToString("0.############################", CultureInfo.InvariantCulture);

    private static decimal Rate(JsonNode? v)
    {
        var text = CatalogText.Str(v);
        if (!decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
            throw new AppException("Enter the exchange rate as a number, like 0.012", "invalid_rate");
        if (d <= 0 || d > 1_000_000) throw new AppException("The exchange rate must be more than 0", "invalid_rate");
        return d;
    }

    private static long IntOf(JsonNode? v)
    {
        try
        {
            return SettingsJson.Truthy(v) ? CatalogText.PyInt(v) : 0;
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_number");
        }
    }

    /// <summary>Checks what the admin sent; keeps the base currency and English on (regional.clean).</summary>
    public static JsonObject Clean(JsonObject body, JsonObject current)
    {
        var outp = (JsonObject)current.DeepClone();
        if (body.ContainsKey("currencies"))
        {
            var seen = new Dictionary<string, JsonObject>();
            var order = new List<string>();
            foreach (var c in (body["currencies"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var code = CatalogText.Str(c.TryGetPropertyValue("code", out var cv) ? cv : "").ToUpperInvariant().Trim();
                if (!CodeRx().IsMatch(code)) throw new AppException($"{(code.Length > 0 ? code : "A currency")} is not a 3-letter currency code (like USD)", "invalid_currency");
                var rate = code == Base ? 1m : Rate(c["rate"]);
                if (!seen.ContainsKey(code)) order.Add(code);
                seen[code] = Cur(code, Fmt(rate), code == Base || SettingsJson.Truthy(c["enabled"]), code != Base && SettingsJson.Truthy(c["auto"]));
            }
            if (!seen.ContainsKey(Base)) { seen[Base] = Cur(Base, "1", true, false); order.Add(Base); }
            outp["currencies"] = new JsonArray(new[] { seen[Base] }.Concat(order.Where(k => k != Base).Select(k => seen[k])).Select(x => (JsonNode)x).ToArray());
        }
        if (body.ContainsKey("languages"))
        {
            var langs = new Dictionary<string, JsonObject>();
            var order = new List<string>();
            foreach (var item in (body["languages"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var code = CatalogText.Str(item.TryGetPropertyValue("code", out var cv) ? cv : "").Trim();
                if (!LangRx().IsMatch(code)) throw new AppException($"{(code.Length > 0 ? code : "A language")} is not a language code (like ta or pt-BR)", "invalid_language");
                if (!langs.ContainsKey(code)) order.Add(code);
                langs[code] = new JsonObject { ["code"] = code, ["enabled"] = code == "en" || SettingsJson.Truthy(item["enabled"]) };
            }
            if (!langs.ContainsKey("en")) { langs["en"] = new JsonObject { ["code"] = "en", ["enabled"] = true }; order.Add("en"); }
            outp["languages"] = new JsonArray(new[] { langs["en"] }.Concat(order.Where(k => k != "en").Select(k => langs[k])).Select(x => (JsonNode)x).ToArray());
        }
        if (body.ContainsKey("charge_in"))
        {
            var v = CatalogText.AsString(body["charge_in"]);
            if (v is not ("base" or "shopper")) throw new AppException("Choose how to charge", "invalid_choice");
            outp["charge_in"] = v;
        }
        foreach (var k in new[] { "auto_rates", "ai_translate", "show_switcher", "detect_region", "save_cards" })
            if (body.ContainsKey(k)) outp[k] = SettingsJson.Truthy(body[k]);
        if (body.ContainsKey("markup_bps"))
        {
            var bps = IntOf(body["markup_bps"]);
            if (bps < 0 || bps > 1000) throw new AppException("The conversion charge must be between 0% and 10%", "invalid_markup");
            outp["markup_bps"] = bps;
        }
        if (body.ContainsKey("ai_translate_daily_max"))
        {
            var n = IntOf(body["ai_translate_daily_max"]);
            if (n < 0 || n > 100000) throw new AppException("Daily translations must be between 0 and 100000", "invalid_number");
            outp["ai_translate_daily_max"] = n;
        }
        if (body.ContainsKey("pay_methods"))
        {
            var given = body["pay_methods"] as JsonObject ?? [];
            var current_pm = outp["pay_methods"] as JsonObject ?? [];
            var pm = new JsonObject();
            foreach (var m in PayMethods)
                pm[m] = given.TryGetPropertyValue(m, out var gv) ? SettingsJson.Truthy(gv) : !current_pm.TryGetPropertyValue(m, out var cv) || SettingsJson.Truthy(cv);
            if (!pm.Any(kv => kv.Value!.GetValue<bool>())) throw new AppException("Keep at least one way to pay online", "no_pay_method");
            outp["pay_methods"] = pm;
        }
        if (body.ContainsKey("card_networks"))
        {
            var given = (body["card_networks"] as JsonArray ?? []).Select(CatalogText.Str).ToHashSet();
            outp["card_networks"] = new JsonArray(CardNetworks.Where(given.Contains).Select(n => (JsonNode)n).ToArray());
        }
        var currencies = (outp["currencies"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var languages = (outp["languages"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        var enabledCur = currencies.Where(c => SettingsJson.Truthy(c["enabled"])).Select(c => CatalogText.Str(c["code"])).ToHashSet();
        var enabledLang = languages.Where(l => SettingsJson.Truthy(l["enabled"])).Select(l => CatalogText.Str(l["code"])).ToHashSet();
        if (body.ContainsKey("default_currency"))
        {
            var d = CatalogText.OrEmpty(body["default_currency"]);
            outp["default_currency"] = (d.Length > 0 ? d : Base).ToUpperInvariant();
        }
        if (body.ContainsKey("default_language"))
        {
            var d = CatalogText.OrEmpty(body["default_language"]);
            outp["default_language"] = d.Length > 0 ? d : "en";
        }
        if (!enabledCur.Contains(CatalogText.Str(outp["default_currency"]))) throw new AppException("The default currency must be switched on", "invalid_default");
        if (!enabledLang.Contains(CatalogText.Str(outp["default_language"]))) throw new AppException("The default language must be switched on", "invalid_default");
        if (body.ContainsKey("regions"))
        {
            var regions = new JsonArray();
            var seenC = new HashSet<string>();
            var allCur = currencies.Select(c => CatalogText.Str(c["code"])).ToHashSet();
            var allLang = languages.Select(l => CatalogText.Str(l["code"])).ToHashSet();
            foreach (var r in (body["regions"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var country = CatalogText.Str(r.TryGetPropertyValue("country", out var cv) ? cv : "").ToUpperInvariant().Trim();
                if (!CountryRx().IsMatch(country)) throw new AppException($"{(country.Length > 0 ? country : "A region")} is not a 2-letter country code (like US)", "invalid_country");
                if (!seenC.Add(country)) continue;
                var cur = CatalogText.Str(r.TryGetPropertyValue("currency", out var rc) ? rc : "").ToUpperInvariant();
                var lang = CatalogText.Str(r.TryGetPropertyValue("language", out var rl) ? rl : "");
                if (!allCur.Contains(cur)) throw new AppException($"Add {cur} to the currencies first", "invalid_currency");
                if (!allLang.Contains(lang)) throw new AppException($"Add the language {lang} first", "invalid_language");
                regions.Add(new JsonObject { ["country"] = country, ["currency"] = cur, ["language"] = lang });
            }
            outp["regions"] = regions;
        }
        return outp;
    }

    public async Task<JsonObject> UpdateAsync(JsonObject body)
    {
        var outp = Clean(body, await GetAsync());
        await settings.SaveAsync(Key, outp);
        return outp;
    }

    public async Task<(bool Changed, string Message)> RefreshRatesAsync(bool force = false)
    {
        var cfg = await GetAsync();
        var currencies = (cfg["currencies"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        if (!currencies.Any(c => SettingsJson.Truthy(c["auto"]) && CatalogText.Str(c["code"]) != Base))
            return (false, "No currency is set to update automatically");
        var last = CatalogText.AsString(cfg["rates_updated_at"]);
        if (!force && !string.IsNullOrEmpty(last) && DateTimeOffset.TryParse(last, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var lastAt)
            && DateTimeOffset.UtcNow - lastAt < TimeSpan.FromHours(20))
            return (false, "Rates are up to date");
        JsonObject rates;
        try
        {
            var client = http.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(6);
            using var resp = await client.GetAsync(RatesUrl);
            var data = JsonNode.Parse(await resp.Content.ReadAsStringAsync()) as JsonObject ?? [];
            rates = data["rates"] as JsonObject ?? [];
            if ((int)resp.StatusCode != 200 || CatalogText.AsString(data["result"]) != "success" || rates.Count == 0)
                throw new InvalidOperationException(CatalogText.OrEmpty(data["error-type"]) is { Length: > 0 } t ? t : ((int)resp.StatusCode).ToString());
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or InvalidOperationException or JsonException)
        {
            log.LogWarning("exchange rates not refreshed: {Error}", e.Message);
            return (false, "Could not reach the exchange-rate service. The current rates stay in use.");
        }
        var missing = new List<string>();
        foreach (var c in currencies)
        {
            var code = CatalogText.Str(c["code"]);
            if (!SettingsJson.Truthy(c["auto"]) || code == Base) continue;
            if (rates[code] is { } r && SettingsJson.ToDecimal(r) is { } d) c["rate"] = Fmt(d);
            else missing.Add(code);
        }
        cfg["rates_updated_at"] = DateTimeFunctions.Iso(DateTimeFunctions.UtcNow());
        cfg["rates_source"] = "Exchange Rate API (open.er-api.com)";
        await settings.SaveAsync(Key, cfg);
        return (true, "Exchange rates updated" + (missing.Count > 0 ? $". No rate for {string.Join(", ", missing)}: set it by hand." : ""));
    }

    public decimal? CurrencyRate(JsonObject cfg, string code)
    {
        foreach (var c in (cfg["currencies"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (CatalogText.Str(c["code"]) != code || !SettingsJson.Truthy(c["enabled"])) continue;
            var rate = decimal.TryParse(CatalogText.Str(c["rate"]), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 1m;
            var markup = SettingsJson.ToLong(cfg["markup_bps"]);
            if (code != Base && markup != 0) rate *= 1 + markup / 10000m;
            return rate;
        }
        return null;
    }

    public long ConvertMinor(long paise, decimal rate, string code)
    {
        var units = paise / 100m * rate;
        var scale = 1m;
        for (var i = 0; i < MinorDigits(code); i++) scale *= 10;
        return (long)Math.Round(units * scale, MidpointRounding.AwayFromZero);
    }

    public (string Currency, decimal Rate, long? Amount) ChargePlan(JsonObject cfg, string? currency, long grandTotalPaise)
    {
        var code = (currency ?? Base).ToUpperInvariant();
        if (CatalogText.AsString(cfg["charge_in"]) != "shopper" || code == Base) return (Base, 1m, null);
        if (CurrencyRate(cfg, code) is not { } rate) return (Base, 1m, null);
        var amount = ConvertMinor(grandTotalPaise, rate, code);
        return amount <= 0 ? (Base, 1m, null) : (code, rate, amount);
    }

    public JsonObject Public(JsonObject cfg, string country = "")
    {
        var currencies = new JsonArray();
        foreach (var c in (cfg["currencies"] as JsonArray ?? []).OfType<JsonObject>().Where(c => SettingsJson.Truthy(c["enabled"])))
        {
            var code = CatalogText.Str(c["code"]);
            currencies.Add(new JsonObject { ["code"] = code, ["rate"] = (double)(CurrencyRate(cfg, code) ?? 1m), ["digits"] = MinorDigits(code) });
        }
        var languages = new JsonArray();
        foreach (var l in (cfg["languages"] as JsonArray ?? []).OfType<JsonObject>().Where(l => SettingsJson.Truthy(l["enabled"])))
        {
            var code = CatalogText.Str(l["code"]);
            languages.Add(new JsonObject { ["code"] = code, ["rtl"] = Rtl.Contains(code.Split('-')[0]) });
        }
        var suggest = new JsonObject { ["currency"] = cfg["default_currency"]?.DeepClone(), ["language"] = cfg["default_language"]?.DeepClone() };
        country = (country ?? "").ToUpperInvariant();
        if (SettingsJson.Truthy(cfg["detect_region"]) && country.Length > 0)
        {
            var enabledC = currencies.Select(c => CatalogText.Str(c!["code"])).ToHashSet();
            var enabledL = languages.Select(l => CatalogText.Str(l!["code"])).ToHashSet();
            var r = (cfg["regions"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(x => CatalogText.Str(x["country"]) == country);
            if (r != null)
            {
                if (enabledC.Contains(CatalogText.Str(r["currency"]))) suggest["currency"] = r["currency"]!.DeepClone();
                if (enabledL.Contains(CatalogText.Str(r["language"]))) suggest["language"] = r["language"]!.DeepClone();
            }
        }
        return new JsonObject
        {
            ["base"] = Base,
            ["currencies"] = currencies,
            ["languages"] = languages,
            ["default_currency"] = cfg["default_currency"]?.DeepClone(),
            ["default_language"] = cfg["default_language"]?.DeepClone(),
            ["charge_in"] = cfg["charge_in"]?.DeepClone(),
            ["show_switcher"] = cfg["show_switcher"]?.DeepClone(),
            ["country"] = country,
            ["suggest"] = suggest,
            ["card_networks"] = cfg["card_networks"]?.DeepClone(),
            ["pay_methods"] = cfg["pay_methods"]?.DeepClone(),
            ["rates_updated_at"] = cfg["rates_updated_at"]?.DeepClone(),
        };
    }

    public async Task<JsonObject> PublicAsync(string country)
    {
        var cfg = await GetAsync();
        if (SettingsJson.Truthy(cfg["auto_rates"]) &&
            (cfg["currencies"] as JsonArray ?? []).OfType<JsonObject>().Any(c => SettingsJson.Truthy(c["auto"]) && SettingsJson.Truthy(c["enabled"])))
        {
            var (changed, _) = await RefreshRatesAsync(); // at most once a day; failures keep the last rates
            if (changed) cfg = await GetAsync();
        }
        return Public(cfg, country);
    }

    public async Task<JsonObject> AdminViewAsync()
    {
        var cfg = await GetAsync();
        var counts = await translations.CountsByLangAsync();
        var ready = false;
        foreach (var a in ai) ready |= await a.ConfiguredAsync("translate");
        cfg["popular_currencies"] = new JsonArray(PopularCurrencies.Select(c => (JsonNode)c).ToArray());
        cfg["popular_languages"] = new JsonArray(PopularLanguages.Select(c => (JsonNode)c).ToArray());
        cfg["pay_method_keys"] = new JsonArray(PayMethods.Select(c => (JsonNode)c).ToArray());
        cfg["card_network_keys"] = new JsonArray(CardNetworks.Select(c => (JsonNode)c).ToArray());
        cfg["translation_counts"] = new JsonObject(counts.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)));
        cfg["ai_ready"] = ready;
        return cfg;
    }

    public async Task<JsonObject> SaveAsync(UserModel admin, JsonObject body)
    {
        await UpdateAsync(body);
        var defaults = Defaults();
        var keys = string.Join(", ", body.Select(kv => kv.Key).Where(defaults.ContainsKey).OrderBy(k => k, StringComparer.Ordinal));
        await support.AuditAsync(admin.Id, "regional.update", "settings", "regional", CatalogText.Cut(keys, 200));
        return await AdminViewAsync();
    }

    public async Task<JsonObject> RefreshRatesNowAsync(UserModel admin)
    {
        var (changed, msg) = await RefreshRatesAsync(force: true);
        if (changed) await support.AuditAsync(admin.Id, "regional.rates", "settings", "regional", CatalogText.Cut(msg, 200));
        var outp = new JsonObject { ["changed"] = changed, ["message"] = msg };
        foreach (var (k, v) in await AdminViewAsync()) outp[k] = v?.DeepClone();
        return outp;
    }

    private static JsonObject? Card(JsonObject t)
    {
        var card = t["card"] as JsonObject;
        if (CatalogText.AsString(t["method"]) != "card" || card is null || card.Count == 0) return null;
        string S(string k) => CatalogText.OrEmpty(card[k]);
        return new JsonObject
        {
            ["id"] = t["id"]?.DeepClone(), ["last4"] = card.TryGetPropertyValue("last4", out var l4) ? l4?.DeepClone() : "",
            ["network"] = S("network").ToLowerInvariant(), ["issuer"] = S("issuer"), ["type"] = S("type"), ["name"] = S("name"),
            ["expiry_month"] = card["expiry_month"]?.DeepClone(), ["expiry_year"] = card["expiry_year"]?.DeepClone(),
            ["international"] = SettingsJson.Truthy(card["international"]), ["used_at"] = t["used_at"]?.DeepClone(),
        };
    }

    public async Task<JsonObject> MyCardsAsync(UserModel user)
    {
        var cfg = await GetAsync();
        var enabled = SettingsJson.Truthy(cfg["save_cards"]);
        if (string.IsNullOrEmpty(user.RazorpayCustomerId)) return new JsonObject { ["enabled"] = enabled, ["items"] = new JsonArray() };
        List<JsonObject> tokens;
        try
        {
            tokens = await razorpay.CustomerTokensAsync(user.RazorpayCustomerId);
        }
        catch (RazorpayGatewayException e)
        {
            throw new AppException($"Could not load your saved cards right now: {e.Message}", "gateway_error", 502);
        }
        return new JsonObject { ["enabled"] = enabled, ["items"] = CatalogBAL.Arr(tokens.Select(Card).Where(c => c != null)) };
    }

    public async Task<JsonObject> RemoveCardAsync(UserModel user, string tokenId)
    {
        if (string.IsNullOrEmpty(user.RazorpayCustomerId) || !tokenId.StartsWith("token_", StringComparison.Ordinal) || tokenId.Length > 40)
            throw new NotFoundException("Card");
        try
        {
            await razorpay.DeleteTokenAsync(user.RazorpayCustomerId, tokenId);
        }
        catch (RazorpayGatewayException e)
        {
            throw new AppException($"Could not remove the card: {e.Message}", "gateway_error", 502);
        }
        await support.AuditAsync(user.Id, "card.remove", "user", user.Id.ToString(), tokenId);
        return new JsonObject { ["ok"] = true };
    }
}
