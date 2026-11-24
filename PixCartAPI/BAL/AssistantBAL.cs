using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.AI;
using BAL.Assistant;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Model.DomainModel.AI;
using Utils;

namespace BAL;

/// <summary>
/// The admin AI assistant. One question → events streamed to the browser: start → decision → [status | tool | card | text]*
/// → done (or error). 1) Save the person's message; load memory notes, attached files and recent history (older turns
/// condensed). 2) Decision layer: areas, period, tools to offer and an optional prefetch. 3) Model turns on the
/// "assistant" route's fallback chain (any provider), streaming text; tool calls run with the person's permissions and
/// their cards stream immediately; up to max_steps rounds. 4) Save the reply and record tokens in the AI usage log.
/// Without a connected model the sandbox answers common questions with the same real tools.
/// </summary>
public class AssistantBAL(AssistantDAL dal, AiDAL ai, AnthropicKeyDAL anthropic, IAiBAL aiBal, ILlmConfigBAL llmConfig, ILlmRouterBAL router, IAccessBAL access,
    EncryptDecrypt crypto, AppSettings env, ILogger<AssistantBAL> log) : IAssistantBAL
{
    private AssistantQueries Q => new(dal, ai);
    private AssistantActions Actions => new(dal, ai, Q, access, env);

    private async Task<HashSet<string>> PermsAsync(UserModel user)
    {
        access.Invalidate();
        return await access.PermissionsForAsync(user);
    }

    // ---------------------------------------------------------------- status and settings

    public async Task<JsonObject> StatusAsync(UserModel user)
    {
        var cfg = await AssistantSettings.GetAsync(ai, crypto);
        var perms = await PermsAsync(user);
        var chain = await llmConfig.TargetsAsync("assistant");
        var voice = (JsonObject)cfg["voice"]!.DeepClone();
        var langs = AssistantSettings.Langs;
        voice["languages"] = J.A((cfg["voice"]!["languages"] as JsonArray ?? []).Select(c => (object?)J.O(("code", J.S(c)), ("label", J.S(langs[J.S(c)])))));
        return J.O(("enabled", cfg["enabled"]?.DeepClone()), ("name", cfg["name"]?.DeepClone()), ("suggestions", cfg["suggestions"]?.DeepClone()),
            ("mode", chain.Count > 0 ? "live" : "sandbox"), ("model", chain.Count > 0 ? $"{chain[0].Model} via {chain[0].Connection.Name}" : ""),
            ("fallbacks", Math.Max(0, chain.Count - 1)), ("decision", cfg["decision"]!["provider"]?.DeepClone()), ("voice", voice),
            ("can", J.O(("chat", true), ("actions", perms.Contains("assistant_actions")), ("files", perms.Contains("assistant_files")),
                ("voice", perms.Contains("assistant_voice") && J.Truthy(cfg["voice"]!["enabled"])), ("settings", perms.Contains("settings")), ("providers", perms.Contains("ai_providers")))),
            ("tools", J.Strings(AssistantTools.Available(perms).Select(t => t.Name))),
            ("upload", J.O(("max_mb", Uploads.MaxBytes / (1024 * 1024)), ("types", J.Strings(Uploads.Extensions)))));
    }

    public async Task<JsonObject> GetSettingsAsync() => J.O(
        ("settings", await AssistantSettings.GetAsync(ai, crypto)), ("languages", AssistantSettings.Langs),
        ("tools", J.A(AssistantTools.Tools.Values.Select(t => (object?)J.O(("name", t.Name), ("label", t.Label), ("description", t.Description.Split(". ")[0]),
            ("permissions", J.Strings(t.AnyOf)))))),
        ("actions", J.A(AssistantActions.Defs.Values.Select(a => (object?)J.O(("kind", a["kind"]?.DeepClone()), ("label", a["label"]?.DeepClone()), ("permission", a["permission"]?.DeepClone()))))));

    public async Task<JsonObject> PutSettingsAsync(JsonObject body, UserModel admin)
    {
        body = (JsonObject)body.DeepClone();
        var password = J.S(body["password"]);
        var code = J.S(body["totp"]);
        body.Remove("password");
        body.Remove("totp");
        var before = (JsonObject)(await AssistantSettings.StoredAsync(ai))["decision"]!;
        JsonObject cfg;
        try
        {
            cfg = AssistantSettings.Validate(body, before, crypto);
        }
        catch (ArgumentException exc)
        {
            throw new AppException(exc.Message, "invalid_assistant_settings");
        }
        var laya = AssistantSettings.LayaChanged(before, (JsonObject)cfg["decision"]!);
        if (laya)
        {
            // every staff question (and the token) goes to the Laya server: the same bar as connecting an AI provider
            if (!(await PermsAsync(admin)).Contains("ai_providers")) throw new ForbiddenException("Changing the Laya server or its token needs the AI providers permission");
            await ConfirmIdentityAsync(admin, password, code, "assistant-laya");
        }
        await ai.SaveSettingAsync(AssistantSettings.Key, cfg);
        await ai.AuditAsync(admin.Id, "assistant.settings", "settings", "assistant",
            $"decision={J.S(cfg["decision"]!["provider"])} voice={(J.Truthy(cfg["voice"]!["enabled"]) ? "True" : "False")}" + (laya ? " laya_server=changed" : ""));
        return await GetSettingsAsync();
    }

    /// <summary>The account password and, with two-step sign-in on, the authenticator code (reference core/step_up).</summary>
    private async Task ConfirmIdentityAsync(UserModel user, string password, string code, string purpose)
    {
        await ai.RateLimitAsync($"{purpose}:{user.Id}", 30, 600);
        if (!EncryptDecrypt.VerifyPassword(password, user.PasswordHash))
            throw new AppException("Your password is not correct", "wrong_password", 403, new Dictionary<string, string> { ["password"] = "Incorrect" });
        if (user.TotpEnabled && !Totp.Verify(crypto.Decrypt(user.TotpSecretEnc), code))
            throw new AppException("Enter the current 6-digit code from your authenticator app", "totp_required", 403, new Dictionary<string, string> { ["totp"] = "Required" });
    }

    public async Task<JsonObject> DecisionTestAsync(string text)
    {
        var cfg = await AssistantSettings.GetAsync(ai, crypto, reveal: true);
        var d = await DecisionLayer.DecideAsync(text, (JsonObject)cfg["decision"]!, AssistantTools.Tools.Keys.ToHashSet(), false, log);
        return d.AsDict();
    }

    // ---------------------------------------------------------------- conversations

    private static JsonObject ConvOut(AssistantConversationModel c, int? count = null)
    {
        var o = J.O(("id", c.Id.ToString()), ("title", c.Title), ("updated_at", DateTimeFunctions.Iso(c.UpdatedAt)), ("created_at", DateTimeFunctions.Iso(c.CreatedAt)),
            ("archived", c.IsArchived), ("context", J.Parse(c.Context) ?? new JsonObject()));
        if (count.HasValue) o["messages"] = count.Value;
        return o;
    }

    private async Task<AssistantConversationModel> OwnAsync(UserModel user, Guid id)
    {
        var c = await dal.ConversationAsync(id);
        if (c is null || c.UserId != user.Id) throw new NotFoundException("Conversation");
        return c;
    }

    public async Task<JsonObject> ConversationsAsync(UserModel user, bool archived, string q) =>
        J.O(("items", J.A((await dal.ConversationsAsync(user.Id, archived, J.Cut(q.Trim(), 60))).Select(c => (object?)ConvOut(c)))));

    private static JsonObject PageOf(Dictionary<string, System.Text.Json.JsonElement>? d)
    {
        var o = new JsonObject();
        foreach (var k in new[] { "path", "title", "filters" })
            if (d != null && d.ContainsKey(k)) o[k] = J.Cut(Dict(d, k), 300);
        return o;
    }

    private static string Dict(Dictionary<string, System.Text.Json.JsonElement> d, string key) =>
        d.TryGetValue(key, out var v) ? v.ValueKind == System.Text.Json.JsonValueKind.String ? v.GetString() ?? "" : v.ValueKind == System.Text.Json.JsonValueKind.Null ? "None" : v.GetRawText() : "";

    public async Task<JsonObject> CreateConversationAsync(UserModel user, AssistantConversationIn body)
    {
        var now = DateTimeFunctions.UtcNow();
        var c = new AssistantConversationModel
        {
            Id = Guid.NewGuid(), UserId = user.Id, Title = body.Title.Trim().Length > 0 ? body.Title.Trim() : "New chat", Context = J.Dumps(PageOf(body.Context)),
            CreatedAt = now, UpdatedAt = now,
        };
        await dal.InsertConversationAsync(c);
        return ConvOut(c, 0);
    }

    public async Task<JsonObject> PatchConversationAsync(UserModel user, Guid id, AssistantConversationPatch body)
    {
        var c = await OwnAsync(user, id);
        if (body.Title != null) c.Title = body.Title.Trim();
        if (body.Archived.HasValue) c.IsArchived = body.Archived.Value;
        await dal.SetConversationMetaAsync(c.Id, c.Title, c.IsArchived);
        return ConvOut(c);
    }

    public async Task DeleteConversationAsync(UserModel user, Guid id) => await dal.DeleteConversationAsync((await OwnAsync(user, id)).Id);

    public static JsonObject MessageOut(AssistantMessageModel m) => J.O(("id", m.Id.ToString()), ("role", m.Role), ("text", m.Text), ("blocks", J.Parse(m.Blocks) ?? new JsonArray()),
        ("status", m.Status), ("mode", m.Mode), ("created_at", DateTimeFunctions.Iso(m.CreatedAt)));

    public async Task<JsonObject> ConversationAsync(UserModel user, Guid id)
    {
        var c = await OwnAsync(user, id);
        var acts = await dal.ActionStatusesAsync(c.Id);
        var outp = new JsonArray();
        foreach (var m in await dal.MessagesAsync(c.Id))
        {
            var d = MessageOut(m);
            var blocks = new JsonArray();
            foreach (var b in d["blocks"] as JsonArray ?? [])
            {
                if (b is JsonObject bo && J.S(bo["type"]) == "action")
                {
                    var copy = (JsonObject)bo.DeepClone();
                    copy["status"] = acts.TryGetValue(J.S(bo["action_id"]), out var st) ? st : bo["status"]?.DeepClone();
                    blocks.Add(copy);
                }
                else blocks.Add(b?.DeepClone());
            }
            d["blocks"] = blocks;
            outp.Add(d);
        }
        return J.Merge(ConvOut(c), J.O(("messages", outp)));
    }

    // ---------------------------------------------------------------- asking

    public async Task PrepareAskAsync(UserModel user, Guid conversationId, AssistantAskIn body)
    {
        var cfg = await AssistantSettings.GetAsync(ai, crypto);
        if (!J.Truthy(cfg["enabled"])) throw new AppException("The AI assistant is switched off. An admin can turn it on in Admin → AI assistant.", "assistant_off", 409);
        await OwnAsync(user, conversationId);
        var perms = await PermsAsync(user);
        if (body.UploadIds.Count > 0 && !perms.Contains("assistant_files")) throw new ForbiddenException("Your role cannot share files with the assistant (assistant_files)");
        if (body.Voice && !perms.Contains("assistant_voice")) throw new ForbiddenException("Your role cannot use voice (assistant_voice)");
        await ai.RateLimitAsync($"assistant:{user.Id}", 120, 3600);
    }

    private static string ModelText(string text, JsonArray files) =>
        files.Count > 0 ? text + "\n\n[Attached: " + string.Join("; ", files.OfType<JsonObject>().Select(f => $"{J.S(f["filename"])} (file_id {J.S(f["id"])})")) + "]" : text;

    /// <summary>Keeps the conversation valid for every provider: alternating roles, every tool call answered.</summary>
    public static JsonArray CleanHistory(IEnumerable<JsonObject> msgs)
    {
        var outp = new List<JsonObject>();
        foreach (var m in msgs)
        {
            if (outp.Count > 0 && J.S(outp[^1]["role"]) == J.S(m["role"]))
            {
                var prev = outp[^1];
                var a = prev["content"] as JsonArray ?? new JsonArray(J.O(("type", "text"), ("text", J.S(prev["content"]))));
                var b = m["content"] as JsonArray ?? new JsonArray(J.O(("type", "text"), ("text", J.S(m["content"]))));
                outp[^1] = J.O(("role", J.S(m["role"])), ("content", new JsonArray(a.Select(x => x?.DeepClone()).Concat(b.Select(x => x?.DeepClone())).ToArray())));
            }
            else outp.Add((JsonObject)m.DeepClone());
        }
        if (outp.Count > 0 && J.S(outp[^1]["role"]) == "assistant" && outp[^1]["content"] is JsonArray last && last.OfType<JsonObject>().Any(b => J.S(b["type"]) == "tool_use"))
        {
            var texts = last.OfType<JsonObject>().Where(b => J.S(b["type"]) == "text").Select(b => (JsonNode?)b.DeepClone()).ToArray();
            outp[^1] = J.O(("role", "assistant"), ("content", texts.Length > 0 ? new JsonArray(texts) : new JsonArray(J.O(("type", "text"), ("text", "(stopped)")))));
        }
        return new JsonArray(outp.Select(x => (JsonNode)x).ToArray());
    }

    private static JsonArray Compact(List<JsonObject> blocks)
    {
        var outp = new List<JsonObject>();
        foreach (var b in blocks)
        {
            if (J.S(b["type"]) == "text" && outp.Count > 0 && J.S(outp[^1]["type"]) == "text")
                outp[^1] = J.O(("type", "text"), ("text", J.S(outp[^1]["text"]) + J.S(b["text"])));
            else outp.Add(b);
        }
        return new JsonArray(outp.Select(x => (JsonNode)x.DeepClone()).ToArray());
    }

    private async Task<(JsonArray History, string Earlier)> HistoryAsync(Guid convId, int keep, Guid exclude)
    {
        var rows = (await dal.MessagesAsync(convId)).Where(m => m.Id != exclude).ToList();
        var recent = rows.Count > keep ? rows[^keep..] : rows.ToList();
        var older = rows.Count > keep ? rows[..^keep] : [];
        while (recent.Count > 0 && recent[0].Role != "user")
        {
            older.Add(recent[0]); // the model's history must start with the person
            recent.RemoveAt(0);
        }
        var msgs = new List<JsonObject>();
        foreach (var m in recent)
        {
            var mc = J.Parse(m.ModelContent) as JsonArray;
            if (mc is { Count: > 0 }) msgs.AddRange(mc.OfType<JsonObject>());
            else msgs.Add(J.O(("role", m.Role), ("content", m.Text.Length > 0 ? m.Text : "(no text)")));
        }
        var earlier = string.Join("\n", older.Skip(Math.Max(0, older.Count - 20)).Select(m =>
            $"{(m.Role == "user" ? "Person" : "You")}: {J.Cut(string.Join(' ', m.Text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), 240)}"));
        return (CleanHistory(msgs), earlier);
    }

    public async Task AskAsync(UserModel user, Guid conversationId, AssistantAskIn body, Func<JsonObject, Task> emit, CancellationToken ct)
    {
        var text = body.Text.Trim();
        var conv = await dal.ConversationAsync(conversationId);
        if (conv is null || conv.UserId != user.Id)
        {
            await emit(J.O(("type", "error"), ("message", "Conversation not found")));
            return;
        }
        var cfg = await AssistantSettings.GetAsync(ai, crypto, reveal: true);
        var perms = await PermsAsync(user);
        var allowed = AssistantTools.Available(perms);
        var names = allowed.Select(t => t.Name).ToHashSet();
        var now = DateTimeFunctions.UtcNow();
        var fileRows = new List<AssistantUploadModel>();
        foreach (var fid in body.UploadIds.Take(5))
            if (Guid.TryParse(fid, out var g) && await dal.UploadAsync(g) is { } up && up.UserId == user.Id) fileRows.Add(up);
        var files = J.A(fileRows.Select(f => (object?)J.O(("id", f.Id.ToString()), ("filename", f.Filename), ("rows", f.RowCount), ("columns", J.Arr(f.Columns).Count))));
        var page = body.Page is null ? null : PageOf(body.Page);
        if (page is { Count: 0 }) page = null;
        var userMsg = new AssistantMessageModel
        {
            Id = Guid.NewGuid(), ConversationId = conv.Id, Role = "user", Text = text, Blocks = J.Dumps(files.Count > 0 ? new JsonArray(J.O(("type", "files"), ("items", files.DeepClone()))) : new JsonArray()),
            ModelContent = J.Dumps(new JsonArray(J.O(("role", "user"), ("content", ModelText(text, files))))), UploadIds = J.Dumps(J.Strings(fileRows.Select(f => f.Id.ToString()))),
            Status = "done", Mode = "", CreatedAt = now,
        };
        await dal.InsertMessageAsync(userMsg);
        if (conv.Title is "" or "New chat")
        {
            var t = J.Cut(string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), 60);
            conv.Title = t.Length > 0 ? t : "New chat";
        }
        conv.UpdatedAt = now;
        if (page != null) conv.Context = J.Dumps(page);
        await dal.UpdateConversationAsync(conv);

        var reply = new AssistantMessageModel { Id = Guid.NewGuid(), ConversationId = conv.Id, Role = "assistant", CreatedAt = DateTimeFunctions.UtcNow() };
        const string route = "assistant";
        var chain = await llmConfig.TargetsAsync(route);
        var mode = chain.Count > 0 ? "live" : "sandbox";
        if (mode == "live" && LlmTransport.TestHandler is null && env.IsTest) mode = "sandbox"; // tests never call a real provider
        var dec = await DecisionLayer.DecideAsync(text, (JsonObject)cfg["decision"]!, names, files.Count > 0, log);
        if (body.Voice && dec.VoiceFast && mode == "live")
        {
            var fast = (await llmConfig.RawAsync())["routes"]?["assistant_fast"] as JsonArray;
            if (fast is { Count: > 0 }) chain = await llmConfig.TargetsAsync("assistant_fast"); // only when the admin set a fast route
        }
        await emit(J.O(("type", "start"), ("user_message_id", userMsg.Id.ToString()), ("message_id", reply.Id.ToString()), ("conversation_id", conv.Id.ToString()),
            ("title", conv.Title), ("mode", mode)));
        await emit(J.Merge(J.O(("type", "decision")), dec.AsDict()));

        var ctx = new ToolContext
        {
            Q = Q, Dal = dal, Ai = ai, AiBal = aiBal, Actions = Actions, AnthropicKey = anthropic, User = user, Permissions = perms, ConversationId = conv.Id,
            ShareContacts = J.Truthy(cfg["share_contact_details"]), UploadIds = fileRows.Select(f => f.Id.ToString()).ToList(),
        };
        var blocks = new List<JsonObject>();
        var turnMsgs = new List<JsonObject>();
        int uin = 0, uout = 0, ucw = 0, ucr = 0;
        string usedModel = "", status = "done";
        var sw = Stopwatch.StartNew();

        async Task Cards(ToolOutput o)
        {
            foreach (var c in o.Cards)
            {
                blocks.Add(c);
                await emit(J.O(("type", "card"), ("card", c.DeepClone())));
            }
        }

        try
        {
            if (mode == "sandbox")
            {
                var (d, calls) = AssistantSandbox.Choose(text, names, files.Count > 0);
                var results = new List<(string, JsonNode?)>();
                foreach (var (name, args) in calls)
                {
                    await emit(J.O(("type", "tool"), ("name", name), ("label", AssistantTools.Tools[name].Label)));
                    var (o, _) = await AssistantTools.ExecuteAsync(ctx, name, args);
                    results.Add((name, o.Data));
                    await Cards(o);
                }
                var answer = AssistantSandbox.Reply(d, results);
                await emit(J.O(("type", "text"), ("delta", answer)));
                blocks.Add(J.O(("type", "text"), ("text", answer)));
                reply.Text = answer;
                turnMsgs = [J.O(("role", "assistant"), ("content", new JsonArray(J.O(("type", "text"), ("text", answer)))))];
                usedModel = "sandbox";
            }
            else
            {
                var aiCfg = await AiSettings.GetAsync(ai, env);
                if (!J.Truthy(aiCfg["enabled"]) || !J.Truthy(cfg["enabled"])) throw new AppException("The AI assistant is switched off in Admin → AI assistant", "assistant_off", 409);
                if ((J.Long(aiCfg["monthly_token_budget"]) ?? 0) is var budget and > 0)
                {
                    var u = await ai.UsageSinceAsync(AiShared.MonthStartUtc());
                    if (u.Input + u.Output >= budget) throw new AppException("This month's AI budget is used up. Raise it in AI studio.", "ai_budget", 429);
                }
                var (history, earlier) = await HistoryAsync(conv.Id, (int)(J.Long(cfg["history_messages"]) ?? 16), userMsg.Id);
                var site = await AiShared.SiteAsync(ai, env);
                var memories = await AssistantSettings.MemoriesAsync(ai, user.Id);
                var roleName = await access.RoleNameAsync(access.RoleCode(user));
                var system = new List<SystemBlock>
                {
                    new(AssistantPrompts.Rules, true),
                    new(AssistantPrompts.Knowledge(AiShared.Brand(site), J.S(cfg["instructions"])), true),
                    new(AssistantPrompts.Context(user.Name, roleName, perms, page, memories, body.Voice, dec.Source != "off" ? dec.AsDict() : null, files, earlier)),
                };
                var offered = allowed.Where(t => dec.Tools is null || dec.Tools.Contains(t.Name)).ToList();
                var specs = new JsonArray(offered.Select(t => (JsonNode)t.Spec()).ToArray());
                var messages = (JsonArray)history.DeepClone();
                messages.Add(J.O(("role", "user"), ("content", ModelText(text, files))));
                if (dec.Prefetch.Count > 0)
                {
                    var calls = new JsonArray();
                    var results = new JsonArray();
                    var offeredNames = offered.Select(t => t.Name).ToHashSet();
                    for (var i = 0; i < dec.Prefetch.Count; i++)
                    {
                        var (name, args) = dec.Prefetch[i];
                        if (!offeredNames.Contains(name)) continue;
                        await emit(J.O(("type", "tool"), ("name", name), ("label", AssistantTools.Tools[name].Label)));
                        var (o, err) = await AssistantTools.ExecuteAsync(ctx, name, args);
                        var tid = $"prefetch_{reply.Id.ToString("N")[..8]}_{i}";
                        calls.Add(J.O(("type", "tool_use"), ("id", tid), ("name", name), ("input", args.DeepClone())));
                        results.Add(J.O(("type", "tool_result"), ("tool_use_id", tid), ("content", AssistantTools.ModelView(o.Data, ctx.ShareContacts)), ("is_error", err)));
                        await Cards(o);
                    }
                    if (calls.Count > 0)
                    {
                        JsonObject[] pre = [J.O(("role", "assistant"), ("content", calls)), J.O(("role", "user"), ("content", results))];
                        foreach (var x in pre) messages.Add(x.DeepClone());
                        turnMsgs.AddRange(pre);
                    }
                }
                var textParts = new List<string>();
                var maxSteps = (int)(J.Long(cfg["max_steps"]) ?? 8);
                for (var step = 0; step < maxSteps; step++)
                {
                    LlmTurn? turn = null;
                    var stepText = new StringBuilder();
                    await router.StreamAsync(route, system, messages, specs, (int)(J.Long(cfg["max_output_tokens"]) ?? 1500), async ev =>
                    {
                        switch (ev.Kind)
                        {
                            case "text":
                                stepText.Append(ev.Text);
                                await emit(J.O(("type", "text"), ("delta", ev.Text)));
                                break;
                            case "tool":
                                await emit(J.O(("type", "tool"), ("name", ev.ToolName), ("label", AssistantTools.Tools.TryGetValue(ev.ToolName ?? "", out var td) ? td.Label : "Working")));
                                break;
                            case "turn": turn = ev.Turn; break;
                            case "used":
                                usedModel = $"{ev.Used!.Model} via {ev.Used.ConnectionName}" + (ev.Used.Fallbacks > 0 ? $" (fallback {ev.Used.Fallbacks})" : "");
                                break;
                        }
                    }, chain, ct);
                    uin += turn!.InputTokens;
                    uout += turn.OutputTokens;
                    ucw += turn.CacheCreationTokens;
                    ucr += turn.CacheReadTokens;
                    if (stepText.Length > 0)
                    {
                        blocks.Add(J.O(("type", "text"), ("text", stepText.ToString())));
                        textParts.Add(stepText.ToString());
                    }
                    messages.Add(J.O(("role", "assistant"), ("content", turn.Content.DeepClone())));
                    turnMsgs.Add(J.O(("role", "assistant"), ("content", turn.Content.DeepClone())));
                    var toolCalls = turn.Content.OfType<JsonObject>().Where(b => J.S(b["type"]) == "tool_use").ToList();
                    if (toolCalls.Count == 0) break;
                    var results = new JsonArray();
                    foreach (var b in toolCalls)
                    {
                        var (o, err) = await AssistantTools.ExecuteAsync(ctx, J.S(b["name"]), b["input"] as JsonObject);
                        results.Add(J.O(("type", "tool_result"), ("tool_use_id", J.S(b["id"])), ("content", AssistantTools.ModelView(o.Data, ctx.ShareContacts)), ("is_error", err)));
                        await Cards(o);
                    }
                    messages.Add(J.O(("role", "user"), ("content", results.DeepClone())));
                    turnMsgs.Add(J.O(("role", "user"), ("content", results)));
                    if (step == maxSteps - 1)
                    {
                        const string note = "\n\n(I reached the step limit for one question. Ask me to continue.)";
                        textParts.Add(note);
                        blocks.Add(J.O(("type", "text"), ("text", note)));
                        await emit(J.O(("type", "text"), ("delta", note)));
                        turnMsgs.Add(J.O(("role", "assistant"), ("content", new JsonArray(J.O(("type", "text"), ("text", note.Trim()))))));
                    }
                }
                reply.Text = string.Join("\n\n", textParts.Select(p => p.Trim()).Where(p => p.Length > 0));
            }
        }
        catch (AppException exc)
        {
            status = "error";
            reply.Text = (reply.Text.Length > 0 ? reply.Text + "\n\n" : "") + exc.Message;
            blocks.Add(J.O(("type", "error"), ("text", exc.Message)));
            await emit(J.O(("type", "error"), ("message", exc.Message), ("code", exc.Code)));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            status = "stopped";
        }
        catch (Exception exc)
        {
            log.LogError(exc, "assistant turn failed"); // never leave the chat hanging; details go to the log
            status = "error";
            const string msg = "Something went wrong while answering. Please try again.";
            blocks.Add(J.O(("type", "error"), ("text", msg)));
            await emit(J.O(("type", "error"), ("message", msg)));
        }
        reply.Blocks = J.Dumps(Compact(blocks));
        reply.Status = status;
        reply.Mode = mode;
        JsonArray content;
        if (turnMsgs.Count > 0)
        {
            var cleaned = CleanHistory(new[] { J.O(("role", "user"), ("content", "x")) }.Concat(turnMsgs));
            content = new JsonArray(cleaned.Skip(1).Select(x => x?.DeepClone()).ToArray());
        }
        else content = [];
        if (content.Count == 0 || J.S(content[0]?["role"]) != "assistant")
            content.Insert(0, J.O(("role", "assistant"), ("content", new JsonArray(J.O(("type", "text"), ("text", reply.Text.Length > 0 ? reply.Text : "(no answer)"))))));
        reply.ModelContent = J.Dumps(content);
        reply.UploadIds = "[]";
        reply.InputTokens = uin;
        reply.OutputTokens = uout;
        try
        {
            await dal.InsertMessageAsync(reply);
            await dal.TouchConversationAsync(conv.Id);
            if (mode == "live")
                await ai.InsertRunAsync(new AiRunModel
                {
                    Id = Guid.NewGuid(), Task = "assistant", SubjectType = "conversation", SubjectId = conv.Id.ToString(), Inputs = J.Dumps(J.O(("question", J.Cut(text, 500)))),
                    Output = J.Dumps(J.O(("blocks", J.Arr(reply.Blocks).Count))), FinalText = J.Cut(reply.Text, 4000), Status = status == "done" ? "applied" : "failed", Mode = mode,
                    Model = J.Cut(usedModel, 80), InputTokens = uin, OutputTokens = uout, CacheCreationTokens = ucw, CacheReadTokens = ucr, LatencyMs = (int)sw.ElapsedMilliseconds,
                    Error = status == "done" ? "" : status, CreatedBy = user.Id, CreatedAt = DateTimeFunctions.UtcNow(),
                });
        }
        catch (Exception exc)
        {
            log.LogError(exc, "could not save assistant reply");
        }
        if (status == "done")
            await emit(J.O(("type", "done"), ("message", MessageOut(reply)), ("model", usedModel), ("usage", J.O(("input_tokens", uin), ("output_tokens", uout)))));
    }

    // ---------------------------------------------------------------- uploads

    public async Task<JsonObject> UploadAsync(UserModel user, string filename, string contentType, byte[] data)
    {
        await ai.RateLimitAsync($"assistant-upload:{user.Id}", 60, 3600);
        AssistantUploadModel up;
        try
        {
            up = Uploads.Build(user.Id, filename, contentType, data);
        }
        catch (UploadException exc)
        {
            throw new AppException(exc.Message, "bad_upload");
        }
        await dal.InsertUploadAsync(up);
        await ai.AuditAsync(user.Id, "assistant.upload", "upload", up.Id, $"{up.Filename} {up.RowCount} rows");
        return Uploads.Profile(up);
    }

    public Task DeleteUploadAsync(UserModel user, Guid id) => dal.DeleteUploadAsync(id, user.Id);

    // ---------------------------------------------------------------- actions

    public async Task<JsonObject> DecideActionAsync(UserModel user, Guid actionId, string decision)
    {
        var a = await dal.ActionAsync(actionId);
        if (a is null || a.UserId != user.Id) throw new NotFoundException("Action");
        if (a.Status != "pending") throw new AppException($"This action is already {a.Status}", "action_done", 409);
        if (decision == "cancel")
        {
            a.Status = "cancelled";
            a.DecidedAt = DateTimeFunctions.UtcNow();
            await dal.UpdateActionAsync(a);
            return J.O(("id", a.Id.ToString()), ("status", a.Status));
        }
        // the action row is claimed first, so two quick presses cannot run it twice
        await using (var uow = await dal.BeginAsync())
        {
            var locked = await dal.ActionAsync(actionId, uow);
            if (locked is null || locked.Status != "pending") throw new AppException($"This action is already {locked?.Status}", "action_done", 409);
            await uow.ExecuteAsync("UPDATE assistant_actions SET status = 'done' WHERE id = @id", new { id = actionId });
            await uow.CommitAsync();
        }
        JsonObject result;
        try
        {
            result = await Actions.ExecuteAsync(user, a);
        }
        catch (AppException exc)
        {
            var current = J.Obj(a.Result);
            a.Status = exc.Code == "action_expired" ? "expired" : "failed";
            a.DecidedAt = DateTimeFunctions.UtcNow();
            if (exc.Code != "action_expired")
            {
                current["error"] = exc.Message;
                await ai.AuditAsync(user.Id, $"assistant.action.{a.Kind}", "assistant_action", a.Id, $"failed: {J.Cut(exc.Message, 200)}");
            }
            a.Result = J.Dumps(current);
            await dal.UpdateActionAsync(a);
            throw;
        }
        var res = J.Obj(a.Result);
        var outcome = new JsonObject();
        foreach (var (k, v) in result)
            if (v is JsonValue) outcome[k] = v.DeepClone();
        res["outcome"] = outcome;
        a.Status = "done";
        a.DecidedAt = DateTimeFunctions.UtcNow();
        a.Result = J.Dumps(res);
        await dal.UpdateActionAsync(a);
        await ai.AuditAsync(user.Id, $"assistant.action.{a.Kind}", "assistant_action", a.Id, J.Cut(a.Summary, 200));
        return J.O(("id", a.Id.ToString()), ("status", a.Status), ("summary", a.Summary));
    }

    // ---------------------------------------------------------------- downloads and memory

    private static string SafeName(string text)
    {
        var s = Regex.Replace(text.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        s = J.Cut(s, 50);
        return s.Length > 0 ? s : "assistant";
    }

    public async Task<(byte[] Data, string ContentType, string FileName)> DownloadMessageAsync(UserModel user, Guid messageId, string fmt)
    {
        if (!Downloads.Formats.ContainsKey(fmt)) throw new NotFoundException("Format");
        var m = await dal.MessageAsync(messageId);
        var conv = m != null ? await dal.ConversationAsync(m.ConversationId) : null;
        if (m is null || conv is null || conv.UserId != user.Id) throw new NotFoundException("Message");
        var question = await dal.QuestionBeforeAsync(conv.Id, m.CreatedAt);
        var msgs = new List<JsonObject>();
        if (question != null && m.Role == "assistant") msgs.Add(MessageOut(question));
        msgs.Add(MessageOut(m));
        var brand = AiShared.Brand(await AiShared.SiteAsync(ai, env));
        var data = Downloads.Build(fmt, msgs, $"{brand} assistant — {conv.Title}", brand);
        return (data, Downloads.Formats[fmt], $"{SafeName(conv.Title)}-{m.CreatedAt:yyyyMMdd-HHmm}.{fmt}");
    }

    public async Task<(byte[] Data, string ContentType, string FileName)> DownloadConversationAsync(UserModel user, Guid conversationId, string fmt)
    {
        if (!Downloads.Formats.ContainsKey(fmt)) throw new NotFoundException("Format");
        var c = await OwnAsync(user, conversationId);
        var msgs = (await dal.MessagesAsync(c.Id)).Select(MessageOut).ToList();
        var brand = AiShared.Brand(await AiShared.SiteAsync(ai, env));
        return (Downloads.Build(fmt, msgs, $"{brand} assistant — {c.Title}", brand), Downloads.Formats[fmt], $"{SafeName(c.Title)}.{fmt}");
    }

    public async Task<JsonObject> MemoryAsync(UserModel user) => J.O(("notes", J.Strings(await AssistantSettings.MemoriesAsync(ai, user.Id))));

    public async Task<JsonObject> PutMemoryAsync(UserModel user, List<string> notes) => J.O(("notes", J.Strings(await AssistantSettings.SetMemoriesAsync(ai, user.Id, notes))));

    // ---------------------------------------------------------------- AI providers

    public Task<JsonObject> ProvidersAsync() => llmConfig.ViewAsync();

    private static JsonObject ConnectionData(LlmConnectionIn b) => J.O(("name", b.Name), ("type", b.Type), ("base_url", b.BaseUrl), ("models", J.Strings(b.Models)),
        ("enabled", b.Enabled), ("timeout_s", b.TimeoutS),
        ("add_keys", J.A(b.AddKeys.Select(k => (object?)J.O(k.Select(kv => (kv.Key, (object?)kv.Value)).ToArray())))), ("remove_keys", J.Strings(b.RemoveKeys)));

    public async Task<JsonObject> AddConnectionAsync(LlmConnectionIn body, UserModel admin)
    {
        JsonObject rec;
        try { rec = await llmConfig.SaveConnectionAsync(ConnectionData(body), null); }
        catch (LlmConfigException exc) { throw new AppException(exc.Message, "invalid_connection"); }
        await ai.AuditAsync(admin.Id, "ai_provider.create", "ai_provider", J.S(rec["id"]), $"{J.S(rec["type"])} {J.S(rec["name"])} keys={(rec["keys"] as JsonArray)!.Count}");
        return await llmConfig.ViewAsync();
    }

    public async Task<JsonObject> EditConnectionAsync(string connId, LlmConnectionIn body, UserModel admin)
    {
        if (connId == LlmConfigBAL.BuiltinId) throw new AppException("This connection uses the Claude key from Integrations; change it there.", "builtin_connection");
        JsonObject rec;
        try { rec = await llmConfig.SaveConnectionAsync(ConnectionData(body), connId); }
        catch (LlmConfigException exc) { throw new AppException(exc.Message, "invalid_connection"); }
        await ai.AuditAsync(admin.Id, "ai_provider.update", "ai_provider", connId,
            $"keys added={body.AddKeys.Count} removed={body.RemoveKeys.Count} models={(rec["models"] as JsonArray)!.Count}");
        return await llmConfig.ViewAsync();
    }

    public async Task<JsonObject> RemoveConnectionAsync(string connId, UserModel admin)
    {
        await llmConfig.DeleteConnectionAsync(connId);
        await ai.AuditAsync(admin.Id, "ai_provider.delete", "ai_provider", connId);
        return await llmConfig.ViewAsync();
    }

    public async Task<JsonObject> TestConnectionAsync(string connId, string model, UserModel admin)
    {
        await ai.RateLimitAsync($"llm-test:{admin.Id}", 30, 600);
        var conn = (await llmConfig.ConnectionsAsync()).FirstOrDefault(c => c.Id == connId) ?? throw new NotFoundException("Connection");
        var m = model.Length > 0 ? model : conn.Models.FirstOrDefault() ?? "";
        var (ok, message, latency) = await router.TestTargetAsync(conn, m);
        if (connId != LlmConfigBAL.BuiltinId) await llmConfig.RecordTestAsync(connId, ok, message);
        await ai.AuditAsync(admin.Id, "ai_provider.test", "ai_provider", connId, ok ? "ok" : "failed");
        return J.O(("ok", ok), ("message", message), ("latency_ms", latency));
    }

    public async Task<JsonObject> PutRoutesAsync(LlmRoutesIn body, UserModel admin)
    {
        var routes = new JsonObject();
        foreach (var (r, chain) in body.Routes)
            routes[r] = J.A(chain.Select(t => (object?)J.O(t.Select(kv => (kv.Key, (object?)kv.Value)).ToArray())));
        try { await llmConfig.SaveRoutesAsync(routes); }
        catch (LlmConfigException exc) { throw new AppException(exc.Message, "invalid_routes"); }
        await ai.AuditAsync(admin.Id, "ai_provider.routes", "ai_provider", "routes", string.Join(", ", body.Routes.Select(kv => $"{kv.Key}:{kv.Value.Count}")));
        return await llmConfig.ViewAsync();
    }
}

