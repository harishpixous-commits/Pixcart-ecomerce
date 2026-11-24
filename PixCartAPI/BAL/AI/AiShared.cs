using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL.AI;

/// <summary>
/// Constant tables of the AI module (prompts' fixed texts, keyword lists, tool schemas, settings defaults, state names,
/// notification texts), copied from the reference version into Data/reference.json so the wording is identical.
/// </summary>
public static class RefData
{
    private static readonly Lazy<JsonObject> Root = new(() =>
    {
        var asm = Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames().First(n => n.EndsWith("reference.json", StringComparison.Ordinal));
        using var s = asm.GetManifestResourceStream(name)!;
        return (JsonObject)JsonNode.Parse(s)!;
    });

    public static JsonObject Data => Root.Value;

    public static JsonNode Get(string key) => Data[key]!;

    public static JsonObject Obj(string key) => (JsonObject)Data[key]!;

    public static JsonArray Arr(string key) => (JsonArray)Data[key]!;

    public static Dictionary<string, string> Map(string key) => Obj(key).ToDictionary(kv => kv.Key, kv => J.S(kv.Value));

    public static readonly Lazy<Dictionary<string, string>> States = new(() => Map("states"));
    public static readonly Lazy<Dictionary<string, string>> ReturnReasons = new(() => Map("return_reasons"));
    public static readonly Lazy<Dictionary<string, string>> TicketCategories = new(() => Map("ticket_categories"));
}

/// <summary>Pieces every AI area uses: the storefront site and business details, marketplace settings, money and date
/// formats, and in-app/email notifications (the reference notify outbox) until those modules are merged.</summary>
public static class AiShared
{
    public static readonly TimeZoneInfo Ist = DateTimeFunctions.Ist;
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    // ---------------------------------------------------------------- storefront site (platform_settings["site"])

    private static JsonObject SiteDefaults(AppSettings env) => J.O(
        ("brand_name", env.AppName),
        ("announcement", J.O(("enabled", true), ("text", "Free delivery on orders over {free_delivery_amount} from a seller"), ("link", "/search?sort=discount"), ("tone", "accent"))),
        ("business", J.O(("legal_name", ""), ("registered_address", ""), ("gstin", ""), ("cin", ""),
            ("grievance", J.O(("name", ""), ("designation", "Grievance Officer"), ("email", ""), ("phone", ""), ("hours", "Monday to Saturday, 10 am to 6 pm"))))),
        ("contact", J.O(("enabled", true), ("title", "Contact us"), ("items", new JsonArray()))));

    private static JsonObject DeepMerge(JsonObject baseObj, JsonObject over)
    {
        var outp = (JsonObject)baseObj.DeepClone();
        foreach (var (k, v) in over)
        {
            if (!baseObj.ContainsKey(k)) continue;
            outp[k] = baseObj[k] is JsonObject b && v is JsonObject o ? DeepMerge(b, o) : v?.DeepClone();
        }
        return outp;
    }

    /// <summary>The parts of the storefront settings the AI module reads (brand, business, contact, announcement).</summary>
    public static async Task<JsonObject> SiteAsync(AiDAL dal, AppSettings env) => DeepMerge(SiteDefaults(env), await dal.SettingAsync("site"));

    public static string Brand(JsonObject site) => J.S(site["brand_name"]);

    /// <summary>The operator details (reference cms.public_business).</summary>
    public static (string Brand, string LegalName, string SupportEmail, string SupportPhone, JsonObject Grievance) Business(JsonObject site)
    {
        var b = site["business"] as JsonObject ?? [];
        var items = ((site["contact"] as JsonObject)?["items"] as JsonArray ?? []).OfType<JsonObject>().ToList();
        string First(string type) => items.Where(i => J.S(i["type"]) == type && J.Truthy(i["enabled"])).Select(i => J.S(i["value"])).FirstOrDefault() ?? "";
        var legal = J.S(b["legal_name"]);
        return (Brand(site), legal.Length > 0 ? legal : Brand(site), First("email"), First("phone"), b["grievance"] as JsonObject ?? []);
    }

    // ---------------------------------------------------------------- marketplace settings (platform_settings["marketplace"])

    public static async Task<JsonObject> MarketplaceAsync(AiDAL dal)
    {
        var merged = (JsonObject)RefData.Obj("marketplace_defaults").DeepClone();
        foreach (var (k, v) in await dal.SettingAsync("marketplace"))
            if (merged.ContainsKey(k)) merged[k] = v?.DeepClone();
        return merged;
    }

    /// <summary>Checks one marketplace setting change (reference platform_settings.validate_updates for LIMITS keys).</summary>
    public static JsonNode ValidateSetting(string key, JsonNode? value)
    {
        var choices = RefData.Obj("marketplace_choices");
        if (choices[key] is JsonArray opts)
        {
            if (!J.IsString(value) || !opts.Select(J.S).Contains(J.S(value))) throw new ArgumentException($"{key} must be one of: {string.Join(", ", opts.Select(J.S))}");
            return JsonValue.Create(J.S(value));
        }
        if (RefData.Obj("marketplace_limits")[key] is not JsonArray lim) throw new ArgumentException($"Unknown setting: {key}");
        var (typ, lo, hi) = (J.S(lim[0]), J.Long(lim[1]) ?? 0, J.Long(lim[2]) ?? 0);
        if (typ == "bool")
        {
            if (!J.IsBool(value)) throw new ArgumentException($"{key} must be true or false");
            return JsonValue.Create(value!.GetValue<bool>());
        }
        if (!J.IsInt(value)) throw new ArgumentException($"{key} must be a whole number");
        var n = J.Long(value)!.Value;
        if (n < lo || n > hi) throw new ArgumentException($"{key} must be between {lo} and {hi}");
        return JsonValue.Create(n);
    }

