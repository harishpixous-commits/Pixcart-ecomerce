using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// The site in other languages (reference: services/translate.py). Pages send the text they show in batches. Known
/// lines come from the translations table, then the built-in Tamil and Hindi files (BAL/Assets/i18n, embedded); new
/// ones go to the AI when the admin allows it, within a daily limit. Without an AI model, untranslated lines stay English.
/// </summary>
public partial class TranslateBAL(
    RegionalDAL translations,
    CatalogSupportDAL support,
    IRegionalBAL regional,
    IEnumerable<IAiAvailability> ai,
    IEnumerable<ITranslationEngine> engines,
    ILogger<TranslateBAL> log) : ITranslateBAL
{
    public const int MaxTexts = 80;   // per request
    public const int MaxLen = 400;    // longer text (descriptions, reviews) is not interface text

    public static readonly IReadOnlyDictionary<string, string> LangNames = new Dictionary<string, string>
    {
        ["hi"] = "Hindi", ["ta"] = "Tamil", ["te"] = "Telugu", ["kn"] = "Kannada", ["ml"] = "Malayalam", ["mr"] = "Marathi", ["bn"] = "Bengali",
        ["gu"] = "Gujarati", ["pa"] = "Punjabi", ["or"] = "Odia", ["as"] = "Assamese", ["ur"] = "Urdu", ["ar"] = "Arabic", ["fr"] = "French",
        ["de"] = "German", ["es"] = "Spanish", ["pt"] = "Portuguese", ["pt-BR"] = "Brazilian Portuguese", ["it"] = "Italian", ["nl"] = "Dutch",
        ["ru"] = "Russian", ["tr"] = "Turkish", ["zh"] = "Simplified Chinese", ["zh-TW"] = "Traditional Chinese", ["ja"] = "Japanese",
        ["ko"] = "Korean", ["id"] = "Indonesian", ["ms"] = "Malay", ["th"] = "Thai", ["vi"] = "Vietnamese", ["fil"] = "Filipino", ["si"] = "Sinhala",
        ["ne"] = "Nepali", ["sw"] = "Swahili", ["fa"] = "Persian", ["he"] = "Hebrew", ["pl"] = "Polish", ["uk"] = "Ukrainian", ["sv"] = "Swedish",
    };

    /// <summary>The house rules the AI gets (the translation module's prompt), kept here for the AI module to use.</summary>
    public const string Rules =
        "You translate the interface text of an Indian online marketplace (shop, seller hub, delivery app, admin panel).\n" +
        "Translate each string in the JSON array into {language}. Rules:\n" +
        "- Return ONLY a JSON array of strings, the same length and order as the input. No notes.\n" +
        "- Keep it short and natural, as a native app in {language} would say it. Use the polite form for customers.\n" +
        "- Keep unchanged: brand names (PixCart, Razorpay, Google Pay, PhonePe, Paytm, UPI, GST, GSTIN, OTP, COD, UPI ID), numbers,\n" +
        "  amounts, currency symbols, codes, email addresses, web addresses, emoji and placeholders like {{name}}, {0} or %s.\n" +
        "- Keep leading and trailing punctuation (… : · ?), and keep words in CAPITALS as they are when they are codes.\n" +
        "- If a string is already in {language}, or is a name or code that should not change, return it unchanged.";

    [GeneratedRegex(@"[^\W\d_]")]
    private static partial Regex Letter();

    public static string Key(string text) => Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(text)));

    public static bool WorthTranslating(string text)
    {
        var t = text.Trim();
        return t.Length > 0 && t.Length <= MaxLen && Letter().IsMatch(t);
    }

    private static readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, string>> BuiltinCache = new();

    public IReadOnlyDictionary<string, string> Builtin(string lang) => BuiltinCache.GetOrAdd(lang, l =>
    {
        var asm = typeof(TranslateBAL).Assembly;
        var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith($".i18n.{l}.json", StringComparison.Ordinal));
        if (name == null) return new Dictionary<string, string>();
        try
        {
            using var s = asm.GetManifestResourceStream(name)!;
            return JsonSerializer.Deserialize<Dictionary<string, string>>(s) ?? new Dictionary<string, string>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    });

    public async Task<Dictionary<string, string>> LookupAsync(string lang, IReadOnlyCollection<string> texts)
    {
        if (texts.Count == 0) return [];
        var hashes = new Dictionary<string, string>();
        foreach (var t in texts) hashes[Key(t)] = t;
        var found = new Dictionary<string, string>();
        foreach (var (h, text) in await translations.LookupAsync(lang, hashes.Keys))
            if (hashes.TryGetValue(h, out var src)) found[src] = text;
        var ship = Builtin(lang);
        foreach (var t in texts)
            if (!found.ContainsKey(t) && ship.TryGetValue(t, out var tr)) found[t] = tr;
        return found;
    }

    public Task SaveAsync(string lang, IReadOnlyDictionary<string, string> pairs, string origin) =>
        pairs.Count == 0 ? Task.CompletedTask : translations.SaveAsync(lang, pairs.Select(kv => (Key(kv.Key), kv.Key, kv.Value)), origin);

    private async Task<bool> ConfiguredAsync()
    {
        foreach (var a in ai)
            if (await a.ConfiguredAsync("translate")) return true;
        return false;
    }

    public async Task<Dictionary<string, string>> TranslateAsync(JsonObject cfg, string lang, IEnumerable<string> texts)
    {
        var enabled = (cfg["languages"] as JsonArray ?? []).OfType<JsonObject>().Where(x => SettingsJson.Truthy(x["enabled"]))
            .Select(x => CatalogText.Str(x["code"])).ToHashSet();
        if (lang == "en" || !enabled.Contains(lang)) throw new AppException("That language is not switched on", "language_off", 404);
        var list = texts.Where(t => t != null && WorthTranslating(t)).Distinct().Take(MaxTexts).ToList();
        var found = await LookupAsync(lang, list);
        var missing = list.Where(t => !found.ContainsKey(t)).ToList();
        if (missing.Count > 0 && SettingsJson.Truthy(cfg["ai_translate"]))
        {
            var budget = SettingsJson.ToLong(cfg["ai_translate_daily_max"]) - await translations.AiUsedSinceAsync(DateTimeFunctions.UtcNow().AddDays(-1));
            var engine = engines.FirstOrDefault();
            if (budget > 0 && engine != null && await ConfiguredAsync())
            {
                var fresh = new Dictionary<string, string>();
                try
                {
                    var got = await engine.TranslateAsync(lang, LangNames.GetValueOrDefault(lang, lang), missing.Take((int)Math.Min(budget, int.MaxValue)).ToList());
                    foreach (var (src, tr) in got)
                        if (missing.Contains(src) && !string.IsNullOrWhiteSpace(tr) && tr.Length <= MaxLen * 3) fresh[src] = tr;
                }
                catch (AppException e) // no model answered: keep English for now
                {
                    log.LogWarning("translation to {Lang} failed: {Error}", lang, e.Message);
                }
                await SaveAsync(lang, fresh, "ai");
                foreach (var (k, v) in fresh) found[k] = v;
            }
        }
        return found;
    }

    public async Task<JsonObject> TranslateTextsAsync(string lang, IReadOnlyList<string> texts, string ip)
    {
        await support.RateLimitAsync($"i18n:{ip}", 600, 3600);
        var cfg = await regional.GetAsync();
        var found = await TranslateAsync(cfg, lang, texts);
        return new JsonObject
        {
            ["lang"] = lang,
            ["translations"] = new JsonObject(found.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value))),
        };
    }

    public async Task<JsonObject> ListAsync(string lang, string q, string origin, int page)
    {
        var text = q.Trim();
        var total = await translations.CountAsync(lang, text, origin);
        var rows = await translations.PageAsync(lang, text, origin, 50, (page - 1) * 50);
        return new JsonObject
        {
            ["total"] = total,
            ["page"] = page,
            ["items"] = CatalogBAL.Arr(rows.Select(r => (JsonNode)new JsonObject
            {
                ["id"] = r.Id.ToString(), ["source"] = r.Source, ["text"] = r.Text, ["origin"] = r.Origin, ["updated_at"] = DateTimeFunctions.Iso(r.UpdatedAt),
            })),
        };
    }

    public async Task<JsonObject> SaveCorrectionAsync(UserModel admin, string lang, string source, string text)
    {
        await SaveAsync(lang, new Dictionary<string, string> { [source] = text.Trim() }, "manual");
        await support.AuditAsync(admin.Id, "translation.edit", "translation", lang, CatalogText.Cut(source, 120));
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> ClearAsync(UserModel admin, string lang, string id, bool onlyAi)
    {
        var n = await translations.DeleteAsync(lang, id, onlyAi);
        await support.AuditAsync(admin.Id, "translation.clear", "translation", lang, $"{n} lines");
        return new JsonObject { ["removed"] = n };
    }
}
