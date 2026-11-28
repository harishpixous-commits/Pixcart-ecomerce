using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Admin-editable marketplace settings with safe defaults (reference: services/platform_settings.py).
/// Statutory rates are settings, not constants, because they change by notification: GST TCS is 0.5% since
/// 10 July 2024 and income-tax TDS on e-commerce operators is 0.1% since 1 October 2024.
/// </summary>
public partial class PlatformSettingsBAL(SettingsDAL settings, CatalogSupportDAL support) : IPlatformSettingsBAL
{
    public const string RowKey = "marketplace";

    /// <summary>Admin panel layouts staff can pick (the default is a setting).</summary>
    public static readonly string[] AdminLayouts = ["sidebar", "topnav", "rail", "glass"];

    /// <summary>The defaults, in the reference order (a fresh copy each time).</summary>
    public static JsonObject Defaults() => new()
    {
        ["shipping_fee_paise"] = 4000,
        ["free_shipping_threshold_paise"] = 49900,
        ["cod_enabled"] = true,
        ["cod_fee_paise"] = 0,
        ["cod_max_order_paise"] = 5_000_000,
        ["tcs_bps"] = 50,
        ["tds_bps"] = 10,
        ["commission_gst_bps"] = 1800,
        ["max_qty_per_item"] = 10,
        ["low_stock_threshold"] = 5,
        ["feature_wishlist"] = true,
        ["feature_reviews"] = true,
        ["feature_returns"] = true,
        ["feature_coupons"] = true,
        ["feature_support"] = true,
        ["reviews_need_approval"] = false,
        ["auto_approve_returns"] = false,
        ["defect_return_days"] = 7,
        ["transit_days_same_city"] = 1,
        ["transit_days_same_state"] = 3,
        ["transit_days_national"] = 6,
        ["auto_cancel_unconfirmed_hours"] = 72,
        ["auto_payouts"] = false,
        ["payout_weekday"] = 0,
        ["payout_every_weeks"] = 1,
        ["gallery_zoom"] = true,
        ["gallery_zoom_level"] = 25,
        ["feature_product_videos"] = true,
        ["max_video_mb"] = 50,
        ["max_videos_per_listing"] = 3,
        ["payout_min_paise"] = 10000,
        ["pdp_unit_price"] = true,
        ["pdp_bought_count"] = true,
        ["pdp_bought_min"] = 10,
        ["pdp_bestseller_badge"] = true,
        ["pdp_offers"] = true,
        ["pdp_offers_max"] = 4,
        ["pdp_service_icons"] = true,
        ["pdp_key_specs"] = true,
        ["pdp_delivery_countdown"] = true,
        ["pdp_seller_snapshot"] = true,
        ["top_seller_min_rating_x10"] = 40,
        ["top_seller_min_orders"] = 20,
        ["pdp_customer_media"] = true,
        ["pdp_share"] = true,
        ["pdp_report"] = true,
        ["pdp_ask_assistant"] = true,
        ["pdp_sticky_bar"] = true,
        ["pdp_similar"] = true,
        ["pdp_recently_viewed"] = true,
        ["header_pincode"] = true,
        ["page_loading_bar"] = true,
        ["feature_deals"] = true,
        ["deals_need_approval"] = true,
        ["deal_min_discount_pct"] = 10,
        ["deal_max_hours_lightning"] = 12,
        ["deal_max_hours_day"] = 24,
        ["deal_max_days_limited"] = 14,
        ["feature_ads"] = true,
        ["ads_need_approval"] = true,
        ["ads_min_bid_paise"] = 300,
        ["ads_min_daily_budget_paise"] = 10000,
        ["ads_search"] = true,
        ["ads_product"] = true,
        ["ads_home"] = true,
        ["ads_per_search"] = 2,
        ["ads_per_rail"] = 8,
        ["ads_paid_clicks_per_address"] = 3,
        ["ads_paid_clicks_per_network"] = 10,
        ["new_release_days"] = 45,
        ["feature_qa"] = true,
        ["qa_need_approval"] = false,
        ["qa_buyers_answer_only"] = false,
        ["qa_report_hide_at"] = 3,
        ["feature_stock_alerts"] = true,
        ["feature_price_alerts"] = true,
        ["price_alert_min_drop_pct"] = 10,
        ["feature_compare"] = true,
        ["feature_bought_together"] = true,
        ["search_page_size"] = 24,
        ["search_synonyms"] = "",
        ["search_suggestions"] = 8,
        ["recent_searches_max"] = 8,
        ["brand_filter_max"] = 30,
        ["similar_products"] = 12,
        ["sponsored_on_product"] = 10,
        ["highlights_shown"] = 5,
        ["customer_photos_shown"] = 6,
        ["reviews_page_size"] = 10,
        ["questions_page_size"] = 10,
        ["bestseller_badge_top"] = 10,
        ["recently_viewed_max"] = 12,
        ["compare_max"] = 4,
        ["checkout_suggestions"] = 10,
        ["admin_layout_default"] = "sidebar",
        ["payment_window_minutes"] = 30,
        ["customer_cancel_until"] = "packed",
        ["payment_return_mode"] = "return",
        ["maintenance_mode"] = false,
        ["maintenance_message"] = "We are making a few improvements and will be back shortly. Thank you for your patience.",
        ["not_found_title"] = "We couldn't find that page",
        ["not_found_message"] = "The link may be old, or the product is no longer sold. Try a search, or pick from what other shoppers are buying.",
        ["not_found_search"] = true,
        ["not_found_suggestions"] = true,
        ["error_title"] = "Something went wrong on our side",
        ["error_message"] = "Please try again. If it keeps happening, contact us and quote the reference shown below.",
        ["shop_app_banner"] = true,
        ["shop_android_apk_url"] = "",
        ["shop_play_store_url"] = "",
        ["shop_app_store_url"] = "",
        ["shop_app_version"] = "",
    };