    // ---------------------------------------------------------------- formats

    /// <summary>₹ with Indian digit grouping: 1234567.5 rupees → ₹12,34,567.50 (reference queries.inr).</summary>
    public static string Inr(double paise)
    {
        var value = paise / 100;
        var sign = value < 0 ? "-" : "";
        var s = Math.Abs(value).ToString("0.00", Inv);
        var whole = s[..s.IndexOf('.')];
        var frac = s[(s.IndexOf('.') + 1)..];
        if (whole.Length > 3)
        {
            var head = whole[..^3];
            var tail = whole[^3..];
            var groups = new List<string>();
            while (head.Length > 2)
            {
                groups.Insert(0, head[^2..]);
                head = head[..^2];
            }
            if (head.Length > 0) groups.Insert(0, head);
            whole = string.Join(",", groups) + "," + tail;
        }
        return $"{sign}₹{whole}.{frac}";
    }

    /// <summary>Whole numbers with Indian grouping (1,23,456); other numbers with two decimals.</summary>
    public static string Num(double n) => n == Math.Floor(n) ? Inr(n * 100)[1..^3] : n.ToString("#,##0.00", Inv);

    /// <summary>Shop style: ₹1,234 or ₹1,234.50 (reference shop_assistant.kb.inr).</summary>
    public static string InrShort(long paise)
    {
        var rupees = paise / 100.0;
        return rupees == Math.Floor(rupees) ? "₹" + rupees.ToString("#,##0", Inv) : "₹" + rupees.ToString("#,##0.00", Inv);
    }

    public static string IstText(DateTime? utc) => utc is { } d ? DateTimeFunctions.ToIst(d).ToString("dd MMM yyyy, hh:mm tt", Inv) : "";

    public static string IstDay(DateTime? utc) => utc is { } d ? DateTimeFunctions.ToIst(d).ToString("dd MMM yyyy", Inv) : "";

    public static string? Iso(DateTime? utc) => utc is { } d ? DateTimeFunctions.Iso(d) : null;

    /// <summary>The first of this month at midnight India time, in UTC.</summary>
    public static DateTime MonthStartUtc()
    {
        var now = DateTimeFunctions.ToIst(DateTimeFunctions.UtcNow());
        return DateTimeFunctions.IstToUtc(new DateTime(now.Year, now.Month, 1));
    }

    public static string Pct0(double rate) => (rate * 100).ToString("0", Inv) + "%";

    private static readonly Regex Var = new(@"\{\{\s*(\w+)\s*\}\}");

    public static string Render(string template, IReadOnlyDictionary<string, string> vars) =>
        Var.Replace(template, m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : "");

    // ---------------------------------------------------------------- notifications (outbox)

    /// <summary>
    /// Records a notification for a user on the given channels (in-app is shown at once; email is queued for the sender
    /// job when the user has an email and SMTP is set up). Templates edited in Admin → Messages win over the defaults.
    /// </summary>
    public static async Task NotifyAsync(AiDAL dal, AppSettings env, UserModel? user, string evt, Dictionary<string, string> variables, string link,
        string[] channels, IUnitOfWork? uow = null)
    {
        if (user is null || user.DeletedAt != null) return;
        var site = await SiteAsync(dal, env);
        var business = Business(site);
        var vars = new Dictionary<string, string>
        {
            ["name"] = string.IsNullOrEmpty(user.Name) ? "there" : user.Name, ["brand"] = business.Brand,
            ["link"] = link.StartsWith('/') ? env.PublicWebUrl + link : link,
        };
        foreach (var (k, v) in variables) vars[k] = v;
        var defaults = RefData.Obj("notify_events")[evt] as JsonObject ?? [];
        var now = DateTimeFunctions.UtcNow();
        foreach (var channel in channels)
        {
            string subject, body;
            var tpl = await dal.TemplateAsync(evt, channel);
            if (tpl != null)
            {
                if (!tpl.IsActive) continue;
                (subject, body) = (tpl.Subject, tpl.Body);
            }
            else if (defaults[channel] is JsonArray d)
            {
                (subject, body) = (J.S(d[0]), J.S(d[1]));
            }
            else continue;
            var recipient = "";
            if (channel == "email")
            {
                if (string.IsNullOrEmpty(user.Email) || string.IsNullOrEmpty(env.SmtpHost)) continue;
                recipient = user.Email;
            }
            else if (channel != "inapp") continue; // SMS, WhatsApp and push belong to the notifications module
            var text = Render(body, vars);
            if (channel == "email") text += $"\n\n—\n{business.LegalName}";
            var sub = Render(subject, vars);
            await dal.InsertNotificationAsync(new NotificationModel
            {
                Id = Guid.NewGuid(), UserId = user.Id, Event = evt, Channel = channel, Recipient = recipient, Subject = J.Cut(sub, 200), Body = text,
                Link = J.Cut(link, 300), Variables = J.Dumps(J.O(vars.Select(kv => (kv.Key, (object?)kv.Value)).ToArray())),
                Status = channel == "inapp" ? "sent" : "pending", SentAt = channel == "inapp" ? now : null, CreatedAt = now,
            }, uow);
        }
    }
}
