using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>
/// Languages, currencies, regions and payment options (Admin → Languages and currencies,
/// <c>platform_settings['regional']</c>). The books always stay in rupees (paise); other currencies are a view at the
/// admin's rate, and with "charge in the shopper's currency" Razorpay charges that currency. Rates are units of the
/// currency per one rupee (USD 0.012 means ₹1 = $0.012). Also the shopper's cards saved with Razorpay.
/// </summary>
public interface IRegionalBAL
{
    /// <summary>The regional settings: defaults with the saved values on top.</summary>
    Task<JsonObject> GetAsync();

    /// <summary>Checks the admin's changes (keeps rupees and English on) and saves them; 400 with the reference code and message.</summary>
    Task<JsonObject> UpdateAsync(JsonObject body);

    /// <summary>Updates every "auto" rate from the free exchange-rate service (at most once in 20 hours unless forced).</summary>
    Task<(bool Changed, string Message)> RefreshRatesAsync(bool force = false);

    /// <summary>Units of the currency per rupee with the conversion charge, or null when the currency is not switched on.</summary>
    decimal? CurrencyRate(JsonObject cfg, string code);

    /// <summary>Paise to the currency's smallest unit (cents, fils ...), rounded half up.</summary>
    long ConvertMinor(long paise, decimal rate, string code);

    /// <summary>Digits after the decimal point of a currency (2, or 0/3 for JPY, KWD ...).</summary>
    int MinorDigits(string code);

    /// <summary>What Razorpay charges for an online order: (currency, rate, amount in its smallest unit, or null for rupees).</summary>
    (string Currency, decimal Rate, long? Amount) ChargePlan(JsonObject cfg, string? currency, long grandTotalPaise);

    /// <summary>What every page needs: currencies and languages shoppers can pick and the visitor's suggested choice.</summary>
    JsonObject Public(JsonObject cfg, string country = "");

    /// <summary>GET /api/regional (refreshes due auto rates first).</summary>
    Task<JsonObject> PublicAsync(string country);

    /// <summary>GET /api/admin/regional.</summary>
    Task<JsonObject> AdminViewAsync();

    /// <summary>PUT /api/admin/regional (audited).</summary>
    Task<JsonObject> SaveAsync(UserModel admin, JsonObject body);

    /// <summary>POST /api/admin/regional/rates (audited when rates changed).</summary>
    Task<JsonObject> RefreshRatesNowAsync(UserModel admin);

    /// <summary>GET /api/account/cards: cards saved with Razorpay (last 4 digits, network, expiry); 502 when Razorpay fails.</summary>
    Task<JsonObject> MyCardsAsync(UserModel user);

    /// <summary>DELETE /api/account/cards/{token}: 404 for another shopper's or a malformed token.</summary>
    Task<JsonObject> RemoveCardAsync(UserModel user, string tokenId);
}

/// <summary>
/// The site in other languages: interface lines translated once and kept. Known lines come from the translations table,
/// then the built-in Tamil and Hindi lines; new ones are translated by the AI ("translate" route) when allowed, within
/// a daily limit. Staff corrections (origin "manual") are never overwritten.
/// </summary>
public interface ITranslateBAL
{
    /// <summary>Known translations plus new AI ones when allowed; unknown lines are left out. 404 "language_off" for a language that is off.</summary>
    Task<Dictionary<string, string>> TranslateAsync(JsonObject regionalCfg, string lang, IEnumerable<string> texts);

    /// <summary>Saved lines first, then the built-in ones.</summary>
    Task<Dictionary<string, string>> LookupAsync(string lang, IReadOnlyCollection<string> texts);

    /// <summary>Keeps translations: "ai" never replaces existing lines; "manual" always does.</summary>
    Task SaveAsync(string lang, IReadOnlyDictionary<string, string> pairs, string origin);

    /// <summary>POST /api/i18n/translate (rate limited per address).</summary>
    Task<JsonObject> TranslateTextsAsync(string lang, IReadOnlyList<string> texts, string ip);

    /// <summary>GET /api/admin/translations.</summary>
    Task<JsonObject> ListAsync(string lang, string q, string origin, int page);

    /// <summary>PUT /api/admin/translations: a staff correction (audited).</summary>
    Task<JsonObject> SaveCorrectionAsync(UserModel admin, string lang, string source, string text);

    /// <summary>DELETE /api/admin/translations: one line, or every AI line of a language (audited).</summary>
    Task<JsonObject> ClearAsync(UserModel admin, string lang, string id, bool onlyAi);

    /// <summary>The translations that ship with the site for a language (Tamil and Hindi).</summary>
    IReadOnlyDictionary<string, string> Builtin(string lang);
}
