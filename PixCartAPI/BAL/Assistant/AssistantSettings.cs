using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.AI;
using DAL;
using Utils;

namespace BAL.Assistant;

/// <summary>
/// Assistant settings (Admin → AI assistant → Settings), stored in platform_settings["assistant"]. Every value has a
/// default and a validation rule. Per-person memory notes live under "asst_mem:&lt;user id&gt;".
/// </summary>
public static class AssistantSettings
{
    public const string Key = "assistant";
    public const int MaxNotes = 30;
    private static readonly Regex Control = new(@"[\x00-\x08\x0b-\x1f\x7f]");
    private static readonly Regex LayaUrl = new(@"^https://([A-Za-z0-9.\-]+)(:\d{1,5})?(/[\w./-]*)?$");

    public static JsonObject Defaults => (JsonObject)RefData.Obj("assistant_defaults").DeepClone();

    public static JsonObject Langs => (JsonObject)RefData.Obj("assistant_langs").DeepClone();

    public static JsonObject Merge(JsonObject saved)
    {
        var outp = Defaults;
        foreach (var (k, v) in saved)
        {
            if (k is "decision" or "voice" && v is JsonObject sub)
            {
                var target = (JsonObject)outp[k]!;
                var defs = (JsonObject)Defaults[k]!;
                foreach (var (kk, vv) in sub) if (defs.ContainsKey(kk)) target[kk] = vv?.DeepClone();
            }
            else if (outp.ContainsKey(k)) outp[k] = v?.DeepClone();
        }
        return outp;
    }

    /// <summary>The saved settings over the defaults, with the Laya token still encrypted.</summary>
    public static async Task<JsonObject> StoredAsync(AiDAL dal) => Merge(await dal.SettingAsync(Key));

    public static async Task<JsonObject> GetAsync(AiDAL dal, EncryptDecrypt crypto, bool reveal = false)
    {
        var cfg = await StoredAsync(dal);
        var d = (JsonObject)cfg["decision"]!;
        var enc = J.S(d["laya_key"]);
        if (reveal)
        {
            d["laya_key"] = enc.Length > 0 ? crypto.Decrypt(enc) : "";
        }
        else
        {
            d["laya_key_set"] = enc.Length > 0;
            d["laya_key"] = "";
            var url = J.S(d["laya_url"]);
            d["laya_url_blocked"] = url.Length > 0 && !LayaAllowed(url); // saved before the public https rule
        }
        return cfg;
    }

    public static string Text(JsonNode? v, int limit) => J.Cut(Control.Replace(J.S(v), ""), limit).Trim();

