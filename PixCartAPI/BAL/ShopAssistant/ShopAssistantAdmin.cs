using BAL.Interface;
using BAL.ShopAssistant;
using DAL;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Admin side of the shop assistant: switches and settings, the help knowledge base, customer chats and
/// statistics (reference: routers/admin_shop_assistant.py). Permissions: shop_assistant (settings),
/// shop_assistant_kb (articles), shop_assistant_chats (customer chats and stats).
/// </summary>
public partial class ShopAssistantBAL
{
    internal static readonly (string Code, string Label)[] TopicLabels =
    [
        ("orders", "Orders"), ("delivery", "Delivery"), ("payments", "Payments"), ("returns", "Returns and refunds"),
        ("account", "Account"), ("offers", "Offers"), ("selling", "Selling"), ("other", "Other"),
    ];

    internal static readonly string[] KbTopics = [.. TopicLabels.Select(t => t.Code)];

    private static readonly (string Key, string Label, string Help)[] FeatureLabels =
    [
        ("product_search", "Find products", "Search the catalogue and answer questions about a product."),
        ("orders", "Order status and tracking", "Show the customer's orders, package progress, courier and delivery dates."),
        ("cancel_orders", "Cancel orders from chat", "Prepare a cancellation; the customer presses Confirm."),
        ("returns_refunds", "Returns and refunds", "Return eligibility and dates, return and refund status."),
        ("tickets", "Support requests", "Fill in a support request the customer sends, and show request status."),
        ("help_articles", "Help articles", "Answer policy and how-to questions from the help articles."),
    ];

    internal static readonly string[] KbPlaceholders =
    [
        "{brand}", "{shipping_fee}", "{free_delivery_amount}", "{transit_same_city}", "{transit_same_state}",
        "{transit_national}", "{cod_text}", "{grievance_text}",
    ];

    [GeneratedRegex(@"^(/(?!/)[A-Za-z0-9\-_/?=&.%#]*)?$")]
    private static partial Regex SafeLinkRegex();

    [GeneratedRegex(@"^[a-z]{2}(-[A-Za-z]{2})?$")]
    private static partial Regex LangRegex();

    // ------------------------------------------------------------------ settings and switches

