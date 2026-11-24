using System.Text.RegularExpressions;

namespace BAL.ShopAssistant;

/// <summary>What does the customer want? Fast multilingual rules (English, Tanglish, Tamil, Hindi), no model needed.
/// Reference: shop_assistant/intents.py.</summary>
public static partial class ShopIntents
{
    public static readonly Regex OrderRe = OrderRegex();
    public static readonly Regex TicketRe = TicketRegex();

    [GeneratedRegex(@"\b(PC\d{6}[A-Z0-9]{6})(-\d{1,2})?\b", RegexOptions.IgnoreCase)]
    private static partial Regex OrderRegex();

    [GeneratedRegex(@"\b(TK\d{6}[0-9A-F]{4})\b", RegexOptions.IgnoreCase)]
    private static partial Regex TicketRegex();

    private static readonly Regex PriceMaxRe = new(@"(?:under|below|less than|within|upto|up to|max(?:imum)?|budget|kulla|kammi|से कम|के अंदर|க்குள்)\s*(?:rs\.?|₹|inr|rupees)?\s*(\d[\d,]*)\s*(k)?", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PriceMaxAfterRe = new(@"(?:rs\.?|₹)?\s*(\d[\d,]*)\s*(k)?\s*(?:rs|rupees|₹)?\s*(?:kulla|ku kammi|ku keela|க்குள்|से कम|तक)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PriceRangeRe = new(@"between\s*(?:rs\.?|₹)?\s*(\d[\d,]*)\s*(?:and|to|-)\s*(?:rs\.?|₹)?\s*(\d[\d,]*)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PriceMinRe = new(@"(?:above|over|more than|min(?:imum)?)\s*(?:rs\.?|₹|inr)?\s*(\d[\d,]*)\s*(k)?", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static readonly Dictionary<string, string[]> Keywords = new()
    {
        ["grievance"] = ["grievance", "consumer court", "consumer forum", "escalate", "legal action", "புகார் அதிகாரி", "शिकायत अधिकारी"],
        ["human"] = ["human", "agent", "customer care", "customer service", "talk to", "speak to", "call me", "representative",
            "real person", "support team", "contact support", "raise ticket", "raise a ticket", "create ticket", "open a ticket",
            "complaint", "complain", "executive", "connect me", "help desk", "manager", "யாராவது", "மனிதர்", "बात करनी",
            "कस्टमर केयर", "शिकायत"],
        ["tickets"] = ["my tickets", "my ticket", "my requests", "my complaints", "ticket status", "request status",
            "complaint status", "ticket update"],
        ["cancel"] = ["cancel", "venaam", "vendam", "vendaam", "dont want", "do not want", "ரத்து", "கேன்சல்", "வேண்டாம்",
            "रद्द", "कैंसल", "नहीं चाहिए"],
        ["damaged"] = ["damaged", "broken", "defective", "not working", "doesnt work", "does not work", "wrong item",
            "different item", "wrong product", "wrong size", "fake", "missing item", "item missing", "torn", "udanji",
            "work aagala", "சேதம்", "உடைந்த", "வேலை செய்யல", "टूटा", "खराब", "गलत सामान"],
        ["return"] = ["return", "replace", "replacement", "exchange", "send back", "thiruppi", "திருப்பி", "ரிட்டர்ன்",
            "மாற்ற", "वापस", "रिटर्न", "बदलना"],
        ["refund"] = ["refund", "money back", "my money", "paisa", "panam", "பணம்", "ரீஃபண்ட்", "रिफंड", "पैसा वापस", "पैसे वापस"],
        ["payment"] = ["payment failed", "payment fail", "payment issue", "money deducted", "amount deducted", "debited",
            "paid but", "transaction failed", "upi failed", "charged twice", "double payment", "payment pending",
            "पेमेंट फेल", "பணம் போச்சு", "panam pochu"],
        ["track"] = ["track", "where is my", "order status", "status of my", "my order", "my orders", "my package",
            "when will", "when do i get", "not received", "not delivered", "still not", "delivery status", "late delivery",
            "delayed", "enga", "eppo varum", "eppo vara", "varala", "varalai", "kedaikala", "vandhuducha", "எங்கே", "எப்போ",
            "வரவில்லை", "வரல", "ஆர்டர்", "कहाँ है", "कब आएगा", "कब मिलेगा", "नहीं मिला", "मेरा ऑर्डर", "ऑर्डर"],
        ["search"] = ["show me", "looking for", "look for", "find me", "find a", "search", "want to buy", "i want a",
            "i need a", "do you have", "do you sell", "price of", "recommend", "suggest", "best ", "cheap", "kaattu",
            "kaatu", "venum", "வாங்க", "காட்டு", "வேணும்", "दिखाओ", "चाहिए", "खरीदना"],
        ["thanks"] = ["thanks", "thank you", "thank u", "thx", "nandri", "romba nandri", "நன்றி", "धन्यवाद", "shukriya"],
        ["bye"] = ["bye", "goodbye", "that's all", "thats all", "no thanks", "nothing else", "போதும்", "बस"],
        ["greet"] = ["hi", "hii", "hello", "hey", "vanakkam", "namaste", "namaskar", "good morning", "good afternoon",
            "good evening", "வணக்கம்", "नमस्ते"],
    };

    /// <summary>Words that only name the intent; removed before a product search.</summary>
    private static readonly HashSet<string> SearchNoise = new(
        "show find search want buy need looking look have sell price recommend suggest best cheap good kaattu kaatu venum me some any one products product items item options under below above within upto rs inr rupees budget".Split());

    public sealed class Intent
    {
        public string Name { get; set; } = "unknown";
        public string Lang { get; set; } = "en";
        public string? OrderNumber { get; set; }
        public string? PackageNumber { get; set; }
        public string? TicketNumber { get; set; }
        public string Query { get; set; } = "";
        public long? MinPrice { get; set; }
        public long? MaxPrice { get; set; }
        public List<string> Also { get; set; } = [];
    }

    public static string Language(string text)
    {
        if (Regex.IsMatch(text, "[\u0B80-\u0BFF]")) return "ta";
        if (Regex.IsMatch(text, "[\u0900-\u097F]")) return "hi";
        return "en";
    }

    private static bool Has(string norm, string phrase)
    {
        var p = ShopKb.Normalize(phrase);
        if (p.Length == 0) return false;
        if (Regex.IsMatch(p, "[a-z]"))
        {
            // Short words must be whole words ("hi" is not "highlight"); longer ones also match their endings
            // ("cancel" -> "cancelled", "return" -> "returned", "varala" -> "varalai").
            var end = p.Length <= 3 ? @"(?![a-z0-9])" : "";
            return Regex.IsMatch(norm, $@"(?<![a-z0-9]){Regex.Escape(p)}{end}");
        }
        return norm.Contains(p);
    }

    private static long Rupees(string num, string? k)
    {
        var v = long.Parse(num.Replace(",", ""));
        return k == "k" ? v * 1000 * 100 : v * 100;
    }

    public static (long? Lo, long? Hi) Prices(string text)
    {
        long? lo = null, hi = null;
        var m = PriceRangeRe.Match(text);
        if (m.Success)
        {
            var a = long.Parse(m.Groups[1].Value.Replace(",", "")) * 100;
            var b = long.Parse(m.Groups[2].Value.Replace(",", "")) * 100;
            return (Math.Min(a, b), Math.Max(a, b));
        }
        m = PriceMaxRe.Match(text);
        if (!m.Success) m = PriceMaxAfterRe.Match(text);
        if (m.Success) hi = Rupees(m.Groups[1].Value, m.Groups[2].Success ? m.Groups[2].Value : null);
        m = PriceMinRe.Match(text);
        if (m.Success) lo = Rupees(m.Groups[1].Value, m.Groups[2].Success ? m.Groups[2].Value : null);
        return (lo, hi);
    }

    public static string SearchTerms(string text)
    {
        var t = PriceRangeRe.Replace(text, " ");
        t = PriceMaxRe.Replace(t, " ");
        t = PriceMaxAfterRe.Replace(t, " ");
        t = PriceMinRe.Replace(t, " ");
        var words = ShopKb.Tokens(t).Where(w => !SearchNoise.Contains(w) && !long.TryParse(w, out _)).ToList();
        return string.Join(' ', words.Take(8));
    }

    public static Intent Detect(string text)
    {
        var norm = $" {ShopKb.Normalize(text)} ";
        var lang = Language(text);
        var order = OrderRe.Match(text);
        var ticket = TicketRe.Match(text);
        var seen = Keywords.Where(kv => kv.Value.Any(w => Has(norm, w))).Select(kv => kv.Key).ToList();
        var (lo, hi) = Prices(text);
        var it = new Intent { Lang = lang, Also = seen };
        if (order.Success)
        {
            it.OrderNumber = order.Groups[1].Value.ToUpperInvariant();
            it.PackageNumber = order.Groups[2].Success ? (order.Groups[1].Value + order.Groups[2].Value).ToUpperInvariant() : null;
        }
        if (ticket.Success) it.TicketNumber = ticket.Groups[1].Value.ToUpperInvariant();
        var @short = ShopKb.Tokens(text).Count <= 3;

        if (ticket.Success && !seen.Any(x => x is "human" or "grievance")) it.Name = "ticket_status";
        else if (seen.Contains("grievance")) it.Name = "grievance";
        else if (seen.Contains("tickets")) it.Name = "tickets";
        else if (seen.Contains("human")) it.Name = "human";
        else if (seen.Contains("cancel")) it.Name = "cancel";
        else if (seen.Contains("damaged")) it.Name = "damaged";
        else if (seen.Contains("return")) it.Name = "return";
        else if (seen.Contains("payment")) it.Name = "payment";
        else if (seen.Contains("refund")) it.Name = "refund";
        else if (seen.Contains("track") || order.Success) it.Name = "track";
        else if (seen.Contains("search") || lo is not null || hi is not null) it.Name = "search";
        else if (seen.Contains("thanks") && @short) it.Name = "thanks";
        else if (seen.Contains("bye") && @short) it.Name = "bye";
        else if (seen.Contains("greet") && @short) it.Name = "greet";
        if (it.Name is "search" or "unknown")
        {
            it.Query = SearchTerms(text);
            it.MinPrice = lo;
            it.MaxPrice = hi;
        }
        return it;
    }
}
