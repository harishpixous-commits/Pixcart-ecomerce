using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Utils;

namespace BAL.AI;

/// <summary>
/// One AI studio task: frozen rules (the first, cached system block, never editable from the admin panel), a builder
/// for the per-request message, a parser that validates the answer, and a sandbox that produces an obviously-marked
/// answer when no model is connected, so screens and tests work offline.
/// </summary>
public sealed record AiTask(string Key, string Label, string Description, string Audience, string Permission, string Output, string Rules,
    Func<JsonObject, JsonObject, string> Build, Func<string, JsonObject> Parse, Func<JsonObject, JsonObject, string> Sandbox, int MaxTokens = 800,
    string Subject = "");

/// <summary>The AI task registry: every AI studio feature is declared here once (reference app/ai/tasks.py).</summary>
public static class AiTasks
{
    public static readonly string[] Tones = ["friendly", "formal", "apologetic"];
    public const string SandboxMark = "[Sandbox draft — connect an Anthropic API key for real AI text]";
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private static AppException BadOutput() => new("The AI answer could not be read. Try again.", "ai_bad_output", 502);

    private static JsonObject ParseJson(string text)
    {
        var m = Regex.Match(text, @"\{.*\}", RegexOptions.Singleline);
        if (!m.Success) throw BadOutput();
        try
        {
            return JsonNode.Parse(m.Value) as JsonObject ?? throw BadOutput();
        }
        catch (JsonException)
        {
            throw BadOutput();
        }
    }

    private static readonly Regex Control = new(@"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]");
    private static readonly Regex Preamble = new(@"^(here('s| is)[^\n:]{0,60}:\s*)", RegexOptions.IgnoreCase);

    public static string Clean(string text, int limit)
    {
        text = Control.Replace(text ?? "", "").Trim();
        text = Preamble.Replace(text, "", 1);
        return J.Cut(text, limit).Trim();
    }

    private static Func<string, JsonObject> TextParser(int limit) => text =>
    {
        var body = Clean(text, limit);
        if (body.Length == 0) throw new AppException("The AI returned an empty answer. Try again.", "ai_empty", 502);
        return J.O(("text", body));
    };

    private static IEnumerable<JsonNode?> Items(JsonNode? n) => n as JsonArray ?? [];

    // ---------------------------------------------------------------- listing writer (sellers)

    private static JsonObject ListingParse(string text)
    {
        var o = ParseJson(text);
        var specs = new JsonObject();
        if (o["specs"] is JsonObject so)
            foreach (var (k, v) in so) specs[J.Cut(k, 60)] = J.Cut(J.S(v), 300);
        return J.O(
            ("title", J.Cut(J.S(o["title"]), 200)),
            ("description", J.Cut(J.S(o["description"]), 10000)),
            ("highlights", J.Strings(Items(o["highlights"]).Where(h => J.S(h).Trim().Length > 0).Select(h => J.Cut(J.S(h), 200)).Take(10))),
            ("specs", specs),
            ("missing", J.Strings(Items(o["missing"]).Select(q => J.Cut(J.S(q), 200)).Take(8))));
    }

