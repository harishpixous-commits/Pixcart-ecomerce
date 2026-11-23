using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>
/// Languages, currencies, regions and payment options (Admin → Languages and currencies), stored in
/// platform_settings['regional'] (reference: services/regional.py). The books always stay in rupees (paise);
/// other currencies are a view of those rupees at the admin's rate.
/// </summary>
public interface IRegionalBAL
{
    /// <summary>The merged regional settings (reference: get_regional): stored values over the defaults,
    /// unknown keys dropped, pay_methods merged key-by-key.</summary>
    Task<JsonObject> GetRegionalAsync();

    /// <summary>Units of the currency per rupee, with the admin's conversion charge; null if the currency is
    /// not switched on (reference: currency_rate).</summary>
    decimal? CurrencyRate(JsonObject cfg, string code);

    /// <summary>Paise to the smallest unit of the currency (cents, fils...), rounded half up (reference: convert_minor).</summary>
    int ConvertMinor(long paise, decimal rate, string code);

    /// <summary>What Razorpay charges for an online order: (currency, rate, amount in its smallest unit or null for
    /// rupees) (reference: charge_plan).</summary>
    (string Currency, decimal Rate, int? Amount) ChargePlan(JsonObject cfg, string? currency, long grandTotalPaise);
}
