using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DAL;
using Utils;

namespace BAL.AI;

/// <summary>AI settings edited in Admin → AI studio, stored in platform_settings["ai"] (same defaults and rules as the reference).</summary>
public static class AiSettings
{
    public const string Key = "ai";
    private static readonly Regex Model = new(@"^claude-[a-z0-9][a-z0-9.\-]{2,60}$");
    private static readonly Regex Control = new(@"[\x00-\x08\x0b-\x1f\x7f]");

    /// <summary>Offered in the model picker; any claude-* id can still be typed for newer models.</summary>
    public static JsonArray Models() =>
    [
        J.O(("id", "claude-haiku-5-5"), ("label", "Claude Haiku 5.5 — fastest, lowest cost")),
        J.O(("id", "claude-sonnet-5-5"), ("label", "Claude Sonnet 5.5 — balanced")),
        J.O(("id", "claude-opus-5-5"), ("label", "Claude Opus 5.5 — most capable")),
    ];

    public static JsonObject Defaults(AppSettings env) => J.O(
        ("enabled", true),
        ("model", env.AiModel),
        ("monthly_token_budget", 5_000_000), // input + output tokens per calendar month (IST); 0 = no limit
        ("price_input_per_mtok", 1.0), // USD per million tokens, for the cost estimate only
        ("price_output_per_mtok", 5.0),
        ("brand_voice", "Warm, clear and respectful of the shopper's time. Simple Indian English."),
        ("tasks", new JsonObject()));

    public static JsonObject Merge(JsonObject saved, AppSettings env) => DAL.SettingsDAL.Merge(Defaults(env), saved);

    public static async Task<JsonObject> GetAsync(AiDAL dal, AppSettings env) => Merge(await dal.SettingAsync(Key), env);

    public static (bool Enabled, string Instructions) Task(JsonObject cfg, string task)
    {
        var t = (cfg["tasks"] as JsonObject)?[task] as JsonObject ?? [];
        return (t["enabled"] is null || J.Truthy(t["enabled"]), J.S(t["instructions"]));
    }

    public static JsonObject Validate(JsonObject data, IEnumerable<string> taskKeys, AppSettings env)
    {
        var cfg = Merge(data, env);
        if (!J.IsBool(cfg["enabled"])) throw new ArgumentException("enabled must be true or false");
        if (!Model.IsMatch(J.S(cfg["model"]))) throw new ArgumentException("Choose a Claude model, e.g. claude-haiku-5-5");
        var budget = cfg["monthly_token_budget"];
        if (!J.IsInt(budget) || J.Long(budget) is not (>= 0 and <= 2_000_000_000))
            throw new ArgumentException("The monthly token budget must be a whole number (0 for no limit)");
        foreach (var k in new[] { "price_input_per_mtok", "price_output_per_mtok" })
        {
            if (!J.IsNumber(cfg[k]) || J.Double(cfg[k]) is not (>= 0 and <= 1000)) throw new ArgumentException("Prices must be numbers between 0 and 1000");
        }
        var voice = Control.Replace(J.S(cfg["brand_voice"]), "");
        cfg["brand_voice"] = J.Cut(voice, 600).Trim();
        var keys = taskKeys.ToHashSet();
        var tasks = new JsonObject();
        foreach (var (k, v) in cfg["tasks"] as JsonObject ?? [])
        {
            if (!keys.Contains(k) || v is not JsonObject t) continue;
            tasks[k] = J.O(("enabled", t["enabled"] is null || J.Truthy(t["enabled"])),
                // extra instructions refine tone and content; they cannot replace the task's fixed safety rules
                ("instructions", J.Cut(Control.Replace(J.S(t["instructions"]), ""), 1000).Trim()));
        }
        cfg["tasks"] = tasks;
        return cfg;
    }

    public static double CostUsd(JsonObject cfg, long inputTokens, long outputTokens) =>
        Math.Round(inputTokens / 1e6 * (J.Double(cfg["price_input_per_mtok"]) ?? 0) + outputTokens / 1e6 * (J.Double(cfg["price_output_per_mtok"]) ?? 0), 4);
}