    private static string ListingSandbox(JsonObject i, JsonObject _)
    {
        var notes = string.Join(' ', J.S(i["notes"]).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return J.Dumps(J.O(
            ("title", $"{J.S(i["brand"])} {J.Cut(notes, 80)}".Trim()),
            ("description", $"{SandboxMark}\n\n{notes}"),
            ("highlights", J.Strings(Regex.Split(notes, @"[,.;\n]").Select(s => s.Trim()).Where(s => s.Length > 3).Take(5))),
            ("specs", new JsonObject()),
            ("missing", J.Strings(["What is the material?", "What sizes or quantities are available?"]))));
    }

    // ---------------------------------------------------------------- listing check (moderators)

    private static readonly Regex Banned = new(@"\b(gun|pistol|ammunition|cannabis|ganja|tobacco|cigarette|vape|ivory|prescription|steroid|replica|first copy|7a quality)\b", RegexOptions.IgnoreCase);
    private static readonly Regex Contact = new(@"(\+?91[\s-]?)?[6-9]\d{9}|[\w.]+@[\w-]+\.[a-z]{2,}|https?://|www\.", RegexOptions.IgnoreCase);

    private static JsonObject CheckParse(string text)
    {
        var o = ParseJson(text);
        var risk = J.S(o["risk"]) is "low" or "medium" or "high" ? J.S(o["risk"]) : "medium";
        return J.O(("risk", risk), ("issues", J.Strings(Items(o["issues"]).Select(x => J.Cut(J.S(x), 200)).Take(10))),
            ("suggested_reason", J.Cut(J.S(o["suggested_reason"]), 500)));
    }

    /// <summary>Deterministic checks that run with or without AI.</summary>
    public static JsonObject RuleCheck(JsonObject listing)
    {
        var text = string.Join(" ", J.S(listing["title"]), J.S(listing["description"]), string.Join(" ", Items(listing["highlights"]).Select(J.S)));
        var issues = new List<string>();
        var bm = Banned.Match(text);
        if (bm.Success) issues.Add($"Mentions a restricted item: \"{bm.Value}\"");
        if (Contact.IsMatch(text)) issues.Add("Contains a phone number, email or web link");
        foreach (var v in Items(listing["variants"]).OfType<JsonObject>())
        {
            var mrp = J.Double(v["mrp"]) ?? 0;
            var price = J.Double(v["price"]) ?? 0;
            if (mrp > 0 && price > 0 && price / mrp < 0.2)
            {
                issues.Add("Discount above 80% of MRP: check the MRP is real");
                break;
            }
        }
        if (J.S(listing["description"]).Length < 60) issues.Add("Description is very short");
        var risk = issues.Any(i => i.Contains("restricted")) ? "high" : issues.Count > 0 ? "medium" : "low";
        return J.O(("risk", risk), ("issues", J.Strings(issues)), ("suggested_reason", issues.Count > 0 ? issues[0] : ""));
    }

    private static string CheckSandbox(JsonObject _, JsonObject snap)
    {
        var o = RuleCheck(snap);
        o["issues"] = J.Strings(new[] { SandboxMark }.Concat(Items(o["issues"]).Select(J.S)));
        return J.Dumps(o);
    }

    // ---------------------------------------------------------------- review summary (system job)

    private static List<(long Rating, string Body)> Reviews(JsonObject s) =>
        Items(s["reviews"]).OfType<JsonArray>().Select(r => (J.Long(r[0]) ?? 0, J.S(r[1]))).ToList();

    private static string SummarySandbox(JsonObject _, JsonObject snap)
    {
        var rs = Reviews(snap);
        var avg = rs.Count > 0 ? rs.Average(r => (double)r.Rating) : 0;
        return $"{SandboxMark} Average rating {avg.ToString("0.0", Inv)} from {rs.Count} reviews.";
    }

    // ---------------------------------------------------------------- support reply

    private static string SupportBuild(JsonObject i, JsonObject s)
    {
        var msgs = Items(s["messages"]).OfType<JsonObject>().ToList();
        var convo = string.Join("\n", msgs.Skip(Math.Max(0, msgs.Count - 8)).Select(m => $"- {J.S(m["who"])}: {J.Cut(J.S(m["body"]), 600)}"));
        var first = J.S(s["first_name"]);
        var order = J.S(s["order"]);
        var intent = J.S(i["intent"]);
        return $"Ticket {J.S(s["number"])}: {J.S(s["subject"])}\nCategory: {J.S(s["category"])}\nCustomer first name: {(first.Length > 0 ? first : "unknown")}\n" +
               $"Order: {(order.Length > 0 ? order : "none linked")}\nConversation so far:\n{(convo.Length > 0 ? convo : "- (no messages)")}\n\n" +
               $"Tone: {J.S(i["tone"])}\nWhat the reply should do: {(intent.Length > 0 ? intent : "acknowledge and answer the latest message")}\n\nDraft the reply now.";
    }

    private static string SupportSandbox(JsonObject i, JsonObject s)
    {
        var name = J.S(s["first_name"]) is { Length: > 0 } n ? n : "there";
        return $"Hi {name}, thank you for writing to us about \"{J.S(s["subject"])}\". {SandboxMark} We are checking this and will update you shortly.";
    }

    // ---------------------------------------------------------------- customer message (orders)

    private static string MessageBuild(JsonObject i, JsonObject s)
    {
        var pkgs = string.Join("\n", Items(s["packages"]).OfType<JsonObject>().Select(p =>
            $"- {J.S(p["number"])} from {J.S(p["seller"])}: {J.S(p["status"])}" + (J.S(p["tracking"]).Length > 0 ? $", tracking {J.S(p["tracking"])}" : "")));
        var first = J.S(s["first_name"]);
        return $"Customer first name: {(first.Length > 0 ? first : "unknown")}\nOrder {J.S(s["number"])} placed {J.S(s["placed"])}, total {J.S(s["total"])}, " +
               $"payment {J.S(s["payment"])}.\nPackages:\n{pkgs}\nOrder link: {J.S(s["link"])}\n\nTone: {J.S(i["tone"])}\nPurpose: {J.S(i["intent"])}\n\nWrite the message now.";
    }

    private static JsonObject MessageParse(string text)
    {
        var body = Clean(text, 2000);
        var nl = body.IndexOf('\n');
        var subject = nl >= 0 ? body[..nl] : body;
        var rest = nl >= 0 ? body[(nl + 1)..] : "";
        if (subject.StartsWith("subject:", StringComparison.OrdinalIgnoreCase))
        {
            var sub = J.Cut(subject[8..].Trim(), 150);
            return J.O(("subject", sub.Length > 0 ? sub : "About your order"), ("text", J.Cut(rest.Trim(), 1800)));
        }
        return J.O(("subject", "About your order"), ("text", J.Cut(body, 1800)));
    }

    private static string MessageSandbox(JsonObject i, JsonObject s)
    {
        var first = J.S(s["first_name"]);
        return $"Subject: About your order {J.S(s["number"])}\n\nHi {(first.Length > 0 ? first : "there")}, {SandboxMark} {J.S(i["intent"])}";
    }

    // ---------------------------------------------------------------- review reply (sellers)

    private static string ReviewBuild(JsonObject i, JsonObject s) =>
        $"Product: {J.S(s["product"])}\nRating: {J.S(s["rating"])} of 5\nReview title: {J.S(s["title"])}\nReview: {J.Cut(J.S(s["body"]), 1500)}\nTone: {J.S(i["tone"])}\n\nWrite the reply now.";

    // ---------------------------------------------------------------- business brief (admin overview)

    private static string BriefBuild(JsonObject _, JsonObject s) =>
        "Figures for the period:\n" + string.Join("\n", s.Select(kv => $"- {kv.Key}: {PyStr(kv.Value)}")) + "\n\nWrite the brief now.";

    /// <summary>Python's str() of a snapshot value (None, numbers, text).</summary>
    public static string PyStr(JsonNode? v) => v is null ? "None" : J.S(v);

    private static string BriefSandbox(JsonObject _, JsonObject s) =>
        $"{SandboxMark}\nSales were {J.S(s["sales"])} from {J.S(s["orders"])} orders ({J.S(s["sales_change"])} vs the previous period).\n\nNext steps:\n- Review cancelled packages\n- Reply to open tickets\n- Check low stock";

    private static string Rules(string key) =>
        J.S(RefData.Arr("tasks").OfType<JsonObject>().First(t => J.S(t["key"]) == key)["rules"]);

    public static readonly Dictionary<string, AiTask> All = new List<AiTask>
    {
        new("listing_writer", "Listing writer", "Sellers turn rough notes into a title, description, highlights and specifications.", "seller", "", "json",
            Rules("listing_writer"),
            (i, _) => $"Category: {(J.S(i["category"]) is { Length: > 0 } c ? c : "not given")}\nBrand: {(J.S(i["brand"]) is { Length: > 0 } b ? b : "not given")}\nSeller's notes:\n{J.Cut(J.S(i["notes"]), 4000)}",
            ListingParse, ListingSandbox, 1200),
        new("listing_check", "Listing check", "Flags likely policy problems for moderators. Rule-based checks always run; AI adds judgement.", "admin", "catalog", "json",
            Rules("listing_check"), (_, s) => J.Cut(J.Dumps(s), 6000), CheckParse, CheckSandbox, 600, "product"),
        new("review_summary", "Review summaries", "A short neutral summary of what buyers say, shown on busy product pages. Refreshed hourly.", "system", "", "text",
            Rules("review_summary"),
            (_, s) => $"Product: {J.S(s["title"])}\nReviews:\n" + string.Join("\n", Reviews(s).Take(60).Select(r => $"- {r.Rating}★ {J.Cut(r.Body, 500)}")),
            TextParser(800), SummarySandbox, 300, "product"),
        new("support_reply", "Support reply drafts", "Drafts a reply to a support ticket for staff to edit and send.", "admin", "support", "text",
            Rules("support_reply"), SupportBuild, TextParser(1500), SupportSandbox, 500, "ticket"),
        new("customer_message", "Customer messages", "Drafts an email and in-app message to a customer about their order; staff approve and send.", "admin", "orders", "text",
            Rules("customer_message"), MessageBuild, MessageParse, MessageSandbox, 600, "order"),
        new("review_reply", "Review replies", "Sellers draft a polite public reply to a review.", "seller", "", "text",
            Rules("review_reply"), ReviewBuild, TextParser(600), (_, s) => $"Thank you for your review of {J.S(s["product"])}. {SandboxMark}", 300, "review"),
        new("business_brief", "Business brief", "A plain-language summary of the period's numbers with next steps, on the admin overview.", "admin", "dashboard", "text",
            Rules("business_brief"), BriefBuild, TextParser(2000), BriefSandbox, 700, "kpis"),
    }.ToDictionary(t => t.Key);
}