    /// <summary>A name or address on the public internet: not private, loopback, link-local or cloud metadata.</summary>
    private static bool PublicHost(string host)
    {
        host = host.ToLowerInvariant().TrimEnd('.');
        var last = host.Contains('.') ? host[(host.LastIndexOf('.') + 1)..] : host;
        if (last.Length > 0 && last.All(char.IsDigit))
        {
            // an IPv4 address: no real top-level domain is a number; short or octal forms such as 127.1 are refused
            var parts = host.Split('.');
            if (parts.Length != 4 || parts.Any(p => p.Length == 0 || p.Length > 3 || (p.Length > 1 && p[0] == '0') || !int.TryParse(p, out var n) || n > 255)) return false;
            var b = parts.Select(byte.Parse).ToArray();
            var isPrivate = b[0] == 10 || b[0] == 127 || b[0] == 0 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) ||
                            (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) || b[0] >= 224 || (b[0] == 192 && b[1] == 0 && b[2] == 2) ||
                            (b[0] == 198 && b[1] >= 18 && b[1] <= 19) || (b[0] == 198 && b[1] == 51 && b[2] == 100) || (b[0] == 203 && b[1] == 0 && b[2] == 113);
            return !isPrivate;
        }
        return host.Contains('.') && !host.EndsWith(".internal") && !host.EndsWith(".local") && !host.EndsWith(".localhost");
    }

    /// <summary>Every staff question and the bearer token go to this address, so it must be public https.</summary>
    public static string CheckLayaUrl(JsonNode? value)
    {
        var url = Text(value, 300).TrimEnd('/');
        var m = LayaUrl.Match(url);
        if (url.Length > 0 && !m.Success) throw new ArgumentException("Laya address must start with https://, like https://laya.example.com");
        if (m.Success && !PublicHost(m.Groups[1].Value)) throw new ArgumentException("Laya address must be a public https address, not a private, local or cloud metadata one");
        return url;
    }

    public static bool LayaAllowed(string url)
    {
        try { return CheckLayaUrl(JsonValue.Create(url)).Length > 0; }
        catch (ArgumentException) { return false; }
    }

    /// <summary>Whether a save changes where questions go (address, path) or the token. Takes stored decision settings.</summary>
    public static bool LayaChanged(JsonObject before, JsonObject after) =>
        new[] { "laya_url", "laya_path", "laya_key" }.Any(k => J.S(before[k]) != J.S(after[k]));

    private static double Num(JsonNode? v, string err) => J.Double(v) ?? throw new ArgumentException(err);

    /// <summary>Checks and cleans new settings. current is the stored decision settings.</summary>
    public static JsonObject Validate(JsonObject data, JsonObject current, EncryptDecrypt crypto)
    {
        var cfg = Merge(data);
        if (!J.IsBool(cfg["enabled"]) || !J.IsBool(cfg["share_contact_details"])) throw new ArgumentException("Switches must be on or off");
        foreach (var (k, lo, hi) in new[] { ("max_steps", 1, 15), ("max_output_tokens", 256, 8000), ("history_messages", 4, 60) })
        {
            if (!J.IsInt(cfg[k]) || J.Long(cfg[k]) is not { } num || num < lo || num > hi)
                throw new ArgumentException($"{k.Replace('_', ' ')} must be a whole number from {lo} to {hi}");
        }
        var name = Text(cfg["name"], 40);
        cfg["name"] = name.Length > 0 ? name : "Assistant";
        cfg["instructions"] = Text(cfg["instructions"], 2000);
        cfg["suggestions"] = J.Strings((cfg["suggestions"] as JsonArray ?? []).Select(s => Text(s, 120)).Where(s => s.Length > 0).Take(8));
        var d = (JsonObject)cfg["decision"]!;
        if (J.S(d["provider"]) is not ("off" or "rules" or "laya")) throw new ArgumentException("Decision layer is off, rules or laya");
        var conf = Num(d["min_confidence"], "Decision layer numbers are not valid");
        var timeout = (long)Num(d["laya_timeout_ms"], "Decision layer numbers are not valid");
        if (conf < 0 || conf > 1 || timeout < 100 || timeout > 5000) throw new ArgumentException("Confidence is 0–1 and the Laya timeout 100–5000 ms");
        d["min_confidence"] = conf;
        d["laya_timeout_ms"] = timeout;
        d["prefetch"] = J.Truthy(d["prefetch"]);
        var url = Text(d["laya_url"], 300).TrimEnd('/');
        // an unchanged address saved before the public https rule does not block saving other settings; it is not used
        d["laya_url"] = url.Length > 0 && url == J.S(current["laya_url"]) ? url : CheckLayaUrl(JsonValue.Create(url));
        var path = Text(d["laya_path"], 60);
        d["laya_path"] = path.Length > 0 ? path : "/predict";
        if (!J.S(d["laya_path"]).StartsWith('/')) throw new ArgumentException("Laya path must start with /");
        if (J.S(d["provider"]) == "laya" && J.S(d["laya_url"]).Length == 0) throw new ArgumentException("Enter the Laya server address, or choose the built-in rules");
        var newKey = Text(d["laya_key"], 300);
        d.Remove("laya_key");
        d.Remove("laya_key_set");
        d.Remove("laya_url_blocked");
        // the saved token only ever goes to the server it was entered for: a new address or path drops it
        var curPath = J.S(current["laya_path"]);
        var moved = J.S(d["laya_url"]) != J.S(current["laya_url"]) || J.S(d["laya_path"]) != (curPath.Length > 0 ? curPath : "/predict");
        var asked = data["decision"] as JsonObject;
        var drop = moved || (asked != null && J.Truthy(asked["clear_laya_key"]));
        d["laya_key"] = newKey.Length > 0 ? crypto.Encrypt(newKey) : drop ? "" : J.S(current["laya_key"]);
        var v = (JsonObject)cfg["voice"]!;
        var langs = Langs;
        var chosen = (v["languages"] as JsonArray ?? []).Select(J.S).Where(langs.ContainsKey).Take(8).ToList();
        if (chosen.Count == 0) chosen = ["en-IN"];
        v["languages"] = J.Strings(chosen);
        if (!chosen.Contains(J.S(v["default_language"]))) v["default_language"] = chosen[0];
        foreach (var (k, lo, hi) in new[] { ("rate", 0.5, 2.0), ("pitch", 0.5, 2.0) })
        {
            var n = J.Double(v[k]) ?? throw new ArgumentException($"Voice {k} must be a number");
            if (n < lo || n > hi) throw new ArgumentException($"Voice {k} must be between {lo.ToString(CultureInfo.InvariantCulture)} and {hi.ToString("0.0", CultureInfo.InvariantCulture)}");
            v[k] = n;
        }
        v["enabled"] = J.Truthy(v["enabled"]);
        v["speak_replies"] = J.Truthy(v["speak_replies"]);
        v["auto_listen"] = J.Truthy(v["auto_listen"]);
        v["voice_name"] = Text(v["voice_name"], 120);
        return cfg;
    }

    // ---------------------------------------------------------------- memory notes

    private static string MemKey(Guid userId) => $"asst_mem:{userId}";

    public static async Task<List<string>> MemoriesAsync(AiDAL dal, Guid userId) =>
        ((await dal.SettingAsync(MemKey(userId)))["notes"] as JsonArray ?? []).Select(J.S).ToList();

    public static async Task<List<string>> SetMemoriesAsync(AiDAL dal, Guid userId, IEnumerable<string> notes)
    {
        var clean = notes.Select(n => Text(JsonValue.Create(n), 300)).Where(n => n.Length > 0).ToList();
        if (clean.Count > MaxNotes) clean = clean[^MaxNotes..];
        await dal.SaveSettingAsync(MemKey(userId), J.O(("notes", J.Strings(clean))));
        return clean;
    }
}

