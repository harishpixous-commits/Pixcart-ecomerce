namespace BAL;

using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

/// <summary>
/// Staff assistant settings, memory notes and conversations (reference: app/assistant/settings.py and the
/// conversation endpoints of routers/assistant.py). The chat engine (ask, tools, actions, uploads) is a later
/// slice; the mode is reported "sandbox" because no LLM route can be configured in this environment.
/// </summary>
public class AssistantBAL(
    AssistantDAL dal,
    SettingsDAL settings,
    AuditDAL audit,
    IAccessBAL access,
    IStepUpBAL stepUp,
    EncryptDecrypt crypto) : IAssistantBAL
{
    public const string SettingsKey = "assistant";
    private const int MaxNotes = 30;

    public static readonly IReadOnlyDictionary<string, string> Langs = new Dictionary<string, string>
    {
        ["en-IN"] = "English (India)", ["ta-IN"] = "தமிழ் Tamil", ["hi-IN"] = "हिन्दी Hindi",
        ["te-IN"] = "తెలుగు Telugu", ["kn-IN"] = "ಕನ್ನಡ Kannada", ["ml-IN"] = "മലയാളം Malayalam",
        ["mr-IN"] = "मराठी Marathi", ["bn-IN"] = "বাংলা Bengali", ["gu-IN"] = "ગુજરાતી Gujarati",
        ["en-US"] = "English (US)", ["en-GB"] = "English (UK)",
    };

    private static JsonObject Defaults() => new()
    {
        ["enabled"] = true,
        ["name"] = "Assistant",
        ["max_steps"] = 8,
        ["max_output_tokens"] = 1500,
        ["history_messages"] = 16,
        ["share_contact_details"] = false,
        ["instructions"] = "",
        ["suggestions"] = new JsonArray(
            "How much did we sell today?",
            "Compare this week with last week by day",
            "What needs my attention right now?",
            "Which products are low on stock?",
            "இன்னைக்கு எத்தனை ஆர்டர் வந்துச்சு?"),
        ["decision"] = new JsonObject
        {
            ["provider"] = "rules",
            ["min_confidence"] = 0.55,
            ["prefetch"] = true,
            ["laya_url"] = "",
            ["laya_path"] = "/predict",
            ["laya_key"] = "",
            ["laya_timeout_ms"] = 600,
        },
        ["voice"] = new JsonObject
        {
            ["enabled"] = true,
            ["languages"] = new JsonArray("en-IN", "ta-IN", "hi-IN"),
            ["default_language"] = "en-IN",
            ["speak_replies"] = true,
            ["rate"] = 1.05,
            ["pitch"] = 1.0,
            ["voice_name"] = "",
            ["auto_listen"] = true,
        },
    };

    // ---------------------------------------------------------------- tolerant JSON readers (request bodies arrive JsonElement-backed)

    private static string Clean(string? v, int limit)
    {
        var s = Regex.Replace(v ?? "", @"[\x00-\x08\x0b-\x1f\x7f]", "");
        return s[..Math.Min(limit, s.Length)].Trim();
    }

    private static bool Bool(JsonNode? n, string field) =>
        n is JsonValue v && v.TryGetValue<bool>(out var b) ? b
            : throw new AppException("Switches must be on or off", "invalid_assistant_settings");

    private static bool BoolOr(JsonNode? n, bool fallback) =>
        n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;

    private static long Whole(JsonNode? n, string field)
    {
        if (n is JsonValue v)
        {
            if (v.TryGetValue<long>(out var l)) return l;
            if (v.TryGetValue<int>(out var i)) return i;
        }
        throw new AppException($"{field} is not valid", "invalid_assistant_settings");
    }

    private static double Num(JsonNode? n, string field)
    {
        if (n is JsonValue v && v.TryGetValue<double>(out var d)) return d;
        if (double.TryParse(n?.ToJsonString(), out var p)) return p;
        throw new AppException($"{field} is not valid", "invalid_assistant_settings");
    }

    // ---------------------------------------------------------------- merge + validate (reference: settings._merge, validate)

    private static JsonObject Merge(JsonObject? saved)
    {
        var o = Defaults();
        if (saved is null) return o;
        foreach (var (k, v) in saved)
        {
            if (k is "decision" or "voice" && v is JsonObject sub && o[k] is JsonObject baseSub)
            {
                foreach (var (kk, vv) in sub)
                    if (baseSub.ContainsKey(kk))
                        baseSub[kk] = vv?.DeepClone();
            }
            else if (o.ContainsKey(k))
            {
                o[k] = v?.DeepClone();
            }
        }
        return o;
    }

    private static readonly Regex LayaUrl = new(@"^https://([A-Za-z0-9.\-]+)(:\d{1,5})?(/[\w./-]*)?$", RegexOptions.Compiled);

    /// <summary>Reference: settings._public_host — public internet names/addresses only.</summary>
    private static bool PublicHost(string host)
    {
        host = host.ToLowerInvariant().TrimEnd('.');
        var last = host.Split('.').Last();
        if (last.All(char.IsDigit))
        {
            if (!System.Net.IPAddress.TryParse(host, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
                return false;
            var b = ip.GetAddressBytes();
            // Reject loopback, private, link-local, multicast, CGNAT, benchmarking, documentation and reserved ranges.
            if (b[0] is 0 or 10 or 127 || b[0] >= 224) return false;
            if (b[0] == 169 && b[1] == 254) return false;
            if (b[0] == 172 && b[1] is >= 16 and <= 31) return false;
            if (b[0] == 192 && b[1] == 168) return false;
            if (b[0] == 100 && b[1] is >= 64 and <= 127) return false;
            if (b[0] == 198 && b[1] is 18 or 19) return false;
            if (b[0] == 192 && b[1] == 0 && b[2] == 2) return false;
            if (b[0] == 198 && b[1] == 51 && b[2] == 100) return false;
            if (b[0] == 203 && b[1] == 0 && b[2] == 113) return false;
            return true;
        }
        return host.Contains('.') && !host.EndsWith(".internal") && !host.EndsWith(".local") && !host.EndsWith(".localhost");
    }

    private static string LayaUrlOrThrow(string value)
    {
        var url = Clean(value, 300).TrimEnd('/');
        var m = LayaUrl.Match(url);
        if (url.Length > 0 && !m.Success)
            throw new AppException("Laya address must start with https://, like https://laya.example.com", "invalid_assistant_settings");
        if (m.Success && !PublicHost(m.Groups[1].Value))
            throw new AppException("Laya address must be a public https address, not a private, local or cloud metadata one", "invalid_assistant_settings");
        return url;
    }

    public static bool LayaAllowed(string url)
    {
        try { LayaUrlOrThrow(url); return url.Length > 0; }
        catch (AppException) { return false; }
    }

    private static bool LayaChanged(JsonObject before, JsonObject after) =>
        (before["laya_url"]?.GetValue<string>() ?? "") != (after["laya_url"]?.GetValue<string>() ?? "") ||
        (before["laya_path"]?.GetValue<string>() ?? "") != (after["laya_path"]?.GetValue<string>() ?? "") ||
        (before["laya_key"]?.GetValue<string>() ?? "") != (after["laya_key"]?.GetValue<string>() ?? "");

    /// <summary>Reference: settings.validate. current is the stored decision settings (key still encrypted).</summary>
    private JsonObject Validate(JsonObject data, JsonObject current)
    {
        var cfg = Merge(data);
        if (cfg["enabled"] is not JsonValue en || !en.TryGetValue<bool>(out var enabled) ||
            cfg["share_contact_details"] is not JsonValue sc || !sc.TryGetValue<bool>(out var share))
            throw new AppException("Switches must be on or off", "invalid_assistant_settings");
        cfg["enabled"] = enabled;
        cfg["share_contact_details"] = share;
        foreach (var (k, lo, hi) in new[] { ("max_steps", 1, 15), ("max_output_tokens", 256, 8000), ("history_messages", 4, 60) })
        {
            var v = Whole(cfg[k], k.Replace('_', ' '));
            if (v < lo || v > hi)
                throw new AppException($"{k.Replace('_', ' ')} must be a whole number from {lo} to {hi}", "invalid_assistant_settings");
            cfg[k] = v;
        }
        cfg["name"] = Clean(cfg["name"]?.GetValue<string>(), 40) is { Length: > 0 } n ? n : "Assistant";
        cfg["instructions"] = Clean(cfg["instructions"]?.GetValue<string>(), 2000);
        var suggestions = new JsonArray();
        if (cfg["suggestions"] is JsonArray sg)
            foreach (var s in sg)
            {
                var t = Clean(s?.GetValue<string>(), 120);
                if (t.Length > 0 && suggestions.Count < 8) suggestions.Add(t);
            }
        cfg["suggestions"] = suggestions;

        var d = cfg["decision"] as JsonObject ?? new JsonObject();
        var provider = d["provider"]?.GetValue<string>() ?? "";
        if (provider is not ("off" or "rules" or "laya"))
            throw new AppException("Decision layer is off, rules or laya", "invalid_assistant_settings");
        var minConf = Num(d["min_confidence"], "Confidence");
        var timeout = Whole(d["laya_timeout_ms"], "Laya timeout");
        if (minConf is < 0 or > 1 || timeout is < 100 or > 5000)
            throw new AppException("Confidence is 0–1 and the Laya timeout 100–5000 ms", "invalid_assistant_settings");
        d["min_confidence"] = minConf;
        d["laya_timeout_ms"] = timeout;
        d["prefetch"] = BoolOr(d["prefetch"], true);
        var url = Clean(d["laya_url"]?.GetValue<string>(), 300).TrimEnd('/');
        // An unchanged address saved before the public https rule does not block saving other settings; it is not used.
        d["laya_url"] = url.Length > 0 && url == (current["laya_url"]?.GetValue<string>() ?? "") ? url : LayaUrlOrThrow(url);
        var path = Clean(d["laya_path"]?.GetValue<string>(), 60) is { Length: > 0 } p ? p : "/predict";
        if (!path.StartsWith('/'))
            throw new AppException("Laya path must start with /", "invalid_assistant_settings");
        d["laya_path"] = path;
        if (provider == "laya" && (d["laya_url"]?.GetValue<string>() ?? "").Length == 0)
            throw new AppException("Enter the Laya server address, or choose the built-in rules", "invalid_assistant_settings");
        var newKey = Clean(d["laya_key"]?.GetValue<string>(), 300);
        d.Remove("laya_key");
        d.Remove("laya_key_set");
        // The saved token only ever goes to the server it was entered for: a new address or path drops it.
        var moved = (d["laya_url"]?.GetValue<string>() ?? "", d["laya_path"]?.GetValue<string>() ?? "/predict")
            != (current["laya_url"]?.GetValue<string>() ?? "", current["laya_path"]?.GetValue<string>() ?? "/predict");
        var asked = data["decision"] as JsonObject;
        var drop = moved || BoolOr(asked?["clear_laya_key"], false);
        d["laya_key"] = newKey.Length > 0 ? crypto.Encrypt(newKey) : (drop ? "" : current["laya_key"]?.GetValue<string>() ?? "");
        cfg["decision"] = d;

        var voice = cfg["voice"] as JsonObject ?? new JsonObject();
        var langs = new JsonArray();
        if (voice["languages"] is JsonArray vl)
            foreach (var l in vl)
                if (l?.GetValue<string>() is { } code && Langs.ContainsKey(code) && langs.Count < 8)
                    langs.Add(code);
        if (langs.Count == 0) langs.Add("en-IN");
        voice["languages"] = langs;
        var defLang = voice["default_language"]?.GetValue<string>() ?? "";
        voice["default_language"] = langs.Any(l => l!.GetValue<string>() == defLang) ? defLang : langs[0]!.GetValue<string>();
        foreach (var (k, lo, hi) in new[] { ("rate", 0.5, 2.0), ("pitch", 0.5, 2.0) })
        {
            var v = Num(voice[k], $"Voice {k}");
            if (v < lo || v > hi)
                throw new AppException($"Voice {k} must be between {lo:0.0##} and {hi:0.0##}", "invalid_assistant_settings");
            voice[k] = v;
        }
        voice["enabled"] = BoolOr(voice["enabled"], true);
        voice["speak_replies"] = BoolOr(voice["speak_replies"], true);
        voice["auto_listen"] = BoolOr(voice["auto_listen"], true);
        voice["voice_name"] = Clean(voice["voice_name"]?.GetValue<string>(), 120);
        cfg["voice"] = voice;
        return cfg;
    }

    // ---------------------------------------------------------------- stored / get (reference: settings.stored, get)

    private async Task<JsonObject> StoredAsync() => Merge(await settings.GetAsync(SettingsKey));

    private async Task<JsonObject> GetAsync()
    {
        var cfg = await StoredAsync();
        var d = cfg["decision"] as JsonObject ?? new JsonObject();
        var enc = d["laya_key"]?.GetValue<string>() ?? "";
        d["laya_key_set"] = enc.Length > 0;
        d["laya_key"] = "";
        var url = d["laya_url"]?.GetValue<string>() ?? "";
        d["laya_url_blocked"] = url.Length > 0 && !LayaAllowed(url); // saved before the public https rule
        return cfg;
    }

    public async Task<JsonObject> SettingsPayloadAsync() => new()
    {
        ["settings"] = await GetAsync(),
        ["languages"] = new JsonObject(Langs.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value))),
        ["tools"] = new JsonArray(AssistantTools.All.Select(t => (JsonNode)new JsonObject
        {
            ["name"] = t.Name, ["label"] = t.Label,
            ["description"] = t.Description.Split(". ")[0],
            ["permissions"] = new JsonArray(t.AnyOf.Select(p => (JsonNode)JsonValue.Create(p)!).ToArray()),
        }).ToArray()),
        ["actions"] = new JsonArray(AssistantActionDefs.All.Select(a => (JsonNode)new JsonObject
        {
            ["kind"] = a.Kind, ["label"] = a.Label, ["permission"] = a.Permission,
        }).ToArray()),
    };

    public async Task<JsonObject> SaveSettingsAsync(UserModel actor, JsonObject body)
    {
        var data = (JsonObject)(body.DeepClone() ?? new JsonObject());
        var password = data["password"]?.GetValue<string>() ?? "";
        var totp = data["totp"]?.GetValue<string>() ?? "";
        data.Remove("password");
        data.Remove("totp");
        var before = (await StoredAsync())["decision"] as JsonObject ?? new JsonObject();
        var cfg = Validate(data, before);
        var laya = LayaChanged(before, cfg["decision"] as JsonObject ?? new JsonObject());
        if (laya)
        {
            // Every staff question (and the token) goes to the Laya server: the same bar as connecting an AI provider.
            if (!(await access.PermissionsForAsync(actor)).Contains("ai_providers"))
                throw new ForbiddenException("Changing the Laya server or its token needs the AI providers permission");
            await stepUp.ConfirmIdentityAsync(actor, password, totp, "assistant-laya");
        }
        await settings.SaveAsync(SettingsKey, cfg);
        var decision = cfg["decision"] as JsonObject ?? new JsonObject();
        var voice = cfg["voice"] as JsonObject ?? new JsonObject();
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = actor.Id, Action = "assistant.settings", EntityType = "settings",
            EntityId = "assistant",
            Detail = $"decision={decision["provider"]?.GetValue<string>()} voice={voice["enabled"]?.GetValue<bool>()}" +
                     (laya ? " laya_server=changed" : ""),
            CreatedAt = DateTimeFunctions.UtcNow(),
        });
        return await SettingsPayloadAsync();
    }

    // ---------------------------------------------------------------- status (reference: routers/assistant.py status)

    public async Task<JsonObject> StatusAsync(UserModel user)
    {
        var cfg = await GetAsync();
        var perms = await access.PermissionsForAsync(user);
        var voice = cfg["voice"] as JsonObject ?? new JsonObject();
        var langs = (voice["languages"] as JsonArray ?? new JsonArray()).Select(l => l!.GetValue<string>()).ToArray();
        // The LLM route chain is always empty here (no provider connections can be configured), so the mode is
        // honestly "sandbox"; the reference computes "live" when a chain exists.
        var voiceOut = (JsonObject)voice.DeepClone();
        voiceOut["languages"] = new JsonArray(langs.Select(c => (JsonNode)new JsonObject { ["code"] = c, ["label"] = Langs.GetValueOrDefault(c, c) }).ToArray());
        return new JsonObject
        {
            ["enabled"] = cfg["enabled"]?.GetValue<bool>(),
            ["name"] = cfg["name"]?.GetValue<string>(),
            ["suggestions"] = cfg["suggestions"]?.DeepClone(),
            ["mode"] = "sandbox",
            ["model"] = "",
            ["fallbacks"] = 0,
            ["decision"] = (cfg["decision"] as JsonObject)?["provider"]?.GetValue<string>(),
            ["voice"] = voiceOut,
            ["can"] = new JsonObject
            {
                ["chat"] = true,
                ["actions"] = perms.Contains("assistant_actions"),
                ["files"] = perms.Contains("assistant_files"),
                ["voice"] = perms.Contains("assistant_voice") && voice["enabled"]?.GetValue<bool>() == true,
                ["settings"] = perms.Contains("settings"),
                ["providers"] = perms.Contains("ai_providers"),
            },
            ["tools"] = new JsonArray(AssistantTools.Available(perms).Select(t => (JsonNode)JsonValue.Create(t.Name)!).ToArray()),
            ["upload"] = new JsonObject
            {
                ["max_mb"] = 5, // reference: uploads.MAX_BYTES = 5 * 1024 * 1024
                ["types"] = new JsonArray(".csv", ".tsv", ".xlsx", ".txt", ".md", ".json"),
            },
        };
    }

    /// <summary>Reference: routers/assistant.py decision_test — runs the decision layer over every tool name.</summary>
    public async Task<JsonObject> DecisionTestAsync(string text)
    {
        var cfg = (await StoredAsync())["decision"] as JsonObject ?? new JsonObject();
        return AssistantDecision.Decide(text, cfg, AssistantTools.ByName.Keys.ToHashSet(), false).AsDict();
    }

    // ---------------------------------------------------------------- memory notes (reference: settings.memories, set_memories)

    private static string MemKey(Guid userId) => $"asst_mem:{userId}";

    public async Task<JsonObject> GetMemoryAsync(UserModel user)
    {
        var row = await settings.GetAsync(MemKey(user.Id));
        return new JsonObject { ["notes"] = row["notes"]?.DeepClone() ?? new JsonArray() };
    }

    public async Task<JsonObject> PutMemoryAsync(UserModel user, JsonArray notes)
    {
        var cleaned = notes.Select(n => Clean(n?.GetValue<string>(), 300)).Where(n => n.Length > 0).TakeLast(MaxNotes).ToArray();
        await settings.SaveAsync(MemKey(user.Id), new JsonObject { ["notes"] = new JsonArray(cleaned.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray()) });
        return new JsonObject { ["notes"] = new JsonArray(cleaned.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray()) };
    }

    // ---------------------------------------------------------------- conversations (reference: routers/assistant.py)

    private static JsonObject ConvOut(AssistantConversationModel c, int? count = null)
    {
        var o = new JsonObject
        {
            ["id"] = c.Id.ToString(), ["title"] = c.Title,
            ["updated_at"] = c.UpdatedAt.ToString("o"), ["created_at"] = c.CreatedAt.ToString("o"),
            ["archived"] = c.IsArchived,
            ["context"] = JsonNode.Parse(c.Context)?.DeepClone() ?? new JsonObject(),
        };
        if (count is not null) o["messages"] = count.Value;
        return o;
    }

    private async Task<AssistantConversationModel> OwnAsync(UserModel user, Guid convId)
    {
        var c = await dal.ConversationAsync(convId);
        if (c is null || c.UserId != user.Id)
            throw new NotFoundException("Conversation");
        return c;
    }

    public async Task<JsonObject> ListConversationsAsync(UserModel user, bool archived, string q)
    {
        var rows = await dal.ConversationsAsync(user.Id, archived, q.Trim()[..Math.Min(60, q.Trim().Length)]);
        return new JsonObject { ["items"] = new JsonArray(rows.Select(c => (JsonNode)ConvOut(c)).ToArray()) };
    }

    public async Task<JsonObject> CreateConversationAsync(UserModel user, string title, JsonObject? context)
    {
        var now = DateTimeFunctions.UtcNow();
        var ctx = new JsonObject();
        if (context is not null)
            foreach (var (k, v) in context)
                if (k is "path" or "title" or "filters")
                {
                    var raw = v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : v?.ToJsonString() ?? "";
                    ctx[k] = Clean(raw, 300);
                }
        var c = new AssistantConversationModel
        {
            Id = Guid.NewGuid(), UserId = user.Id,
            Title = title.Trim() is { Length: > 0 } t ? t : "New chat",
            Context = ctx.ToJsonString(), IsArchived = false, CreatedAt = now, UpdatedAt = now,
        };
        await dal.InsertConversationAsync(c);
        return ConvOut(c, 0);
    }

    public async Task<JsonObject> PatchConversationAsync(UserModel user, Guid convId, string? title, bool? archived)
    {
        var c = await OwnAsync(user, convId);
        var now = DateTimeFunctions.UtcNow();
        await dal.PatchConversationAsync(c.Id, title?.Trim(), archived, now);
        c.Title = title?.Trim() ?? c.Title;
        c.IsArchived = archived ?? c.IsArchived;
        c.UpdatedAt = now;
        return ConvOut(c);
    }

    public async Task<JsonObject> DeleteConversationAsync(UserModel user, Guid convId)
    {
        var c = await OwnAsync(user, convId);
        await dal.DeleteConversationAsync(c.Id);
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> GetConversationAsync(UserModel user, Guid convId)
    {
        var c = await OwnAsync(user, convId);
        var msgs = await dal.MessagesAsync(c.Id);
        var acts = await dal.ActionStatusesAsync(c.Id);
        var outMsgs = msgs.Select(m =>
        {
            var d = new JsonObject
            {
                ["id"] = m.Id.ToString(), ["role"] = m.Role, ["text"] = m.Text,
                ["blocks"] = JsonNode.Parse(m.Blocks)?.DeepClone() ?? new JsonArray(),
                ["status"] = m.Status, ["mode"] = m.Mode, ["created_at"] = m.CreatedAt.ToString("o"),
            };
            if (d["blocks"] is JsonArray blocks)
                foreach (var b in blocks.OfType<JsonObject>())
                    if (b["type"]?.GetValue<string>() == "action" &&
                        Guid.TryParse(b["action_id"]?.GetValue<string>(), out var aid) && acts.TryGetValue(aid, out var st))
                        b["status"] = st;
            return (JsonNode)d;
        }).ToArray();
        var o = ConvOut(c);
        o["messages"] = new JsonArray(outMsgs);
        return o;
    }
}
