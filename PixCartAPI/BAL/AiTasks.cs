using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Utils;

namespace BAL;

/// <summary>
/// The AI task registry (reference: app/ai/tasks.py). Every AI feature is declared once: frozen rules (the cached
/// system block; never editable from the admin panel), a builder for the per-request message, a parser that
/// validates the answer, and a sandbox that produces an obviously-marked answer when no API key is set.
/// </summary>
public static class AiTasks
{
    public static readonly string[] Tones = ["friendly", "formal", "apologetic"];
    public const string Sandbox = "[Sandbox draft — connect an Anthropic API key for real AI text]";

    public sealed record AiTask(
        string Key, string Label, string Description, string Audience, string Permission, string Output,
        string Rules, int MaxTokens, string Subject,
        Func<JsonObject, JsonObject, string> Build,
        Func<string, JsonObject> Parse,
        Func<JsonObject, JsonObject, string> MakeSandbox);

    private static readonly Regex Banned = new(
        @"\b(gun|pistol|ammunition|cannabis|ganja|tobacco|cigarette|vape|ivory|prescription|steroid|replica|first copy|7a quality)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Contact = new(
        @"(\+?91[\s-]?)?[6-9]\d{9}|[\w.]+@[\w-]+\.[a-z]{2,}|https?://|www\.",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static JsonObject ReadJson(string text)
    {
        var m = Regex.Match(text ?? "", @"\{.*\}", RegexOptions.Singleline);
        if (!m.Success) throw new AppException("The AI answer could not be read. Try again.", "ai_bad_output", 502);
        JsonNode? node;
        try { node = JsonNode.Parse(m.Value); }
        catch (System.Text.Json.JsonException) { throw new AppException("The AI answer could not be read. Try again.", "ai_bad_output", 502); }
        if (node is not JsonObject o) throw new AppException("The AI answer could not be read. Try again.", "ai_bad_output", 502);
        return o;
    }

    private static string Clean(string? text, int limit)
    {
        text = Regex.Replace(text ?? "", @"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "").Trim();
        text = Regex.Replace(text, @"^(here('s| is)[^\n:]{0,60}:\s*)", "", RegexOptions.IgnoreCase);
        return text.Length > limit ? text[..limit].Trim() : text.Trim();
    }

    private static Func<string, JsonObject> TextParser(int limit) => text =>
    {
        var body = Clean(text, limit);
        if (body.Length == 0) throw new AppException("The AI returned an empty answer. Try again.", "ai_empty", 502);
        return new JsonObject { ["text"] = body };
    };

    private static string Str(JsonObject o, string key) =>
        o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : o[key]?.ToJsonString() ?? "";

    // ---------------------------------------------------------------- listing writer (sellers)

    public const string ListingRules =
        "You write product listings for an Indian online marketplace. Write in clear, simple English for Indian shoppers. " +
        "Use only facts present in the seller's notes; never invent certifications, warranties, materials, sizes or claims. " +
        "No superlatives such as 'best' or 'No. 1', no medical claims, no prices, no contact details, no mention of other marketplaces. " +
        "Answer with JSON only: {\"title\": str (max 150 chars, brand + product type + key attribute), " +
        "\"description\": str (80-200 words, plain paragraphs), \"highlights\": [3-6 short strings], " +
        "\"specs\": {name: value} (only facts from the notes), \"missing\": [questions the seller should answer]}";

    private static JsonObject ListingParse(string text)
    {
        var o = ReadJson(text);
        return new JsonObject
        {
            ["title"] = Str(o, "title") is { } t && t.Length > 200 ? t[..200] : Str(o, "title"),
            ["description"] = Str(o, "description") is { } d && d.Length > 10000 ? d[..10000] : Str(o, "description"),
            ["highlights"] = new JsonArray((o["highlights"] as JsonArray ?? new JsonArray())
                .Select(h => (h?.GetValue<string>() ?? "")[..Math.Min(200, (h?.GetValue<string>() ?? "").Length)])
                .Where(h => h.Trim().Length > 0).Take(10).Select(h => (JsonNode)JsonValue.Create(h)!).ToArray()),
            ["specs"] = o["specs"] is JsonObject s
                ? new JsonObject(s.Select(kv => new KeyValuePair<string, JsonNode?>(
                    kv.Key[..Math.Min(60, kv.Key.Length)],
                    JsonValue.Create((kv.Value?.GetValue<string>() ?? "")[..Math.Min(300, (kv.Value?.GetValue<string>() ?? "").Length)]))).ToArray())
                : new JsonObject(),
            ["missing"] = new JsonArray((o["missing"] as JsonArray ?? new JsonArray())
                .Select(q => (q?.GetValue<string>() ?? "")[..Math.Min(200, (q?.GetValue<string>() ?? "").Length)])
                .Take(8).Select(q => (JsonNode)JsonValue.Create(q)!).ToArray()),
        };
    }

    private static string ListingSandbox(JsonObject i, JsonObject _)
    {
        var notes = Regex.Replace(Str(i, "notes"), @"\s+", " ").Trim();
        return new JsonObject
        {
            ["title"] = $"{Str(i, "brand")} {(notes.Length > 80 ? notes[..80] : notes)}".Trim(),
            ["description"] = $"{Sandbox}\n\n{notes}",
            ["highlights"] = new JsonArray(Regex.Split(notes, @"[,.;\n]")
                .Select(s => s.Trim()).Where(s => s.Length > 3).Take(5).Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()),
            ["specs"] = new JsonObject(),
            ["missing"] = new JsonArray("What is the material?", "What sizes or quantities are available?"),
        }.ToJsonString();
    }

    // ---------------------------------------------------------------- listing check (moderators)

    public const string CheckRules =
        "You help a marketplace moderator in India review a product listing. Point out likely problems only: " +
        "prohibited or regulated items (weapons, drugs, prescription medicines, tobacco, wildlife products, counterfeit brands), " +
        "misleading health or safety claims, contact details or external links in the text, a title that does not match the " +
        "description, an MRP that looks unrealistic, or a GST rate that looks wrong for the item. Do not invent problems. " +
        "Answer with JSON only: {\"risk\": \"low\"|\"medium\"|\"high\", \"issues\": [short strings], \"suggested_reason\": str}";

    private static JsonObject CheckParse(string text)
    {
        var o = ReadJson(text);
        var risk = Str(o, "risk");
        if (risk is not ("low" or "medium" or "high")) risk = "medium";
        return new JsonObject
        {
            ["risk"] = risk,
            ["issues"] = new JsonArray((o["issues"] as JsonArray ?? new JsonArray())
                .Select(x => (x?.GetValue<string>() ?? "")[..Math.Min(200, (x?.GetValue<string>() ?? "").Length)])
                .Take(10).Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
            ["suggested_reason"] = Str(o, "suggested_reason") is { } r && r.Length > 500 ? r[..500] : Str(o, "suggested_reason"),
        };
    }

    /// <summary>Reference: ai.tasks.rule_check — deterministic checks that run with or without AI.</summary>
    public static JsonObject RuleCheck(JsonObject listing)
    {
        var highlights = listing["highlights"] as JsonArray ?? new JsonArray();
        var text = string.Join(" ", new[] { Str(listing, "title"), Str(listing, "description") }
            .Concat(highlights.Select(h => h?.GetValue<string>() ?? "")));
        var issues = new List<string>();
        var banned = Banned.Match(text);
        if (banned.Success) issues.Add($"Mentions a restricted item: \"{banned.Value}\"");
        if (Contact.IsMatch(text)) issues.Add("Contains a phone number, email or web link");
        foreach (var v in (listing["variants"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
        {
            var mrp = v["mrp"]?.GetValue<double>() ?? 0;
            var price = v["price"]?.GetValue<double>() ?? 0;
            if (mrp > 0 && price / mrp < 0.2)
            {
                issues.Add("Discount above 80% of MRP: check the MRP is real");
                break;
            }
        }
        if (Str(listing, "description").Length < 60) issues.Add("Description is very short");
        var risk = issues.Any(i => i.Contains("restricted")) ? "high" : issues.Count > 0 ? "medium" : "low";
        return new JsonObject
        {
            ["risk"] = risk,
            ["issues"] = new JsonArray(issues.Select(i => (JsonNode)JsonValue.Create(i)!).ToArray()),
            ["suggested_reason"] = issues.FirstOrDefault() ?? "",
        };
    }

    private static string CheckSandbox(JsonObject _, JsonObject snap)
    {
        var o = RuleCheck(snap);
        var issues = (o["issues"] as JsonArray) ?? new JsonArray();
        issues.Insert(0, Sandbox);
        return o.ToJsonString();
    }

    // ---------------------------------------------------------------- review summary (system job)

    public const string SummaryRules =
        "Summarise customer reviews of one product for other shoppers in 2-3 short sentences: what people like, and common " +
        "complaints if any. Be neutral and factual, do not quote names, do not add information not in the reviews. Plain text only.";

    private static string SummarySandbox(JsonObject _, JsonObject snap)
    {
        var reviews = snap["reviews"] as JsonArray ?? new JsonArray();
        var n = reviews.Count;
        var avg = n > 0 ? reviews.Average(r => r?["rating"]?.GetValue<int>() ?? 0) : 0;
        return $"{Sandbox} Average rating {avg:0.0} from {n} reviews.";
    }

    // ---------------------------------------------------------------- support reply (support desk)

    public const string SupportRules =
        "You draft replies for the customer support team of an Indian online marketplace. A staff member reviews and edits " +
        "every draft before it is sent.\n" +
        "Rules — never violate:\n" +
        "- Output the reply body only: no preamble, no subject line, no markdown, no signature placeholder.\n" +
        "- Use only facts from the ticket and order context. Never promise refunds, replacements, dates or compensation that " +
        "the context does not already confirm; say the team will check instead.\n" +
        "- Never ask for OTPs, passwords, card numbers or UPI PINs.\n" +
        "- Keep it under 120 words, plain Indian English, address the customer by first name if known.\n" +
        "- Match the requested tone: friendly, formal or apologetic.";

    private static string SupportBuild(JsonObject i, JsonObject s)
    {
        var convo = string.Join("\n", (s["messages"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().TakeLast(8)
            .Select(m => $"- {m["who"]?.GetValue<string>()}: {(m["body"]?.GetValue<string>() ?? "")[..Math.Min(600, (m["body"]?.GetValue<string>() ?? "").Length)]}"));
        var firstName = Str(s, "first_name");
        return $"Ticket {Str(s, "number")}: {Str(s, "subject")}\nCategory: {Str(s, "category")}\n" +
            $"Customer first name: {(firstName.Length > 0 ? firstName : "unknown")}\n" +
            $"Order: {(Str(s, "order").Length > 0 ? Str(s, "order") : "none linked")}\nConversation so far:\n{(convo.Length > 0 ? convo : "- (no messages)")}\n\n" +
            $"Tone: {Str(i, "tone")}\nWhat the reply should do: {(Str(i, "intent").Length > 0 ? Str(i, "intent") : "acknowledge and answer the latest message")}\n\nDraft the reply now.";
    }

    private static string SupportSandbox(JsonObject i, JsonObject s)
    {
        var name = Str(s, "first_name");
        return $"Hi {(name.Length > 0 ? name : "there")}, thank you for writing to us about \"{Str(s, "subject")}\". {Sandbox} We are checking this and will update you shortly.";
    }

    // ---------------------------------------------------------------- customer message (orders)

    public const string MessageRules =
        "You draft a message from an Indian online marketplace to one customer about their order. A staff member reviews " +
        "and sends it.\n" +
        "Rules — never violate:\n" +
        "- First line: 'Subject: ' followed by a short subject. Then a blank line, then the message body.\n" +
        "- Use only facts from the order context; never invent dates, amounts, refunds or policies.\n" +
        "- Never ask for OTPs, passwords, card numbers or UPI PINs. No links other than the order link given.\n" +
        "- Under 150 words, plain Indian English, match the requested tone.";

    private static string MessageBuild(JsonObject i, JsonObject s)
    {
        var pkgs = string.Join("\n", (s["packages"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Select(p => $"- {p["number"]?.GetValue<string>()} from {p["seller"]?.GetValue<string>()}: {p["status"]?.GetValue<string>()}" +
                (p["tracking"]?.GetValue<string>() is { Length: > 0 } t ? $", tracking {t}" : "")));
        var firstName = Str(s, "first_name");
        return $"Customer first name: {(firstName.Length > 0 ? firstName : "unknown")}\nOrder {Str(s, "number")} placed {Str(s, "placed")}, " +
            $"total {Str(s, "total")}, payment {Str(s, "payment")}.\nPackages:\n{pkgs}\nOrder link: {Str(s, "link")}\n\n" +
            $"Tone: {Str(i, "tone")}\nPurpose: {Str(i, "intent")}\n\nWrite the message now.";
    }

    private static JsonObject MessageParse(string text)
    {
        var body = Clean(text, 2000);
        var nl = body.IndexOf('\n');
        var subject = nl >= 0 ? body[..nl] : body;
        var rest = nl >= 0 ? body[(nl + 1)..] : "";
        if (subject.StartsWith("subject:", StringComparison.OrdinalIgnoreCase))
        {
            var s = subject[8..].Trim();
            return new JsonObject
            {
                ["subject"] = s.Length > 0 ? s[..Math.Min(150, s.Length)] : "About your order",
                ["text"] = rest.Trim()[..Math.Min(1800, rest.Trim().Length)],
            };
        }
        return new JsonObject { ["subject"] = "About your order", ["text"] = body[..Math.Min(1800, body.Length)] };
    }

    private static string MessageSandbox(JsonObject i, JsonObject s) =>
        $"Subject: About your order {Str(s, "number")}\n\nHi {(Str(s, "first_name").Length > 0 ? Str(s, "first_name") : "there")}, {Sandbox} {Str(i, "intent")}";

    // ---------------------------------------------------------------- review reply (sellers)

    public const string ReviewRules =
        "You draft a seller's public reply to a customer review on an Indian marketplace. The seller edits it before posting.\n" +
        "Rules: thank the customer; for complaints, apologise once and offer help through the marketplace's help centre; " +
        "never argue, never offer discounts or ask the customer to change the review, never share phone numbers or links. " +
        "Under 60 words, plain text only.";

    private static string ReviewBuild(JsonObject i, JsonObject s)
    {
        var body = Str(s, "body");
        return $"Product: {Str(s, "product")}\nRating: {Str(s, "rating")} of 5\nReview title: {Str(s, "title")}\n" +
            $"Review: {body[..Math.Min(1500, body.Length)]}\nTone: {Str(i, "tone")}\n\nWrite the reply now.";
    }

    private static string ReviewSandbox(JsonObject _, JsonObject s) => $"Thank you for your review of {Str(s, "product")}. {Sandbox}";

    // ---------------------------------------------------------------- business brief (admin overview)

    public const string BriefRules =
        "You write a short weekly business brief for the owner of an Indian online marketplace from the figures given.\n" +
        "Rules: use only the numbers provided, never invent figures or causes; amounts in rupees; 3 short paragraphs " +
        "(sales, operations, customers) and then 'Next steps:' with 3 practical bullet points starting with '- '. " +
        "Plain text, no markdown headings, under 220 words.";

    private static string BriefBuild(JsonObject _, JsonObject s) =>
        "Figures for the period:\n" + string.Join("\n", s.Select(kv => $"- {kv.Key}: {kv.Value}")) + "\n\nWrite the brief now.";

    private static string BriefSandbox(JsonObject _, JsonObject s) =>
        $"{Sandbox}\nSales were {Str(s, "sales")} from {Str(s, "orders")} orders ({Str(s, "sales_change")} vs the previous period).\n\n" +
        "Next steps:\n- Review cancelled packages\n- Reply to open tickets\n- Check low stock";

    // ---------------------------------------------------------------- registry

    public static readonly IReadOnlyDictionary<string, AiTask> Tasks = new AiTask[]
    {
        new("listing_writer", "Listing writer", "Sellers turn rough notes into a title, description, highlights and specifications.", "seller", "",
            "json", ListingRules, 1200, "",
            (i, _) => $"Category: {(Str(i, "category").Length > 0 ? Str(i, "category") : "not given")}\nBrand: {(Str(i, "brand").Length > 0 ? Str(i, "brand") : "not given")}\nSeller's notes:\n{Str(i, "notes")[..Math.Min(4000, Str(i, "notes").Length)]}",
            ListingParse, ListingSandbox),
        new("listing_check", "Listing check", "Flags likely policy problems for moderators. Rule-based checks always run; AI adds judgement.", "admin", "catalog",
            "json", CheckRules, 600, "product",
            (_, s) => s.ToJsonString()[..Math.Min(6000, s.ToJsonString().Length)], CheckParse, CheckSandbox),
        new("review_summary", "Review summaries", "A short neutral summary of what buyers say, shown on busy product pages. Refreshed hourly.", "system", "",
            "text", SummaryRules, 300, "product",
            (_, s) => $"Product: {Str(s, "title")}\nReviews:\n" + string.Join("\n", (s["reviews"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Take(60)
                .Select(r => $"- {r["rating"]?.GetValue<int>()}★ {(r["body"]?.GetValue<string>() ?? "")[..Math.Min(500, (r["body"]?.GetValue<string>() ?? "").Length)]}")),
            TextParser(800), SummarySandbox),
        new("support_reply", "Support reply drafts", "Drafts a reply to a support ticket for staff to edit and send.", "admin", "support",
            "text", SupportRules, 500, "ticket", SupportBuild, TextParser(1500), SupportSandbox),
        new("customer_message", "Customer messages", "Drafts an email and in-app message to a customer about their order; staff approve and send.", "admin", "orders",
            "text", MessageRules, 600, "order", MessageBuild, MessageParse, MessageSandbox),
        new("review_reply", "Review replies", "Sellers draft a polite public reply to a review.", "seller", "",
            "text", ReviewRules, 300, "review", ReviewBuild, TextParser(600), ReviewSandbox),
        new("business_brief", "Business brief", "A plain-language summary of the period's numbers with next steps, on the admin overview.", "admin", "dashboard",
            "text", BriefRules, 700, "kpis", BriefBuild, TextParser(2000), BriefSandbox),
    }.ToDictionary(t => t.Key);
}
