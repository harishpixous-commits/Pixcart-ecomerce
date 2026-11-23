using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Utils;

namespace BAL;

/// <summary>
/// Delivery fleet settings, key "delivery" (reference: services/delivery_settings.py — same defaults, ranges,
/// choices and the public projection the partner app and the storefront read).
/// </summary>
public partial class DeliverySettingsBAL(SettingsDAL settings, CatalogSupportDAL support) : IDeliverySettingsBAL
{
    public const string RowKey = "delivery";

    public static readonly string[] FleetModes = ["off", "zones", "all", "seller_choice"];
    public static readonly string[] FeeModes = ["fixed", "distance"];

    public static readonly IReadOnlyDictionary<string, string> VehicleLabels = new Dictionary<string, string>
    {
        ["bike"] = "Motorbike", ["scooter"] = "Scooter", ["ev"] = "Electric bike or scooter",
        ["cycle"] = "Bicycle", ["auto"] = "Auto", ["van"] = "Van",
    };

    public static readonly IReadOnlyDictionary<string, string> IdProofs = new Dictionary<string, string>
    {
        ["aadhaar"] = "Aadhaar", ["pan"] = "PAN card", ["voter"] = "Voter ID", ["passport"] = "Passport",
    };

    public static readonly IReadOnlyDictionary<string, string> RejectReasons = new Dictionary<string, string>
    {
        ["too_far"] = "Too far from me", ["vehicle"] = "Vehicle problem", ["busy"] = "Already on another delivery",
        ["ending_shift"] = "Ending my shift", ["unsafe"] = "Area not safe right now", ["other"] = "Other reason",
    };

    public static readonly IReadOnlyDictionary<string, string> FailReasons = new Dictionary<string, string>
    {
        ["not_available"] = "Customer not available", ["wrong_address"] = "Address wrong or not found",
        ["refused"] = "Customer refused the package", ["no_cash"] = "Customer could not pay cash",
        ["damaged"] = "Package damaged", ["other"] = "Other reason",
    };

    /// <summary>The defaults, in the reference order (a fresh copy each time).</summary>
    public static JsonObject Defaults() => new()
    {
        ["enabled"] = true,
        ["fleet_mode"] = "zones",
        ["registration_open"] = true,
        ["return_pickups"] = true,
        ["auto_assign"] = true,
        ["offer_seconds"] = 30,
        ["radius_km"] = 8,
        ["max_active"] = 3,
        ["max_offers"] = 5,
        ["fee_mode"] = "fixed",
        ["fee_fixed_paise"] = 3000,
        ["fee_base_paise"] = 2000,
        ["fee_per_km_paise"] = 800,
        ["fee_min_paise"] = 2500,
        ["fee_max_paise"] = 15000,
        ["weather_bonus_paise"] = 0,
        ["cod_limit_paise"] = 500000,
        ["cod_deduct_from_payout"] = false,
        ["stuck_minutes"] = 30,
        ["proof_photo_required"] = true,
        ["delivery_otp_required"] = true,
        ["pickup_code_required"] = true,
        ["location_seconds"] = 20,
        ["map_tiles"] = "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        ["map_attribution"] = "© OpenStreetMap contributors",
        ["support_phone"] = "",
        ["support_whatsapp"] = "",
        ["android_apk_url"] = "",
        ["play_store_url"] = "",
        ["app_version"] = "",
        ["require_vehicle_doc"] = false,
    };

    private static readonly IReadOnlyDictionary<string, (int Lo, int Hi)> Ints = new Dictionary<string, (int, int)>
    {
        ["offer_seconds"] = (10, 180), ["radius_km"] = (1, 100), ["max_active"] = (1, 10), ["max_offers"] = (1, 30),
        ["fee_fixed_paise"] = (0, 100_000), ["fee_base_paise"] = (0, 100_000), ["fee_per_km_paise"] = (0, 20_000),
        ["fee_min_paise"] = (0, 100_000), ["fee_max_paise"] = (0, 500_000), ["weather_bonus_paise"] = (0, 50_000),
        ["cod_limit_paise"] = (0, 10_000_000), ["stuck_minutes"] = (5, 720), ["location_seconds"] = (5, 300),
    };

