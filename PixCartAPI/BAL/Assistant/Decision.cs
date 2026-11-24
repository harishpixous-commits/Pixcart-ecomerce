using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.AI;
using Microsoft.Extensions.Logging;

namespace BAL.Assistant;

/// <summary>The decision layer's reading of one message.</summary>
public sealed class Decision
{
    public string Intent { get; set; } = "data_question";
    public List<string> Domains { get; set; } = [];
    public string? Period { get; set; }
    public double Confidence { get; set; }
    public string Source { get; set; } = "rules";
    public double Ms { get; set; }
    /// <summary>null = offer every permitted tool.</summary>
    public List<string>? Tools { get; set; }
    public List<(string Name, JsonObject Args)> Prefetch { get; } = [];
    /// <summary>A short factual question: the fast route is enough.</summary>
    public bool VoiceFast { get; set; }
    public Dictionary<string, string> Entities { get; set; } = [];

    public JsonObject AsDict() => J.O(("intent", Intent), ("areas", J.Strings(Domains)), ("period", Period), ("confidence", Math.Round(Confidence, 2)),
        ("source", Source), ("ms", Math.Round(Ms, 1)), ("tools", Tools is null ? null : J.Strings(Tools)), ("prefetch", J.Strings(Prefetch.Select(p => p.Name))));
}

/// <summary>
/// Decision layer: a fast first look at each message, before the language model is called. It decides which areas the
/// message is about (only those tools are offered), which period it means (resolved on the server) and what to fetch
/// straight away for common questions (saves a model round trip). Providers: "rules" (built in: English, Tamil, Hindi
/// and Tanglish), "laya" (the Laya System 1 decision server; the rules answer when it is slow or down) and "off".
/// Below the confidence threshold every permitted tool is offered: the layer can only speed things up.
/// </summary>
public static class DecisionLayer
{
    private static JsonObject D => RefData.Obj("decision");
    private static string[] Words(JsonNode? n) => (n as JsonArray ?? []).Select(J.S).ToArray();

    private static readonly Lazy<string[]> Domains = new(() => Words(D["domains"]));
    private static readonly Lazy<string[]> Intents = new(() => Words(D["intents"]));
    private static readonly Lazy<Dictionary<string, string[]>> Lexicon = new(() => ((JsonObject)D["lexicon"]!).ToDictionary(kv => kv.Key, kv => Words(kv.Value)));
    private static readonly Lazy<List<(string Preset, string[] Words)>> PeriodWords = new(() =>
        ((JsonArray)D["periods"]!).OfType<JsonArray>().Select(a => (J.S(a[0]), Words(a[1]))).ToList());
    private static readonly Lazy<Dictionary<string, string[]>> DomainTools = new(() => ((JsonObject)D["domain_tools"]!).ToDictionary(kv => kv.Key, kv => Words(kv.Value)));

    private static readonly Regex OrderNo = new(@"\b(PC[0-9A-Z]{6,}(?:-\d+)?)\b", RegexOptions.IgnoreCase);
    private static readonly Regex Phone = new(@"(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)");
    private static readonly Regex Email = new(@"[\w.+-]+@[\w-]+\.[\w.]+");
    private static readonly Regex IsoDate = new(@"\b(20\d{2}-\d{2}-\d{2})\b");

    private static bool IsAscii(string s) => s.All(c => c < 128);

    private static int Has(string text, IEnumerable<string> words)
    {
        var hits = 0;
        foreach (var w in words)
            if (IsAscii(w) ? Regex.IsMatch(text, $@"(?<![\w]){Regex.Escape(w)}(?![\w])") : text.Contains(w, StringComparison.Ordinal)) hits++;
        return hits;
    }

    public static string? DetectPeriod(string text)
    {
        var t = text.ToLowerInvariant();
        foreach (var (preset, words) in PeriodWords.Value)
            if (Has(t, words) > 0) return preset;
        return null;
    }

