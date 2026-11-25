namespace BAL;

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

/// <summary>
/// The assistant's decision layer (reference: app/assistant/decision.py): keyword and pattern matching in
/// English, Tamil, Hindi and Tanglish decides intent, areas, period and the obvious first lookup. With the "laya"
/// provider the question goes to the admin's Laya System 1 server (public https only, a short timeout); when it is
/// slow, down or answers something unusable, the rules answer instead, as in the reference.
/// </summary>
public static class AssistantDecision
{
    public static readonly string[] Intents = ["data_question", "change_request", "export_request", "file_analysis", "how_to", "small_talk"];
    public static readonly string[] Domains = ["sales", "orders", "customers", "catalog", "sellers", "returns", "support", "payouts", "marketing", "reports", "settings", "overview"];

    private static readonly Dictionary<string, string[]> Lexicon = new()
    {
        ["sales"] = ["sale", "sales", "sell", "sold", "selling", "how much did we", "revenue", "gmv", "turnover", "earning", "income", "business", "aov", "average order", "commission", "profit",
            "விற்பனை", "வருமானம்", "வியாபாரம்", "sales evlo", "evlo sales", "vitpanai", "vyaparam", "बिक्री", "सेल", "कमाई", "बिजनेस", "kitna becha", "bikri"],
        ["orders"] = ["order", "orders", "package", "packages", "shipment", "awb", "courier", "deliver", "shipped", "dispatch", "cancel", "pending order",
            "ஆர்டர்", "டெலிவரி", "அனுப்பு", "ஆர்டர்கள்", "ऑर्डर", "डिलीवरी", "भेजा"],
        ["customers"] = ["customer", "customers", "buyer", "shopper", "user", "phone number", "mobile", "email",
            "வாடிக்கையாளர்", "கஸ்டமர்", "ग्राहक", "कस्टमर"],
        ["catalog"] = ["product", "products", "listing", "listings", "sku", "stock", "inventory", "out of stock", "low stock", "price", "mrp", "category", "review", "rating",
            "பொருள்", "ஸ்டாக்", "இருப்பு", "விலை", "प्रोडक्ट", "स्टॉक", "माल", "दाम"],
        ["sellers"] = ["seller", "sellers", "vendor", "store", "shop", "merchant", "gstin", "kyc", "விற்பனையாளர்", "கடை", "सेलर", "विक्रेता", "दुकान"],
        ["returns"] = ["return", "returns", "refund", "refunds", "rto", "credit note", "ரிட்டர்ன்", "திருப்பி", "பணம் திரும்ப", "रिटर्न", "रिफंड", "वापसी"],
        ["support"] = ["ticket", "tickets", "complaint", "grievance", "support", "query", "helpdesk", "புகார்", "டிக்கெட்", "शिकायत", "टिकट"],
        ["payouts"] = ["payout", "payouts", "settlement", "utr", "bank transfer", "pay seller", "seller payment", "செட்டில்மென்ட்", "पेआउट", "भुगतान"],
        ["marketing"] = ["coupon", "coupons", "discount code", "offer", "promo", "announcement", "banner", "கூப்பன்", "ஆஃபர்", "कूपन", "ऑफर"],
        ["reports"] = ["tcs", "gst", "gstr", "tds", "tax report", "invoice", "வரி", "जीएसटी", "टैक्स"],
        ["settings"] = ["setting", "settings", "fee", "cod limit", "integration", "razorpay", "msg91", "api key", "go live", "go-live", "launch", "அமைப்பு", "सेटिंग"],
        ["overview"] = ["attention", "pending", "todo", "to do", "what's waiting", "whats waiting", "summary", "status", "how are we doing", "dashboard",
            "கவனிக்க", "நிலவரம்", "என்ன பண்ணணும்", "क्या बाकी", "स्थिति"],
    };

    private static readonly string[] ChangeWords = ["approve", "reject", "cancel", "block", "unblock", "suspend", "create", "make a coupon", "switch on", "switch off", "turn on", "turn off",
        "change", "update", "set ", "reply", "refund it", "mark ", "run payout", "hide", "publish", "delete",
        "அனுமதி", "ரத்து", "மாற்று", "உருவாக்கு", "நிறுத்து", "मंजूर", "रद्द", "बदल", "बनाओ", "बंद करो"];

