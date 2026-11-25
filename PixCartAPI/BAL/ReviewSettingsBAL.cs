using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Utils;

namespace BAL;

/// <summary>
/// Ratings and reviews settings (reference: services/review_settings.py). The defaults follow common Indian marketplace
/// practice and BIS IS 19000:2022: only signed-in customers write, verified buyers by default, photos and videos must be
/// the reviewer's own, anyone can read, and reports from customers send a review back to staff.
/// </summary>
public partial class ReviewSettingsBAL(SettingsDAL settings, CatalogSupportDAL support) : IReviewSettingsBAL
{
    public const string Key = "reviews";

    public static JsonArray DefaultTopics() =>
    [
        Topic("Quality", "quality", "build", "material", "durable", "sturdy", "flimsy", "premium"),
        Topic("Value for money", "value", "worth", "money", "price", "expensive", "costly", "overpriced"),
        Topic("Effectiveness", "effective", "works", "working", "result", "results", "useless", "not working"),
        Topic("Size and fit", "size", "fit", "fits", "fitting", "tight", "loose"),
        Topic("Taste", "taste", "tasty", "flavour", "flavor", "aroma", "fresh"),
        Topic("Fragrance", "smell", "fragrance", "scent", "odour", "odor"),
        Topic("Comfort", "comfort", "comfortable", "soft", "smooth"),
        Topic("Colour and look", "colour", "color", "look", "looks", "design", "shade"),
        Topic("Packaging", "packaging", "packed", "package", "leak", "leaked", "seal", "damaged"),
        Topic("Delivery", "delivery", "delivered", "late", "on time", "courier"),
    ];

    private static JsonObject Topic(string name, params string[] words) =>
        new() { ["name"] = name, ["words"] = new JsonArray(words.Select(w => (JsonNode)w).ToArray()) };

    public const string DefaultGuidelines =
        "Tell other shoppers about the product: how you used it, what you liked and what could be better. " +
        "Share only your own honest experience; reviews written in return for money, free products or discounts are not allowed. " +
        "Photos and videos must be your own and show the product. " +
        "Do not include phone numbers, email addresses, links, other people's details or offensive language.";

    public static readonly IReadOnlyDictionary<string, string> ReportReasons = new Dictionary<string, string>
    {
        ["spam"] = "Spam or advertising", ["fake"] = "Fake or paid review", ["offensive"] = "Offensive or abusive",
        ["not_product"] = "Not about this product", ["personal"] = "Shares personal information",
        ["wrong_media"] = "Photos or videos are not of this product", ["other"] = "Something else",
    };

    public static JsonObject Defaults() => new()
    {
        ["buyers_only"] = true,
        ["media_need_approval"] = false,
        ["photos"] = true,
        ["max_photos"] = 5,
        ["videos"] = true,
        ["max_video_mb"] = 30,
        ["media_public"] = true,
        ["report_hide_at"] = 3,
        ["seller_can_report"] = true,
        ["min_body_chars"] = 0,
        ["topics_enabled"] = true,
        ["topics"] = DefaultTopics(),
        ["guidelines"] = DefaultGuidelines,
    };

    private static readonly Dictionary<string, (int Lo, int Hi)> Ints = new()
    {
        ["max_photos"] = (0, 10), ["max_video_mb"] = (5, 100), ["report_hide_at"] = (0, 50), ["min_body_chars"] = (0, 500),
    };

    [GeneratedRegex(@"^[\w' -]{2,30}$")]
    private static partial Regex WordRx();

    public async Task<JsonObject> GetAsync() => SettingsDAL.Merge(Defaults(), await settings.GetAsync(Key));

    private static JsonArray CleanTopics(JsonNode? v)
    {
        if (v is not JsonArray arr || arr.Count > 20) throw new ArgumentException("Add at most 20 topics");
        var outp = new JsonArray();
        foreach (var t in arr)
        {
            if (t is not JsonObject o) throw new ArgumentException("Each topic needs a name and words");
            var name = SettingsJson.Text(o["name"]).Trim();
            if (name.Length < 2 || name.Length > 30) throw new ArgumentException("Topic names are 2 to 30 characters");
            var words = (o["words"] as JsonArray ?? [])
                .Select(w => SettingsJson.Text(w).Trim().ToLowerInvariant()).Where(w => w.Length > 0).ToList();
            if (words.Count == 0 || words.Count > 20) throw new ArgumentException($"Give '{name}' between 1 and 20 words");
            var bad = words.FirstOrDefault(w => !WordRx().IsMatch(w));
            if (bad != null) throw new ArgumentException($"Use letters, numbers and spaces only in topic words ('{bad}')");
            outp.Add(new JsonObject { ["name"] = name, ["words"] = new JsonArray(words.Distinct().Select(w => (JsonNode)w).ToArray()) });
        }
        return outp;
    }

    public static JsonObject ValidateUpdates(JsonObject data)
    {
        var clean = new JsonObject();
        var defaults = Defaults();
        try
        {
            foreach (var (k, v) in data)
            {
                if (!defaults.ContainsKey(k)) throw new ArgumentException($"Unknown setting: {k}");
                if (Ints.TryGetValue(k, out var r))
                {
                    if (!SettingsJson.IsWholeNumber(v, out var n) || n < r.Lo || n > r.Hi)
                        throw new ArgumentException($"{k} must be a whole number between {r.Lo} and {r.Hi}");
                    clean[k] = n;
                }
                else if (k == "topics") clean[k] = CleanTopics(v);
                else if (k == "guidelines")
                {
                    if (v?.GetValueKind() != JsonValueKind.String || v.GetValue<string>().Length > 2000)
                        throw new ArgumentException("Keep the guidelines under 2,000 characters");
                    clean[k] = v.GetValue<string>().Trim();
                }
                else
                {
                    if (v?.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)) throw new ArgumentException($"{k} must be on or off");
                    clean[k] = v.GetValueKind() == JsonValueKind.True;
                }
            }
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_setting");
        }
        return clean;
    }

    public async Task<JsonObject> UpdateAsync(JsonObject data)
    {
        await support.MergeSettingsAsync(Key, ValidateUpdates(data));
        return await GetAsync();
    }

    public JsonObject Public(JsonObject cfg) => new()
    {
        ["buyers_only"] = cfg.Bool("buyers_only"),
        ["photos"] = cfg.Bool("photos") && cfg.Int("max_photos") > 0,
        ["max_photos"] = cfg.Int("max_photos"),
        ["videos"] = cfg.Bool("videos"),
        ["max_video_mb"] = cfg.Int("max_video_mb"),
        ["media_public"] = cfg.Bool("media_public"),
        ["min_body_chars"] = cfg.Int("min_body_chars"),
        ["guidelines"] = cfg.Str("guidelines"),
        ["report_reasons"] = new JsonObject(ReportReasons.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value))),
    };

    /// <summary>Matches any of the words as whole words, ignoring case (the topic filter and the topic counts).</summary>
    public static Regex TopicRegex(IEnumerable<string> words) =>
        new(@"\b(" + string.Join("|", words.Select(Regex.Escape)) + @")\b", RegexOptions.IgnoreCase);
}