/// <summary>
/// Turns "today", "last month" or two dates into exact IST ranges. The model passes a preset name (or explicit dates);
/// the server does the calendar arithmetic so the assistant never miscounts days.
/// </summary>
public sealed record Period(DateTime StartUtc, DateTime EndUtc, DateOnly FirstDay, DateOnly LastDay, string Label, string Preset)
{
    public static readonly string[] Presets =
    [
        "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days",
        "last_90_days", "this_quarter", "this_year", "this_financial_year", "last_financial_year", "custom",
    ];

    public const int MaxDays = 731;
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public int Days => LastDay.DayNumber - FirstDay.DayNumber + 1;

    public static DateOnly Today() => DateOnly.FromDateTime(DateTimeFunctions.ToIst(DateTimeFunctions.UtcNow()));

    public static Period Make(DateOnly first, DateOnly last, string label, string preset) =>
        new(DateTimeFunctions.IstToUtc(first.ToDateTime(TimeOnly.MinValue)), DateTimeFunctions.IstToUtc(last.AddDays(1).ToDateTime(TimeOnly.MinValue)), first, last, label, preset);

    /// <summary>The same-length period just before this one (for "vs previous" comparisons).</summary>
    public Period Previous()
    {
        if (Preset is "this_month" or "last_month")
        {
            var last = FirstDay.AddDays(-1);
            var first = new DateOnly(last.Year, last.Month, 1);
            if (Preset == "this_month")
            {
                var cap = first.AddDays(Days - 1);
                if (cap < last) last = cap; // month-to-date against the same days of the previous month
            }
            return Make(first, last, "previous period", "custom");
        }
        var l = FirstDay.AddDays(-1);
        return Make(l.AddDays(-(Days - 1)), l, "previous period", "custom");
    }