    private static readonly string[] ExportWords = ["export", "download", "excel", "xlsx", "csv", "pdf", "spreadsheet", "sheet", "report file", "டவுன்லோட்", "எக்செல்", "डाउनलोड", "एक्सेल"];

    private static readonly string[] HowtoWords = ["how do i", "how to", "how can i", "where do i", "where is", "what is", "explain", "help me", "எப்படி", "எங்க", "என்றால் என்ன", "कैसे", "कहाँ", "क्या है"];

    private static readonly string[] Smalltalk = ["hi", "hello", "hey", "thanks", "thank you", "good morning", "vanakkam", "வணக்கம்", "நன்றி", "नमस्ते", "धन्यवाद", "ok", "okay"];

    private static readonly (string Preset, string[] Words)[] PeriodWords =
    [
        ("yesterday", ["yesterday", "நேற்று", "nethu", "netru", "कल का", "बीता कल", "kal ka"]),
        ("today", ["today", "todays", "today's", "so far today", "இன்று", "இன்னைக்கு", "இன்னிக்கு", "inniku", "innaiku", "indru", "आज", "aaj"]),
        ("last_week", ["last week", "previous week", "போன வாரம்", "கடந்த வாரம்", "pona vaaram", "पिछले हफ्ते", "पिछले सप्ताह", "pichle hafte"]),
        ("this_week", ["this week", "இந்த வாரம்", "intha vaaram", "इस हफ्ते", "is hafte"]),
        ("last_month", ["last month", "previous month", "போன மாசம்", "கடந்த மாதம்", "pona maasam", "पिछले महीने", "pichle mahine"]),
        ("this_month", ["this month", "month to date", "mtd", "இந்த மாசம்", "இந்த மாதம்", "intha maasam", "इस महीने", "is mahine"]),
        ("this_year", ["this year", "ytd", "இந்த வருடம்", "இந்த வருஷம்", "इस साल"]),
        ("this_financial_year", ["this fy", "financial year", "this financial year", "நிதியாண்டு", "वित्त वर्ष"]),
        ("last_7_days", ["last 7 days", "past 7 days", "last seven days", "past week"]),
        ("last_30_days", ["last 30 days", "past 30 days", "last thirty days", "past month"]),
        ("last_90_days", ["last 90 days", "past 90 days", "last 3 months", "last three months", "this quarter"]),
    ];

    public static readonly Dictionary<string, string[]> DomainTools = new()
    {
        ["sales"] = ["business_overview", "sales_breakdown"],
        ["overview"] = ["work_queue", "business_overview"],
        ["orders"] = ["find_orders", "order_details", "business_overview"],
        ["customers"] = ["find_customers", "customer_profile"],
        ["catalog"] = ["find_products", "stock_alerts"],
        ["sellers"] = ["find_sellers", "seller_profile", "stock_alerts"],
        ["returns"] = ["returns_report", "refunds_report"],
        ["support"] = ["support_tickets"],
        ["payouts"] = ["payouts_report"],
        ["marketing"] = ["coupons"],
        ["reports"] = ["gst_tcs_report"],
        ["settings"] = ["marketplace_settings"],
    };

    private static readonly string[] Always = ["open_page", "remember", "prepare_export"];