    private static readonly IReadOnlyDictionary<string, string[]> Choices = new Dictionary<string, string[]>
    {
        ["fleet_mode"] = FleetModes, ["fee_mode"] = FeeModes,
    };

    private static readonly IReadOnlyDictionary<string, int> Texts = new Dictionary<string, int>
    {
        ["map_attribution"] = 200, ["support_phone"] = 20, ["support_whatsapp"] = 20, ["app_version"] = 20,
    };

    private static readonly string[] Urls = ["map_tiles", "android_apk_url", "play_store_url"];

    [GeneratedRegex(@"^(https://[^\s""'<>]+|/(?!/)[^\s""'<>]*)$")]
    private static partial Regex SafeUrl();

    private JsonObject? _cache;

    public async Task<JsonObject> GetAsync() => _cache ??= SettingsDAL.Merge(Defaults(), await settings.GetAsync(RowKey));

    public JsonObject Validate(JsonObject updates)
    {
        try
        {
            return ValidateUpdates(updates);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_setting");
        }
    }

    public async Task<JsonObject> UpdateAsync(JsonObject updates)
    {
        var clean = Validate(updates);
        await support.MergeSettingsAsync(RowKey, clean);
        _cache = null;
        return await GetAsync();
    }

    /// <summary>Reference: delivery_settings.update — unknown keys, ranges, choices, text caps and safe URLs.</summary>
    private static JsonObject ValidateUpdates(JsonObject updates)
    {
        var defaults = Defaults();
        var clean = new JsonObject();
        foreach (var (k, v) in updates)
        {
            if (!defaults.ContainsKey(k)) throw new ArgumentException($"Unknown setting: {k}");
            if (Ints.TryGetValue(k, out var range))
            {
                var n = (int)SettingsJson.ToLong(v);
                if (n < range.Lo || n > range.Hi) throw new ArgumentException($"{k} must be between {range.Lo} and {range.Hi}");
                clean[k] = n;
            }
            else if (Choices.TryGetValue(k, out var options))
            {
                var s = SettingsJson.Text(v);
                if (!options.Contains(s)) throw new ArgumentException($"{k} must be one of: {string.Join(", ", options)}");
                clean[k] = s;
            }
            else if (Texts.TryGetValue(k, out var max))
            {
                var s = SettingsJson.Text(v);
                if (s.Length > max) throw new ArgumentException($"{k} must be at most {max} characters");
                clean[k] = s;
            }
            else if (Urls.Contains(k))
            {
                var s = SettingsJson.Text(v);
                if (s.Length > 0 && !SafeUrl().IsMatch(s)) throw new ArgumentException($"{k} must be an https:// or site-relative URL");
                clean[k] = s;
            }
            else if (defaults[k]!.GetValueKind() is System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False)
                clean[k] = v?.GetValueKind() is System.Text.Json.JsonValueKind.True;
            else
                clean[k] = v?.DeepClone();
        }
        return clean;
    }

    /// <summary>What the partner app and the storefront need, no internal thresholds (reference: public()).</summary>
    public JsonObject Public(JsonObject cfg)
    {
        var o = new JsonObject();
        foreach (var k in new[]
        {
            "enabled", "registration_open", "offer_seconds", "proof_photo_required", "delivery_otp_required",
            "pickup_code_required", "location_seconds", "map_tiles", "map_attribution", "support_phone",
            "support_whatsapp", "android_apk_url", "play_store_url", "app_version", "require_vehicle_doc",
            "fee_mode", "fee_fixed_paise", "fee_base_paise", "fee_per_km_paise", "weather_bonus_paise",
        })
            o[k] = cfg[k]?.DeepClone();
        o["vehicles"] = new JsonObject(VehicleLabels.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray());
        o["id_proofs"] = new JsonObject(IdProofs.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray());
        o["reject_reasons"] = new JsonObject(RejectReasons.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray());
        o["fail_reasons"] = new JsonObject(FailReasons.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray());
        return o;
    }
}