    public JsonObject AsDict() => J.O(("label", Label), ("from", FirstDay.ToString("yyyy-MM-dd", Inv)), ("to", LastDay.ToString("yyyy-MM-dd", Inv)), ("days", Days),
        ("timezone", "IST (UTC+05:30)"));

    private static string Fmt(DateOnly d) => d.ToString("dd MMM yyyy", Inv).TrimStart('0');

    /// <summary>Throws ArgumentException with a message the model can relay.</summary>
    public static Period Resolve(string? preset = null, string? dateFrom = null, string? dateTo = null)
    {
        var t = Today();
        var p = (string.IsNullOrEmpty(preset) ? (!string.IsNullOrEmpty(dateFrom) || !string.IsNullOrEmpty(dateTo) ? "custom" : "last_30_days") : preset).Trim().ToLowerInvariant();
        if (!Presets.Contains(p)) throw new ArgumentException($"Unknown period '{preset}'. Use one of: {string.Join(", ", Presets)}");
        switch (p)
        {
            case "custom":
            {
                DateOnly? first = null, last = null;
                try
                {
                    if (!string.IsNullOrEmpty(dateFrom)) first = DateOnly.ParseExact(dateFrom, "yyyy-MM-dd", Inv);
                    if (!string.IsNullOrEmpty(dateTo)) last = DateOnly.ParseExact(dateTo, "yyyy-MM-dd", Inv);
                }
                catch (FormatException)
                {
                    throw new ArgumentException("Dates must look like 2026-11-17");
                }
                if (first is null && last is null) throw new ArgumentException("Give date_from and/or date_to for a custom period");
                var f = first ?? last!.Value;
                var l = last ?? t;
                if (f > l) (f, l) = (l, f);
                if (l > t) l = t;
                if (l.DayNumber - f.DayNumber >= MaxDays) throw new ArgumentException($"Ask for at most {MaxDays} days at a time");
                return Make(f, l, f == l ? Fmt(f) : $"{Fmt(f)} to {Fmt(l)}", p);
            }
            case "today": return Make(t, t, $"Today, {Fmt(t)}", p);
            case "yesterday": { var y = t.AddDays(-1); return Make(y, y, $"Yesterday, {Fmt(y)}", p); }
            case "this_week": { var f = t.AddDays(-((int)t.DayOfWeek + 6) % 7); return Make(f, t, $"This week ({Fmt(f)} to {Fmt(t)})", p); }
            case "last_week": { var l = t.AddDays(-(((int)t.DayOfWeek + 6) % 7 + 1)); var f = l.AddDays(-6); return Make(f, l, $"Last week ({Fmt(f)} to {Fmt(l)})", p); }
            case "this_month": { var f = new DateOnly(t.Year, t.Month, 1); return Make(f, t, $"{t.ToString("MMMM yyyy", Inv)} so far", p); }
            case "last_month": { var l = new DateOnly(t.Year, t.Month, 1).AddDays(-1); return Make(new DateOnly(l.Year, l.Month, 1), l, l.ToString("MMMM yyyy", Inv), p); }
            case "last_7_days" or "last_30_days" or "last_90_days":
            {
                var n = int.Parse(p.Split('_')[1], Inv);
                var f = t.AddDays(-(n - 1));
                return Make(f, t, $"Last {n} days ({Fmt(f)} to {Fmt(t)})", p);
            }
            case "this_quarter": { var f = new DateOnly(t.Year, 3 * ((t.Month - 1) / 3) + 1, 1); return Make(f, t, $"This quarter ({Fmt(f)} to {Fmt(t)})", p); }
            case "this_year": return Make(new DateOnly(t.Year, 1, 1), t, $"{t.Year} so far", p);
        }
        var fy = t.Month >= 4 ? t.Year : t.Year - 1;
        if (p == "this_financial_year") return Make(new DateOnly(fy, 4, 1), t, $"FY {fy}-{(fy + 1).ToString(Inv)[2..]} so far", p);
        return Make(new DateOnly(fy - 1, 4, 1), new DateOnly(fy, 3, 31), $"FY {fy - 1}-{fy.ToString(Inv)[2..]}", p);
    }
}