    /// <summary>key → longest; "" or an http(s) link.</summary>
    public static readonly IReadOnlyDictionary<string, int> Urls = new Dictionary<string, int>
    {
        ["shop_android_apk_url"] = 500, ["shop_play_store_url"] = 500, ["shop_app_store_url"] = 500,
    };

    /// <summary>key → longest; any short text, may be empty.</summary>
    public static readonly IReadOnlyDictionary<string, int> ShortTexts = new Dictionary<string, int> { ["shop_app_version"] = 20 };

    public static readonly string[] AppKeys = ["shop_app_banner", "shop_android_apk_url", "shop_play_store_url", "shop_app_store_url", "shop_app_version"];

    /// <summary>The error pages' settings the storefront needs (sent with /api/site as error_pages).</summary>
    public static readonly string[] ErrorPageKeys = ["not_found_title", "not_found_message", "not_found_search", "not_found_suggestions", "error_title", "error_message"];

    /// <summary>key → (shortest, longest) for free-text settings (spaces tidied).</summary>
    public static readonly IReadOnlyDictionary<string, (int Min, int Max)> Texts = new Dictionary<string, (int, int)>
    {
        ["maintenance_message"] = (10, 300), ["not_found_title"] = (3, 80), ["not_found_message"] = (10, 300),
        ["error_title"] = (3, 80), ["error_message"] = (10, 300), ["search_synonyms"] = (0, 1000),
    };

    /// <summary>The list sizes the storefront needs (sent with /api/site as lists).</summary>
    public static readonly string[] ListKeys =
    [
        "search_page_size", "search_suggestions", "recent_searches_max", "brand_filter_max", "similar_products", "sponsored_on_product",
        "highlights_shown", "customer_photos_shown", "reviews_page_size", "questions_page_size", "bestseller_badge_top", "recently_viewed_max",
        "compare_max", "checkout_suggestions",
    ];

    /// <summary>key → the values a text setting may take.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Choices = new Dictionary<string, string[]>
    {
        ["admin_layout_default"] = AdminLayouts,
        ["customer_cancel_until"] = ["placed", "confirmed", "packed"],
        ["payment_return_mode"] = ["return", "window"],
    };

    /// <summary>key → (is a switch, min, max).</summary>
    public static readonly IReadOnlyDictionary<string, (bool IsBool, long Min, long Max)> Limits = BuildLimits();