    public static Decision Rules(string text, bool hasUpload = false)
    {
        var sw = Stopwatch.StartNew();
        var t = string.Join(' ', text.ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        var scores = Domains.Value.ToDictionary(d => d, d => Has(t, Lexicon.Value[d]));
        var entities = new Dictionary<string, string>();
        if (OrderNo.Match(text) is { Success: true } om) { entities["order"] = om.Groups[1].Value.ToUpperInvariant(); scores["orders"] += 2; }
        if (Phone.Match(text) is { Success: true } pm) { entities["phone"] = pm.Groups[1].Value; scores["customers"] += 2; }
        if (Email.Match(text) is { Success: true } em) { entities["email"] = em.Value; scores["customers"] += 2; }
        if (IsoDate.Match(text) is { Success: true } dm) entities["date"] = dm.Groups[1].Value;
        if (Has(t, ["stock", "out of stock", "low stock", "inventory", "ஸ்டாக்", "இருப்பு", "स्टॉक", "माल"]) > 0) entities["stock"] = "1";
        var period = DetectPeriod(t);
        // stable sort by score (highest first), keeping the lexicon order for ties
        var domains = Domains.Value.Select((d, i) => (d, i)).OrderByDescending(x => scores[x.d]).ThenBy(x => x.i).Where(x => scores[x.d] > 0).Select(x => x.d).ToList();
        string intent;
        if (hasUpload) intent = "file_analysis";
        else if (Has(t, Words(D["change"])) > 0) intent = "change_request";
        else if (Has(t, Words(D["export"])) > 0) intent = "export_request";
        else if (Has(t, Words(D["howto"])) > 0 && period is null) intent = "how_to";
        else if (domains.Count == 0 && (Words(D["smalltalk"]).Contains(t.Trim(' ', '!', '.', '?')) || t.Length <= 3)) intent = "small_talk";
        else intent = "data_question";
        var top = domains.Count > 0 ? scores[domains[0]] : 0;
        var confidence = intent == "small_talk" ? 0.95 : Math.Min(0.95, 0.45 + 0.2 * top + (period != null ? 0.1 : 0) + (entities.Count > 0 ? 0.1 : 0));
        if (intent == "file_analysis") confidence = Math.Max(confidence, 0.8);
        if (intent == "how_to" && domains.Count == 0) confidence = 0.7;
        return new Decision
        {
            Intent = intent, Domains = domains.Take(3).ToList(), Period = period, Confidence = confidence, Source = "rules", Entities = entities,
            Ms = sw.Elapsed.TotalMilliseconds,
        };
    }

    /// <summary>Chooses tools and the prefetch from a decision. Low confidence → every tool.</summary>
    public static Decision Plan(Decision d, double minConfidence, bool prefetch, ISet<string> available)
    {
        if (d.Confidence < minConfidence || (d.Intent == "change_request" && d.Domains.Count == 0))
        {
            d.Tools = null;
        }
        else
        {
            var names = new List<string>(Words(D["always"]));
            foreach (var dom in d.Domains.Count > 0 ? d.Domains : ["overview"]) names.AddRange(DomainTools.Value.GetValueOrDefault(dom) ?? []);
            if (d.Intent == "file_analysis")
            {
                names.AddRange(["file_overview", "file_query", "file_compare"]);
                foreach (var dom in new[] { "orders", "catalog" }) names.AddRange(DomainTools.Value[dom]);
            }
            if (d.Intent == "change_request") names.Add("propose_action");
            if (d.Intent == "how_to") names.Add("marketplace_settings");
            d.Tools = names.Distinct().Where(available.Contains).ToList();
        }
        if (prefetch && d.Intent == "data_question" && d.Confidence >= minConfidence && d.Domains.Count > 0)
        {
            var top = d.Domains[0];
            JsonObject Args() => d.Period != null ? J.O(("period", d.Period)) : [];
            if (top == "sales" && available.Contains("business_overview")) d.Prefetch.Add(("business_overview", J.O(("period", d.Period ?? "today"))));
            else if (top == "overview" && available.Contains("work_queue")) d.Prefetch.Add(("work_queue", []));
            else if (top == "orders" && d.Entities.TryGetValue("order", out var on) && available.Contains("order_details")) d.Prefetch.Add(("order_details", J.O(("reference", on))));
            else if (top == "orders" && d.Period != null && available.Contains("business_overview")) d.Prefetch.Add(("business_overview", J.O(("period", d.Period))));
            else if (top == "customers" && (d.Entities.ContainsKey("phone") || d.Entities.ContainsKey("email")) && available.Contains("customer_profile"))
                d.Prefetch.Add(("customer_profile", J.O(("reference", d.Entities.GetValueOrDefault("phone") ?? d.Entities["email"]))));
            else if (top == "catalog" && d.Entities.ContainsKey("stock") && available.Contains("stock_alerts")) d.Prefetch.Add(("stock_alerts", []));
            else if (top == "payouts" && available.Contains("payouts_report")) d.Prefetch.Add(("payouts_report", []));
            else if (top == "support" && available.Contains("support_tickets")) d.Prefetch.Add(("support_tickets", J.O(("status", "open"))));
            else if (top == "returns" && available.Contains("returns_report")) d.Prefetch.Add(("returns_report", Args().Count > 0 ? Args() : J.O(("period", "last_30_days"))));
        }
        d.VoiceFast = d.Intent is "data_question" or "small_talk" && d.Confidence >= 0.75;
        return d;
    }

    // ---------------------------------------------------------------- Laya

    public static async Task<Decision?> LayaAsync(string text, JsonObject cfg, ILogger? log)
    {
        if (!AssistantSettings.LayaAllowed(J.S(cfg["laya_url"]))) return null; // never to an address that is not public https
        var sw = Stopwatch.StartNew();
        var path = J.S(cfg["laya_path"]);
        var url = J.S(cfg["laya_url"]).TrimEnd('/') + (path.Length > 0 ? path : "/predict");
        try
        {
            using var client = LlmTransport.LayaClient();
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(J.Double(cfg["laya_timeout_ms"]) ?? 600));
            using var req = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(J.O(("state", J.Cut(text, 4000)), ("questions", D["laya_questions"]!.DeepClone())).ToJsonString(), Encoding.UTF8, "application/json"),
            };
            if (J.S(cfg["laya_key"]) is { Length: > 0 } key) req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {key}");
            using var r = await client.SendAsync(req, cts.Token);
            r.EnsureSuccessStatusCode();
            var answers = J.Obj(await r.Content.ReadAsStringAsync(cts.Token))["answers"] as JsonObject ?? [];
            var intent = answers["intent"] as JsonObject ?? [];
            var area = answers["area"] as JsonObject ?? [];
            if (!Intents.Value.Contains(J.S(intent["choice"])) || !Domains.Value.Contains(J.S(area["choice"]))) return null;
            var conf = Math.Min(J.Double(intent["confidence"]) ?? 0, J.Double(area["confidence"]) ?? 0);
            var b = Rules(text);
            var choice = J.S(area["choice"]);
            return new Decision
            {
                Intent = J.S(intent["choice"]), Domains = new[] { choice }.Concat(b.Domains.Where(x => x != choice)).Take(3).ToList(), Period = b.Period,
                Confidence = conf, Source = "laya", Ms = sw.Elapsed.TotalMilliseconds, Entities = b.Entities,
            };
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or FormatException or InvalidOperationException)
        {
            log?.LogInformation("laya decision unavailable ({Kind}); using rules", e.GetType().Name);
            return null;
        }
    }

    public static async Task<Decision> DecideAsync(string text, JsonObject cfg, ISet<string> available, bool hasUpload, ILogger? log = null)
    {
        var provider = J.S(cfg["provider"]) is { Length: > 0 } pv ? pv : "rules";
        if (provider == "off") return new Decision { Intent = "data_question", Period = DetectPeriod(text.ToLowerInvariant()), Confidence = 0, Source = "off" };
        Decision? d = null;
        if (provider == "laya" && J.S(cfg["laya_url"]).Length > 0 && !hasUpload) d = await LayaAsync(text, cfg, log);
        d ??= Rules(text, hasUpload);
        return Plan(d, J.Double(cfg["min_confidence"]) ?? 0.55, cfg["prefetch"] is null || J.Truthy(cfg["prefetch"]), available);
    }
}