    private static readonly Regex OrderNo = new(@"\b(PC[0-9A-Z]{6,}(?:-\d+)?)\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Phone = new(@"(?<!\d)(?:\+?91[\s-]?)?([6-9]\d{9})(?!\d)", RegexOptions.Compiled);
    private static readonly Regex Email = new(@"[\w.+-]+@[\w-]+\.[\w.]+", RegexOptions.Compiled);
    private static readonly Regex IsoDate = new(@"\b(20\d{2}-\d{2}-\d{2})\b", RegexOptions.Compiled);

    public sealed record Decision(
        string Intent, List<string> DomainList, string? Period, double Confidence, string Source, double Ms,
        List<string>? Tools, List<(string Name, JsonObject Args)> Prefetch, bool VoiceFast, Dictionary<string, string> Entities)
    {
        /// <summary>Reference: Decision.as_dict (prefetch reduced to names).</summary>
        public JsonObject AsDict() => new()
        {
            ["intent"] = Intent,
            ["areas"] = new JsonArray(DomainList.Select(d => (JsonNode)JsonValue.Create(d)!).ToArray()),
            ["period"] = Period,
            ["confidence"] = Math.Round(Confidence, 2),
            ["source"] = Source,
            ["ms"] = Math.Round(Ms, 1),
            ["tools"] = Tools is null ? null : new JsonArray(Tools.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()),
            ["prefetch"] = new JsonArray(Prefetch.Select(p => (JsonNode)JsonValue.Create(p.Name)!).ToArray()),
        };
    }

    private static bool IsAscii(string s) => s.All(c => c < 128);

    private static int Has(string text, IEnumerable<string> words)
    {
        var hits = 0;
        foreach (var w in words)
        {
            if (IsAscii(w)
                ? Regex.IsMatch(text, $@"(?<![\w]){Regex.Escape(w)}(?![\w])")
                : text.Contains(w))
                hits++;
        }
        return hits;
    }

    public static string? DetectPeriod(string text)
    {
        var t = text.ToLowerInvariant();
        foreach (var (preset, words) in PeriodWords)
            if (Has(t, words) > 0)
                return preset;
        return null;
    }

    /// <summary>Reference: decision.rules.</summary>
    public static Decision Rules(string text, bool hasUpload = false)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        var t = string.Join(' ', text.ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        var scores = Domains.ToDictionary(d => d, d => Has(t, Lexicon[d]));
        var entities = new Dictionary<string, string>();
        var m = OrderNo.Match(text);
        if (m.Success) { entities["order"] = m.Groups[1].Value.ToUpperInvariant(); scores["orders"] += 2; }
        m = Phone.Match(text);
        if (m.Success) { entities["phone"] = m.Groups[1].Value; scores["customers"] += 2; }
        m = Email.Match(text);
        if (m.Success) { entities["email"] = m.Groups[0].Value; scores["customers"] += 2; }
        m = IsoDate.Match(text);
        if (m.Success) entities["date"] = m.Groups[1].Value;
        if (Has(t, ["stock", "out of stock", "low stock", "inventory", "ஸ்டாக்", "இருப்பு", "स्टॉक", "माल"]) > 0)
            entities["stock"] = "1";
        var period = DetectPeriod(t);
        var domains = scores.Where(kv => kv.Value > 0).OrderByDescending(kv => kv.Value).Select(kv => kv.Key).ToList();
        string intent;
        if (hasUpload) intent = "file_analysis";
        else if (Has(t, ChangeWords) > 0) intent = "change_request";
        else if (Has(t, ExportWords) > 0) intent = "export_request";
        else if (Has(t, HowtoWords) > 0 && period is null) intent = "how_to";
        else if (domains.Count == 0 && (Smalltalk.Contains(t.Trim(' ', '!', '.', '?')) || t.Length <= 3)) intent = "small_talk";
        else intent = "data_question";
        var top = domains.Count > 0 ? scores[domains[0]] : 0;
        var confidence = intent == "small_talk" ? 0.95 : Math.Min(0.95, 0.45 + 0.2 * top + (period is not null ? 0.1 : 0) + (entities.Count > 0 ? 0.1 : 0));
        if (intent == "file_analysis") confidence = Math.Max(confidence, 0.8);
        if (intent == "how_to" && domains.Count == 0) confidence = 0.7;
        var ms = System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        return new Decision(intent, domains.Take(3).ToList(), period, confidence, "rules", ms, null, [], false, entities);
    }

    /// <summary>Reference: decision.plan — chooses tools and the prefetch; low confidence offers every tool.</summary>
    public static Decision Plan(Decision d, double minConfidence, bool prefetch, IReadOnlySet<string> available)
    {
        List<string>? tools;
        if (d.Confidence < minConfidence || (d.Intent == "change_request" && d.DomainList.Count == 0))
        {
            tools = null;
        }
        else
        {
            var names = new List<string>(Always);
            foreach (var dom in d.DomainList.Count > 0 ? d.DomainList : ["overview"])
                names.AddRange(DomainTools.GetValueOrDefault(dom, []));
            if (d.Intent == "file_analysis")
            {
                names.AddRange(["file_overview", "file_query", "file_compare"]);
                names.AddRange(DomainTools["orders"]);
                names.AddRange(DomainTools["catalog"]);
            }
            if (d.Intent == "change_request") names.Add("propose_action");
            if (d.Intent == "how_to") names.Add("marketplace_settings");
            tools = names.Distinct().Where(available.Contains).ToList();
        }
        var prefetchList = new List<(string, JsonObject)>(d.Prefetch);
        if (prefetch && d.Intent == "data_question" && d.Confidence >= minConfidence && d.DomainList.Count > 0)
        {
            var top = d.DomainList[0];
            JsonObject Args(string period) => new() { ["period"] = period };
            if (top == "sales" && available.Contains("business_overview"))
                prefetchList.Add(("business_overview", Args(d.Period ?? "today")));
            else if (top == "overview" && available.Contains("work_queue"))
                prefetchList.Add(("work_queue", new JsonObject()));
            else if (top == "orders" && d.Entities.TryGetValue("order", out var ord) && available.Contains("order_details"))
                prefetchList.Add(("order_details", new JsonObject { ["reference"] = ord }));
            else if (top == "orders" && d.Period is not null && available.Contains("business_overview"))
                prefetchList.Add(("business_overview", Args(d.Period))); // "how many orders today"
            else if (top == "customers" && (d.Entities.ContainsKey("phone") || d.Entities.ContainsKey("email")) && available.Contains("customer_profile"))
                prefetchList.Add(("customer_profile", new JsonObject { ["reference"] = d.Entities.GetValueOrDefault("phone") ?? d.Entities.GetValueOrDefault("email") }));
            else if (top == "catalog" && d.Entities.ContainsKey("stock") && available.Contains("stock_alerts"))
                prefetchList.Add(("stock_alerts", new JsonObject()));
            else if (top == "payouts" && available.Contains("payouts_report"))
                prefetchList.Add(("payouts_report", new JsonObject()));
            else if (top == "support" && available.Contains("support_tickets"))
                prefetchList.Add(("support_tickets", new JsonObject { ["status"] = "open" }));
            else if (top == "returns" && available.Contains("returns_report"))
                prefetchList.Add(("returns_report", Args(d.Period ?? "last_30_days")));
        }
        var voiceFast = d.Intent is "data_question" or "small_talk" && d.Confidence >= 0.75;
        return d with { Tools = tools, Prefetch = prefetchList, VoiceFast = voiceFast };
    }

    // ----------------------------------------------------------------------------- Laya

    /// <summary>Reference: decision.LAYA_QUESTIONS.</summary>
    private static JsonObject LayaQuestions() => new()
    {
        ["intent"] = new JsonObject
        {
            ["type"] = "choice", ["instructions"] = "What does the marketplace admin want?",
            ["criteria"] = new JsonObject
            {
                ["data_question"] = "a number, list, status or comparison from the shop's data",
                ["change_request"] = "change something: approve, reject, cancel, block, create, update, reply",
                ["export_request"] = "download a report or spreadsheet", ["file_analysis"] = "analyse an uploaded file",
                ["how_to"] = "how to do something in the admin panel", ["small_talk"] = "greeting or thanks",
            },
        },
        ["area"] = new JsonObject
        {
            ["type"] = "choice", ["instructions"] = "Which part of the marketplace is it about?",
            ["criteria"] = new JsonObject
            {
                ["sales"] = "sales, revenue, money earned", ["orders"] = "orders, deliveries, cancellations", ["customers"] = "customers and buyers",
                ["catalog"] = "products, stock, prices, reviews", ["sellers"] = "sellers and stores", ["returns"] = "returns and refunds",
                ["support"] = "support tickets and complaints", ["payouts"] = "payments to sellers", ["marketing"] = "coupons, offers, announcements",
                ["reports"] = "GST, TCS and tax reports", ["settings"] = "settings, integrations, launch", ["overview"] = "what needs attention overall",
            },
        },
    };

    private static string Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

    /// <summary>
    /// Reference: decision.laya — asks the Laya server (POST {laya_url}{laya_path} with {"state", "questions"}, the
    /// bearer token when one is set, the configured timeout). Null when the address is not a public https one, or
    /// the server is slow, down or answers something unusable: the rules answer then.
    /// <paramref name="cfg"/> carries the decrypted token (settings.get(reveal=True)).
    /// </summary>
    public static async Task<Decision?> LayaAsync(string text, JsonObject cfg, CancellationToken ct = default)
    {
        if (!AssistantBAL.LayaAllowed(Str(cfg["laya_url"])))
            return null; // not a public https address (saved before that rule): staff questions never go there
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        var url = Str(cfg["laya_url"]).TrimEnd('/') + (Str(cfg["laya_path"]) is { Length: > 0 } path ? path : "/predict");
        string intentChoice, areaChoice;
        double conf;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(BAL.AI.J.Double(cfg["laya_timeout_ms"]) ?? 600));
            using var req = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(
                    new JsonObject { ["state"] = text.Length > 4000 ? text[..4000] : text, ["questions"] = LayaQuestions() }.ToJsonString(BAL.AI.J.Relaxed),
                    System.Text.Encoding.UTF8, "application/json"),
            };
            if (Str(cfg["laya_key"]) is { Length: > 0 } key)
                req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {key}");
            using var http = BAL.AI.LlmTransport.LayaClient();
            using var r = await http.SendAsync(req, timeout.Token);
            r.EnsureSuccessStatusCode();
            var body = JsonNode.Parse(await r.Content.ReadAsStringAsync(timeout.Token)) as JsonObject;
            var answers = body?["answers"] as JsonObject ?? [];
            var intent = answers["intent"] as JsonObject ?? [];
            var area = answers["area"] as JsonObject ?? [];
            intentChoice = Str(intent["choice"]);
            areaChoice = Str(area["choice"]);
            if (!Intents.Contains(intentChoice) || !Domains.Contains(areaChoice))
                return null;
            conf = Math.Min(BAL.AI.J.Double(intent["confidence"]) ?? 0, BAL.AI.J.Double(area["confidence"]) ?? 0);
        }
        catch (Exception exc) when (exc is HttpRequestException or OperationCanceledException or System.Text.Json.JsonException
                                        or InvalidOperationException or FormatException && !ct.IsCancellationRequested)
        {
            return null; // reference: log.info("laya decision unavailable (...); using rules")
        }
        var b = Rules(text);
        var domains = new List<string> { areaChoice };
        domains.AddRange(b.DomainList.Where(x => x != areaChoice));
        return new Decision(intentChoice, domains.Take(3).ToList(), b.Period, conf, "laya",
            System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds, null, [], false, b.Entities);
    }

    /// <summary>
    /// Reference: decision.decide — "off" offers every tool and prefetches nothing; "laya" asks the Laya server (not for
    /// questions with files) and falls back to the rules; "rules" is the built-in reading. Then <see cref="Plan"/>.
    /// </summary>
    public static async Task<Decision> DecideAsync(string text, JsonObject cfg, IReadOnlySet<string> available, bool hasUpload, CancellationToken ct = default)
    {
        var provider = cfg["provider"] is null ? "rules" : Str(cfg["provider"]);
        if (provider == "off")
            return new Decision("data_question", [], DetectPeriod(text.ToLowerInvariant()), 0.0, "off", 0.0, null, [], false, new());
        Decision? d = null;
        if (provider == "laya" && Str(cfg["laya_url"]).Length > 0 && !hasUpload)
            d = await LayaAsync(text, cfg, ct);
        d ??= Rules(text, hasUpload);
        return Plan(d, BAL.AI.J.Double(cfg["min_confidence"]) ?? 0.55, cfg["prefetch"] is null || BAL.AI.J.Truthy(cfg["prefetch"]), available);
    }
}