    private static Dictionary<string, (bool, long, long)> BuildLimits()
    {
        var ints = new (string, long, long)[]
        {
            ("shipping_fee_paise", 0, 100_000), ("free_shipping_threshold_paise", 0, 10_000_000), ("payment_window_minutes", 10, 120),
            ("cod_fee_paise", 0, 10_000), ("cod_max_order_paise", 0, 100_000_000), ("tcs_bps", 0, 100), ("tds_bps", 0, 500),
            ("commission_gst_bps", 0, 2800), ("max_qty_per_item", 1, 10), ("low_stock_threshold", 1, 1000), ("search_page_size", 8, 60),
            ("search_suggestions", 1, 12), ("recent_searches_max", 0, 20), ("brand_filter_max", 5, 100), ("similar_products", 0, 24),
            ("sponsored_on_product", 0, 20), ("highlights_shown", 1, 20), ("customer_photos_shown", 0, 20), ("reviews_page_size", 5, 50),
            ("questions_page_size", 5, 50), ("bestseller_badge_top", 1, 100), ("recently_viewed_max", 4, 30), ("compare_max", 2, 6),
            ("checkout_suggestions", 0, 20), ("defect_return_days", 0, 30), ("transit_days_same_city", 0, 15), ("transit_days_same_state", 0, 20),
            ("transit_days_national", 0, 30), ("auto_cancel_unconfirmed_hours", 0, 720), ("payout_weekday", 0, 6), ("payout_every_weeks", 1, 2),
            ("gallery_zoom_level", 15, 40), ("max_video_mb", 5, 200), ("max_videos_per_listing", 0, 10), ("payout_min_paise", 100, 10_000_000),
            ("pdp_bought_min", 1, 100_000), ("pdp_offers_max", 1, 10), ("top_seller_min_rating_x10", 30, 50), ("top_seller_min_orders", 1, 100_000),
            ("deal_min_discount_pct", 1, 90), ("deal_max_hours_lightning", 1, 24), ("deal_max_hours_day", 1, 48), ("deal_max_days_limited", 1, 60),
            ("ads_min_bid_paise", 100, 100_000), ("ads_min_daily_budget_paise", 1000, 10_000_000), ("ads_per_search", 0, 6), ("ads_per_rail", 4, 20),
            ("ads_paid_clicks_per_address", 1, 50), ("ads_paid_clicks_per_network", 1, 500), ("new_release_days", 7, 180),
            ("qa_report_hide_at", 0, 50), ("price_alert_min_drop_pct", 1, 90),
        };
        var bools = new[]
        {
            "cod_enabled", "maintenance_mode", "shop_app_banner", "not_found_search", "not_found_suggestions", "feature_wishlist", "feature_reviews",
            "feature_returns", "feature_coupons", "feature_support", "reviews_need_approval", "auto_approve_returns", "auto_payouts", "gallery_zoom",
            "feature_product_videos", "pdp_unit_price", "pdp_bought_count", "pdp_bestseller_badge", "pdp_offers", "pdp_service_icons", "pdp_key_specs",
            "pdp_delivery_countdown", "pdp_seller_snapshot", "pdp_customer_media", "pdp_share", "pdp_report", "pdp_ask_assistant", "pdp_sticky_bar",
            "pdp_similar", "pdp_recently_viewed", "header_pincode", "page_loading_bar", "feature_deals", "deals_need_approval", "feature_ads",
            "ads_need_approval", "ads_search", "ads_product", "ads_home", "feature_qa", "qa_need_approval", "qa_buyers_answer_only",
            "feature_stock_alerts", "feature_price_alerts", "feature_compare", "feature_bought_together",
        };
        var d = new Dictionary<string, (bool, long, long)>();
        foreach (var b in bools) d[b] = (true, 0, 1);
        foreach (var (k, lo, hi) in ints) d[k] = (false, lo, hi);
        return d;
    }

    /// <summary>What a shopper can report about a product (Admin → Product reports).</summary>
    public static readonly IReadOnlyDictionary<string, string> ProductReportReasons = new Dictionary<string, string>
    {
        ["wrong_info"] = "Wrong or missing product information", ["counterfeit"] = "Fake or counterfeit product",
        ["unsafe"] = "Unsafe, expired or harmful", ["prohibited"] = "Not allowed to be sold", ["offensive"] = "Offensive images or text",
        ["price"] = "Lower price elsewhere / misleading price", ["other"] = "Something else",
    };