/// <summary>RFC 6238 time-based one-time passwords (authenticator apps), for the step-up check.</summary>
public static class Totp
{
    private static byte[] Base32(string s)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        s = s.Trim().TrimEnd('=').ToUpperInvariant();
        var bytes = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var c in s)
        {
            var v = alphabet.IndexOf(c);
            if (v < 0) continue;
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8)
            {
                bytes.Add((byte)(buffer >> (bits - 8)));
                bits -= 8;
            }
        }
        return bytes.ToArray();
    }

    public static string Code(string secret, long counter)
    {
        var msg = BitConverter.GetBytes(counter);
        if (BitConverter.IsLittleEndian) Array.Reverse(msg);
        var digest = HMACSHA1.HashData(Base32(secret), msg);
        var offset = digest[^1] & 0x0F;
        var value = ((digest[offset] & 0x7F) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
        return (value % 1_000_000).ToString("D6");
    }

    public static string Current(string secret) => Code(secret, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30);

    public static bool Verify(string secret, string code, int window = 1)
    {
        code = (code ?? "").Trim().Replace(" ", "");
        if (secret.Length == 0 || code.Length != 6 || !code.All(char.IsDigit)) return false;
        var step = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30;
        for (var d = -window; d <= window; d++)
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Code(secret, step + d)), Encoding.ASCII.GetBytes(code))) return true;
        return false;
    }
}
