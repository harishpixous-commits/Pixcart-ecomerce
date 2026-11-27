using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.ShopAssistant;

/// <summary>The shop assistant's knowledge: help articles, published storefront pages and a whitelist of public
/// settings. Reference: shop_assistant/kb.py. Nothing else is readable from here.</summary>
public static class ShopKb
{
    private static readonly HashSet<string> Stop = new(
        "a an the i me my we our you your is are am was were be to of in on for at by with and or but if so do does did can could would should will shall please pls plz hi hello hey want need know tell about how what when where which who why this that it its from as have has had not no yes ok okay sir madam bro na da pa la ah oh enna epdi eppadi ennoda en".Split());

    /// <summary>Rupees from paise, the way the storefront writes it (reference: kb.inr).</summary>
    public static string Inr(long paise)
    {
        var rupees = paise / 100m;
        return rupees == Math.Floor(rupees) ? FormattableString.Invariant($"₹{rupees:#,0}") : FormattableString.Invariant($"₹{rupees:#,0.00}");
    }

    public static string Normalize(string text)
    {
        var t = (text ?? "").Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        return Regex.Replace(t, @"[^\w\s₹]+", " ").Trim();
    }

    public static List<string> Tokens(string text) =>
        Normalize(text).Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => !Stop.Contains(t) && t.Length > 1).ToList();

    /// <summary>{placeholder} fill from public facts; unknown placeholders stay as-is (reference: kb.render).</summary>
    public static string Render(string text, IReadOnlyDictionary<string, object?> facts)
    {
        return Regex.Replace(text ?? "", @"\{(\w+)\}", m =>
            facts.TryGetValue(m.Groups[1].Value, out var v) && v is string or int or long ? v!.ToString()! : m.Value);
    }

    public static string GetStr(JsonObject o, string key, string fallback = "") =>
        o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : fallback;

    public static long GetLong(JsonObject o, string key, long fallback = 0)
    {
        if (o.TryGetPropertyValue(key, out var n) && n is JsonValue v)
        {
            if (v.TryGetValue<long>(out var l)) return l;
            if (v.TryGetValue<int>(out var i)) return i;
        }
        return fallback;
    }

    public static bool GetBool(JsonObject o, string key, bool fallback = false)
    {
        if (o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b)) return b;
        return fallback;
    }

    /// <summary>The marketplace's own fees as a shopper would read them (reference: kb.fees_text).</summary>
    public static string FeesText(JsonObject ck)
    {
        var parts = new List<string>();
        if (GetBool(ck, "handling_enabled") && GetLong(ck, "handling_paise") > 0)
        {
            var free = GetLong(ck, "handling_free_above_paise") > 0
                ? $", free on orders of {Inr(GetLong(ck, "handling_free_above_paise"))} or more" : "";
            parts.Add($"{GetStr(ck, "handling_label")} {Inr(GetLong(ck, "handling_paise"))} per order{free}");
        }
        if (GetBool(ck, "small_cart_enabled") && GetLong(ck, "small_cart_paise") > 0)
            parts.Add($"{GetStr(ck, "small_cart_label")} {Inr(GetLong(ck, "small_cart_paise"))} when the item total is below {Inr(GetLong(ck, "small_cart_below_paise"))}");
        if (GetBool(ck, "platform_enabled") && GetLong(ck, "platform_paise") > 0)
            parts.Add($"{GetStr(ck, "platform_label")} {Inr(GetLong(ck, "platform_paise"))} per order");
        if (FeesBAL.SurgeActive(ck))
            parts.Add($"{GetStr(ck, "surge_label")} {Inr(GetLong(ck, "surge_paise"))} per order right now ({GetStr(ck, "surge_info").TrimEnd('.')})");
        if (GetBool(ck, "late_night_enabled") && GetLong(ck, "late_night_paise") > 0)
            parts.Add($"{GetStr(ck, "late_night_label")} {Inr(GetLong(ck, "late_night_paise"))} on orders placed between " +
                      $"{FeesBAL.Clock(GetStr(ck, "late_night_from"))} and {FeesBAL.Clock(GetStr(ck, "late_night_to"))}");
        var text = parts.Count > 0
            ? "Besides delivery, the bill can include: " + string.Join("; ", parts) + ". These fees include GST."
            : "Besides delivery (and the cash on delivery fee, if any), there are no extra fees on your order.";
        if (GetBool(ck, "tip_enabled"))
            text += " You can add a tip for the delivery partner at checkout; it goes to them in full.";
        return text + " Every charge is shown on the bill before you pay; tap a fee's name to read why it applies.";
    }

    /// <summary>Customer-facing facts only (reference: kb.public_facts). Add a key deliberately; never pass settings through.</summary>
    public static Dictionary<string, object?> PublicFacts(JsonObject cfg, JsonObject site, JsonObject checkout)
    {
        var business = site["business"] as JsonObject ?? [];
        var g = business["grievance"] as JsonObject ?? [];
        var brand = GetStr(site, "brand_name");
        var codEnabled = GetBool(cfg, "cod_enabled");
        var cod = codEnabled
            ? $"Cash on delivery is available on orders up to {Inr(GetLong(cfg, "cod_max_order_paise"))}"
              + (GetLong(cfg, "cod_fee_paise") > 0 ? $" (COD fee {Inr(GetLong(cfg, "cod_fee_paise"))})" : "")
              + ". Pay the courier in cash or by UPI when the package arrives."
            : "Cash on delivery is not available right now; please pay online with UPI, card or net banking.";
        var contact = string.Join(", ", new[] { GetStr(g, "email"), GetStr(g, "phone") }.Where(x => x.Length > 0));
        var grievance = $"Our Grievance Officer is {(GetStr(g, "name").Length > 0 ? GetStr(g, "name") : "the Grievance Officer")}"
            + (contact.Length > 0 ? $" ({contact})" : "")
            + (GetStr(g, "hours").Length > 0 ? $", available {GetStr(g, "hours")}" : "")
            + ". Complaints are acknowledged within 48 hours and resolved within one month. "
            + "You can also raise a grievance from the Support page.";
        return new Dictionary<string, object?>
        {
            ["brand"] = brand.Length > 0 ? brand : "our store",
            ["shipping_fee"] = Inr(GetLong(cfg, "shipping_fee_paise")),
            ["free_delivery_amount"] = Inr(GetLong(cfg, "free_shipping_threshold_paise")),
            ["cod_enabled"] = codEnabled,
            ["cod_text"] = cod,
            ["fees_text"] = FeesText(checkout),
            ["transit_same_city"] = GetLong(cfg, "transit_days_same_city"),
            ["transit_same_state"] = GetLong(cfg, "transit_days_same_state"),
            ["transit_national"] = GetLong(cfg, "transit_days_national"),
            ["returns_enabled"] = GetBool(cfg, "feature_returns"),
            ["support_enabled"] = GetBool(cfg, "feature_support"),
            ["coupons_enabled"] = GetBool(cfg, "feature_coupons"),
            ["return_reasons"] = PlatformSettingsBAL.ReturnReasons.Values.ToList(),
            ["grievance_text"] = grievance,
        };
    }

    public sealed record Hit(string Id, string Title, string Body, string Link, string Source, double Score);

    /// <summary>Keyword/token search over published articles and pages (reference: kb.search).</summary>
    public static List<Hit> Search(string query, IReadOnlyList<ShopKbArticleModel> arts, IReadOnlyList<CmsPageModel> pages,
        IReadOnlyDictionary<string, object?> facts, int limit = 3, double minScore = 2.0)
    {
        var qNorm = $" {Normalize(query)} ";
        var qTokens = Tokens(query).ToHashSet();
        if (qTokens.Count == 0 && qNorm.Trim().Length == 0) return [];
        var hits = new List<Hit>();
        foreach (var a in arts)
        {
            var score = 0.0;
            foreach (var kw0 in JsonHelper.Array(a.Keywords))
            {
                var k = Normalize(kw0?.ToString() ?? "");
                if (k.Length > 0 && qNorm.Contains($" {k} "))
                    score += 3 + 0.5 * (k.Split(' ').Length - 1);
            }
            var titleT = Tokens(Render(a.Title, facts)).ToHashSet();
            score += 1.5 * qTokens.Intersect(titleT).Count();
            score += Math.Min(1.5, 0.3 * qTokens.Intersect(Tokens(a.Body).ToHashSet()).Count());
            if (score > 0)
                hits.Add(new Hit(a.Id.ToString(), Render(a.Title, facts), Render(a.Body, facts), a.Link, "article", score));
        }
        foreach (var p in pages)
        {
            var score = 1.5 * qTokens.Intersect(Tokens(p.Title).ToHashSet()).Count()
                + Math.Min(1.0, 0.2 * qTokens.Intersect(Tokens(p.Body).ToHashSet()).Count());
            if (score > 0)
                hits.Add(new Hit($"page:{p.Slug}", p.Title, p.Body[..Math.Min(1200, p.Body.Length)], $"/pages/{p.Slug}", "page", score));
        }
        return hits.OrderByDescending(h => h.Score).ThenBy(h => h.Source != "article")
            .Where(h => h.Score >= minScore).Take(limit).ToList();
    }
}