    public async Task<JsonObject> AdminGetSettingsAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "shop_assistant");
        var cfg = await GetSettingsAsync();
        return new JsonObject
        {
            ["settings"] = cfg.DeepClone(),
            ["features"] = new JsonArray(FeatureLabels.Select(f =>
                (JsonNode)new JsonObject { ["key"] = f.Key, ["label"] = f.Label, ["help"] = f.Help }).ToArray()),
            ["status"] = await AdminStatusAsync(cfg),
        };
    }

    public async Task<JsonObject> AdminPutSettingsAsync(UserModel admin, JsonObject body)
    {
        await access.RequireAsync(admin, "shop_assistant");
        JsonObject cfg;
        await using var uow = await db.BeginAsync();
        var before = SettingsDAL.Merge(Defaults(), await settings.GetForUpdateAsync(SettingsKey, uow.Transaction));
        cfg = ValidateSettings(body, before);
        await settings.SaveAsync(SettingsKey, cfg, uow.Transaction);
        await uow.CommitAsync();
        var changed = string.Join(", ", cfg.AsObject()
            .Where(kv => !JsonNode.DeepEquals(kv.Value, before[kv.Key])).Select(kv => kv.Key).OrderBy(k => k));
        await audit.AuditAsync(admin, "shop_assistant.settings", "settings", SettingsKey, changed.Length > 0 ? changed : "no change");
        return new JsonObject
        {
            ["settings"] = cfg.DeepClone(),
            ["features"] = new JsonArray(FeatureLabels.Select(f =>
                (JsonNode)new JsonObject { ["key"] = f.Key, ["label"] = f.Label, ["help"] = f.Help }).ToArray()),
            ["status"] = await AdminStatusAsync(cfg),
        };
    }

    /// <summary>Reference: _status. Live mode is not connected, so the mode is always guided and no models run.</summary>
    private async Task<JsonObject> AdminStatusAsync(JsonObject cfg)
    {
        var ist = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");
        var nowIst = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, ist);
        var monthStart = new DateTime(nowIst.Year, nowIst.Month, 1);
        var used = await dal.TokensThisMonthAsync("shop_assistant", monthStart);
        return new JsonObject
        {
            ["mode"] = "guided", ["models"] = new JsonArray(), ["own_route"] = false, ["tokens_this_month"] = used,
        };
    }

    /// <summary>Reference: settings.validate + update. Field-by-field port, same error texts.</summary>
    internal static JsonObject ValidateSettings(JsonObject data, JsonObject current)
    {
        static string Text(JsonNode? v, int limit)
        {
            var t = Regex.Replace(v?.ToString() ?? "", @"[\x00-\x08\x0b-\x1f\x7f]", "").Trim();
            return t.Length > limit ? t[..limit] : t;
        }
        static int Int(JsonNode? v, int lo, int hi, string name)
        {
            long n;
            try
            {
                n = v switch
                {
                    JsonValue jv when jv.TryGetValue<long>(out var l) => l,
                    JsonValue jv when jv.TryGetValue<double>(out var dd) => (long)dd,
                    JsonValue jv when jv.TryGetValue<string>(out var st) => long.Parse(st),
                    _ => long.Parse(v?.ToString() ?? ""),
                };
            }
            catch { throw new AppException($"{name} must be a whole number", "invalid_settings", 400); }
            if (n < lo || n > hi) throw new AppException($"{name} must be between {lo} and {hi}", "invalid_settings", 400);
            return (int)n;
        }

        var merged = SettingsDAL.Merge(current, data);
        var d = Defaults();
        var result = new JsonObject();
        result["enabled"] = merged.Bool("enabled");
        result["allow_guests"] = merged.Bool("allow_guests");
        result["name"] = Text(merged["name"], 40) is { Length: > 0 } n ? n : d["name"]!.GetValue<string>();
        result["greeting"] = Text(merged["greeting"], 400) is { Length: > 0 } g ? g : d["greeting"]!.GetValue<string>();
        result["instructions"] = Text(merged["instructions"], 3000);
        var ai = merged.Str("ai");
        if (ai is not ("auto" or "guided")) throw new AppException("Choose how the assistant answers", "invalid_settings", 400);
        result["ai"] = ai;
        var feats = new JsonObject();
        foreach (var key in d["features"]!.AsObject().Select(kv => kv.Key))
            feats[key] = merged["features"] is JsonObject fo && fo.TryGetPropertyValue(key, out var fv) && fv is not null
                ? fv.GetValueKind() != System.Text.Json.JsonValueKind.False
                : true;
        result["features"] = feats;
        var qr = (merged["quick_replies"] as JsonArray ?? []).Select(q => Text(q, 40)).Where(q => q.Length > 0).Take(8).ToList();
        result["quick_replies"] = new JsonArray(qr.Select(q => (JsonNode)q).ToArray());
        result["max_steps"] = Int(merged["max_steps"], 1, 8, "Tool rounds");
        result["max_output_tokens"] = Int(merged["max_output_tokens"], 200, 2000, "Longest answer");
        result["history_messages"] = Int(merged["history_messages"], 2, 40, "Messages remembered");
        result["monthly_token_budget"] = Int(merged["monthly_token_budget"], 0, 1_000_000_000, "Monthly token budget");
        var lim = merged["limits"] as JsonObject ?? [];
        result["limits"] = new JsonObject
        {
            ["per_minute"] = Int(lim["per_minute"], 1, 60, "Messages per minute"),
            ["per_day_customer"] = Int(lim["per_day_customer"], 5, 2000, "Messages per day (customer)"),
            ["per_day_guest"] = Int(lim["per_day_guest"], 0, 500, "Messages per day (guest)"),
        };
        var v = merged["voice"] as JsonObject ?? [];
        var langs = new JsonArray();
        foreach (var item in v["languages"] as JsonArray ?? [])
        {
            if (item is not JsonObject io) continue;
            var code = io["code"]?.ToString().Trim() ?? "";
            var label = Text(io["label"], 30);
            if (LangRegex().IsMatch(code) && label.Length > 0)
                langs.Add(new JsonObject { ["code"] = code, ["label"] = label });
        }
        if (langs.Count == 0) throw new AppException("Keep at least one voice language", "invalid_settings", 400);
        var def = v["default_language"]?.ToString();
        if (def is null || !langs.Any(l => l!["code"]!.GetValue<string>() == def)) def = langs[0]!["code"]!.GetValue<string>();
        double rate, pitch;
        try { rate = v["rate"] is null ? 1 : v["rate"]!.GetValue<double>(); pitch = v["pitch"] is null ? 1 : v["pitch"]!.GetValue<double>(); }
        catch { throw new AppException("Voice speed and pitch must be numbers", "invalid_settings", 400); }
        result["voice"] = new JsonObject
        {
            ["enabled"] = v.Bool("enabled"),
            ["languages"] = new JsonArray(langs.Take(10).Select(l => (JsonNode)l!.DeepClone()).ToArray()),
            ["default_language"] = def,
            ["speak_replies"] = v.Bool("speak_replies"),
            ["rate"] = Math.Min(Math.Max(rate, 0.5), 2.0),
            ["pitch"] = Math.Min(Math.Max(pitch, 0.5), 2.0),
            ["auto_listen"] = v["auto_listen"] is null || v.Bool("auto_listen"),
        };
        return result;
    }

    // ------------------------------------------------------------------ help articles (knowledge base)

    internal static JsonObject ArticleOut(ShopKbArticleModel a) => new()
    {
        ["id"] = a.Id.ToString(), ["title"] = a.Title, ["body"] = a.Body,
        ["keywords"] = JsonNode.Parse(a.Keywords ?? "[]")?.DeepClone(),
        ["topic"] = a.Topic, ["topic_label"] = TopicLabels.FirstOrDefault(t => t.Code == a.Topic).Label ?? a.Topic,
        ["link"] = a.Link, ["is_published"] = a.IsPublished, ["position"] = a.Position, ["uses"] = a.Uses,
        ["updated_at"] = a.UpdatedAt == default ? null : a.UpdatedAt.ToString("o"),
    };

    /// <summary>Reference: _apply. Validates and copies the input onto the article; same error codes.</summary>
    private static void ApplyArticle(ShopKbArticleModel a, string title, string body, List<string> keywords, string topic,
        string link, bool isPublished, int position)
    {
        if (!KbTopics.Contains(topic)) throw new AppException("Choose a topic", "invalid_topic", 400);
        var cleanLink = link.Trim();
        if (!SafeLinkRegex().IsMatch(cleanLink)) throw new AppException("The link must be a page on this site, starting with /", "invalid_link", 400);
        a.Title = string.Join(' ', title.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        a.Body = body.Trim();
        a.Keywords = System.Text.Json.JsonSerializer.Serialize(
            keywords.Select(k => k.Trim()[..Math.Min(60, k.Trim().Length)]).Where(k => k.Length > 0).Distinct().ToList());
        a.Topic = topic; a.Link = cleanLink; a.IsPublished = isPublished; a.Position = position;
    }

    public async Task<JsonObject> AdminListArticlesAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "shop_assistant_kb");
        await EnsureStarterAsync();
        var rows = await dal.AllArticlesAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(rows.Select(a => (JsonNode)ArticleOut(a)).ToArray()),
            ["topics"] = new JsonArray(TopicLabels.Select(t =>
                (JsonNode)new JsonObject { ["code"] = t.Code, ["label"] = t.Label }).ToArray()),
            ["placeholders"] = new JsonArray(KbPlaceholders.Select(p => (JsonNode)p).ToArray()),
        };
    }

    public async Task<JsonObject> AdminCreateArticleAsync(UserModel admin, string title, string body, List<string> keywords,
        string topic, string link, bool isPublished, int position)
    {
        await access.RequireAsync(admin, "shop_assistant_kb");
        var a = new ShopKbArticleModel { Id = Guid.NewGuid(), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
        ApplyArticle(a, title, body, keywords, topic, link, isPublished, position);
        await dal.InsertArticleAsync(a);
        await audit.AuditAsync(admin, "shop_assistant.article_create", "kb_article", a.Id, a.Title);
        return ArticleOut(a);
    }

    public async Task<JsonObject> AdminUpdateArticleAsync(UserModel admin, Guid id, string title, string body, List<string> keywords,
        string topic, string link, bool isPublished, int position)
    {
        await access.RequireAsync(admin, "shop_assistant_kb");
        var a = await dal.GetArticleAsync(id) ?? throw new NotFoundException("Article");
        ApplyArticle(a, title, body, keywords, topic, link, isPublished, position);
        a.UpdatedAt = DateTime.UtcNow;
        await dal.UpdateArticleAsync(a);
        await audit.AuditAsync(admin, "shop_assistant.article_update", "kb_article", a.Id, a.Title);
        return ArticleOut(a);
    }

    public async Task<JsonObject> AdminDeleteArticleAsync(UserModel admin, Guid id)
    {
        await access.RequireAsync(admin, "shop_assistant_kb");
        var a = await dal.GetArticleAsync(id) ?? throw new NotFoundException("Article");
        await audit.AuditAsync(admin, "shop_assistant.article_delete", "kb_article", a.Id, a.Title);
        await dal.DeleteArticleAsync(id);
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> AdminTryQuestionAsync(UserModel admin, string question)
    {
        await access.RequireAsync(admin, "shop_assistant_kb");
        var hits = ShopKb.Search(question, [.. await dal.PublishedArticlesAsync()], [.. await dal.PublishedPagesAsync()], await FactsAsync(), 5, 0.5);
        return new JsonObject
        {
            ["items"] = new JsonArray(hits.Select(h => (JsonNode)new JsonObject
            {
                ["id"] = h.Id, ["title"] = h.Title, ["source"] = h.Source, ["score"] = Math.Round(h.Score, 1),
                ["link"] = h.Link, ["answers"] = h.Score >= 1.5,
            }).ToArray()),
        };
    }

    // ------------------------------------------------------------------ customer chats and stats

    private static string MaskPhone(string? phone) => phone is { Length: >= 4 } p ? "••••••" + p[^4..] : "";

    public async Task<JsonObject> AdminListChatsAsync(UserModel admin, int page, int? feedback, bool escalated, string q)
    {
        await access.RequireAsync(admin, "shop_assistant_chats");
        var (rows, total) = await dal.AdminChatsAsync(feedback, escalated, q.Trim(), (page - 1) * 25);
        return new JsonObject
        {
            ["total"] = total, ["page"] = page,
            ["items"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject
            {
                ["id"] = r.Id.ToString(), ["title"] = r.Title,
                ["customer"] = r.UserId is null ? "Guest" : (r.CustomerName is { Length: > 0 } n ? n : "Customer"),
                ["phone"] = r.UserId is null ? "" : MaskPhone(r.CustomerPhone),
                ["messages"] = r.Messages, ["feedback"] = r.Feedback, ["language"] = r.Language,
                ["ticket"] = r.TicketNumber ?? "",
                ["page"] = JsonNode.Parse(r.Page)?["path"]?.GetValue<string>() ?? "",
                ["updated_at"] = r.UpdatedAt.ToString("o"),
            }).ToArray()),
        };
    }

    public async Task<JsonObject> AdminGetChatAsync(UserModel admin, Guid chatId)
    {
        await access.RequireAsync(admin, "shop_assistant_chats");
        var c = await dal.AdminChatDetailAsync(chatId) ?? throw new NotFoundException("Chat");
        var msgs = await dal.MessagesAsync(chatId, 500);
        await audit.AuditAsync(admin, "shop_assistant.chat_view", "shop_chat", c.Id);
        return new JsonObject
        {
            ["id"] = c.Id.ToString(), ["title"] = c.Title,
            ["customer"] = c.UserId is null ? "Guest" : (c.CustomerName is { Length: > 0 } n ? n : "Customer"),
            ["phone"] = c.UserId is null ? "" : MaskPhone(c.CustomerPhone),
            ["customer_id"] = c.UserId?.ToString(), ["feedback"] = c.Feedback, ["language"] = c.Language,
            ["page"] = JsonNode.Parse(c.Page)?.DeepClone(),
            ["ticket"] = c.TicketId is null ? null : new JsonObject
            {
                ["id"] = c.TicketId.ToString(), ["number"] = c.TicketNumber, ["status"] = c.TicketStatus,
            },
            ["messages"] = new JsonArray(msgs.Select(m =>
            {
                var o = MessageOut(m);
                o["intent"] = m.Intent; o["voice"] = m.Voice;
                return (JsonNode)o;
            }).ToArray()),
        };
    }

    public async Task<JsonObject> AdminStatsAsync(UserModel admin, int days)
    {
        await access.RequireAsync(admin, "shop_assistant_chats");
        var r = await dal.AdminStatsAsync(DateTime.UtcNow.AddDays(-days));
        return new JsonObject
        {
            ["days"] = days, ["chats"] = r.Chats, ["customer_chats"] = r.CustomerChats,
            ["guest_chats"] = r.Chats - r.CustomerChats, ["escalated"] = r.Escalated,
            ["messages"] = r.Messages, ["voice_messages"] = r.VoiceMessages, ["cancellations"] = r.Cancellations,
            ["helpful"] = r.Helpful, ["not_helpful"] = r.NotHelpful,
            ["intents"] = new JsonArray(r.Intents.Select(i =>
                (JsonNode)new JsonObject { ["intent"] = i.Label.Length > 0 ? i.Label : "unknown", ["count"] = i.N }).ToArray()),
            ["ai_answers"] = r.Modes.Where(m => m.Label == "live").Sum(m => m.N),
            ["guided_answers"] = r.Modes.Where(m => m.Label == "guided").Sum(m => m.N),
            ["top_articles"] = new JsonArray(r.TopArticles.Select(t =>
                (JsonNode)new JsonObject { ["title"] = t.Label, ["uses"] = t.N }).ToArray()),
        };
    }
}