    /// <summary>Why a customer returns an item.</summary>
    public static readonly IReadOnlyDictionary<string, string> ReturnReasons = new Dictionary<string, string>
    {
        ["damaged"] = "Item arrived damaged", ["defective"] = "Item does not work", ["wrong_item"] = "Received a different item",
        ["not_as_described"] = "Not as described or shown", ["size_fit"] = "Size or fit is not right",
        ["missing_parts"] = "Parts or accessories missing", ["quality"] = "Quality is not as expected",
    };

    /// <summary>The seller's fault: accepted for defect_return_days even when the listing is not returnable.</summary>
    public static readonly string[] DefectReasons = ["damaged", "defective", "wrong_item", "missing_parts"];

    private JsonObject? _cache;

    public async Task<JsonObject> GetAsync() => _cache ??= SettingsDAL.Merge(Defaults(), await settings.GetAsync(RowKey));

    /// <summary>Locked merge of already-validated updates inside the caller's transaction (reference:
    /// update_settings' single session, so the audit row commits with the change).</summary>
    public async Task MergeValidatedAsync(JsonObject clean, IUnitOfWork uow) =>
        await support.MergeSettingsAsync(RowKey, clean, uow);

    /// <summary>Drops the cached settings after an outside-the-service write.</summary>
    public void InvalidateCache() => _cache = null;

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

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    /// <summary>Python's " ".join(text.split()).</summary>
    public static string Tidy(string text) => Spaces().Replace(text, " ").Trim();

    /// <summary>The reference validate_updates: throws ArgumentException with the same messages.</summary>
    public static JsonObject ValidateUpdates(JsonObject updates)
    {
        var clean = new JsonObject();
        foreach (var (key, value) in updates)
        {
            var kind = value?.GetValueKind();
            var isString = kind == JsonValueKind.String;
            if (Choices.TryGetValue(key, out var choices))
            {
                if (!isString || !choices.Contains(value!.GetValue<string>()))
                    throw new ArgumentException($"{key} must be one of: {string.Join(", ", choices)}");
                clean[key] = value!.GetValue<string>();
                continue;
            }
            if (Urls.TryGetValue(key, out var urlMax))
            {
                var s = isString ? value!.GetValue<string>() : null;
                var t = s?.Trim() ?? "";
                if (s is null || s.Length > urlMax ||
                    (t.Length > 0 && !(t.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || t.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || t.StartsWith('/'))))
                    throw new ArgumentException($"{key} must be a link starting with https://");
                clean[key] = t;
                continue;
            }
            if (ShortTexts.TryGetValue(key, out var shortMax))
            {
                var s = isString ? value!.GetValue<string>() : null;
                if (s is null || s.Trim().Length > shortMax) throw new ArgumentException($"{key} must be at most {shortMax} characters");
                clean[key] = s.Trim();
                continue;
            }
            if (Texts.TryGetValue(key, out var range))
            {
                var s = isString ? Tidy(value!.GetValue<string>()) : null;
                if (s is null || s.Length < range.Min || s.Length > range.Max)
                    throw new ArgumentException($"{key} must be text of {range.Min} to {range.Max} characters");
                clean[key] = key == "search_synonyms" ? Utils.TextSearch.SearchSynonyms.Normalize(string.Join(";", value!.GetValue<string>().Replace("\n", ";").Split(';').Select(Tidy))) : s;
                continue;
            }
            if (!Limits.TryGetValue(key, out var lim)) throw new ArgumentException($"Unknown setting: {key}");
            if (lim.IsBool)
            {
                if (kind is not (JsonValueKind.True or JsonValueKind.False)) throw new ArgumentException($"{key} must be true or false");
                clean[key] = kind == JsonValueKind.True;
            }
            else
            {
                if (!SettingsJson.IsWholeNumber(value, out var n) || n < lim.Min || n > lim.Max)
                    throw new ArgumentException($"{key} must be a whole number between {lim.Min} and {lim.Max}");
                clean[key] = n;
            }
        }
        return clean;
    }
}
