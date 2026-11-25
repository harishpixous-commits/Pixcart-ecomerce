namespace BAL;

using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using BAL.AI;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;

/// <summary>
/// The assistant's agent loop (reference: app/assistant/agent.py). One question becomes a stream of events:
/// start → decision → [tool | card | text]* → done (or error).
/// <list type="number">
/// <item>Save the person's message; load memory notes, attached files and recent history (older turns condensed).</item>
/// <item>Decision layer: areas, period, tools to offer and an optional prefetch (run before the model is called).</item>
/// <item>Model turns on the route's fallback chain (any provider), streaming text. Tool calls run with the person's
/// permissions; their cards stream to the screen immediately. Repeats up to max_steps times.</item>
/// <item>Save the reply (text + cards + model content for follow-up questions) and record tokens in the AI usage log.</item>
/// </list>
/// Without a connected model the sandbox engine answers common questions with the same real tools.
/// </summary>
public class AssistantAskBAL(
    AssistantDAL dal,
    AssistantBAL asst,
    AssistantToolsBAL tools,
    IAccessBAL access,
    ILogger<AssistantAskBAL> log,
    AssistantUploadDAL uploads,
    ILlmConfigBAL llmConfig,
    ILlmRouterBAL llmRouter,
    AiDAL ai,
    SettingsDAL settings,
    AppSettings env,
    ISiteBAL site)
{
    private const string Route = "assistant";
    private const string StepLimitNote = "\n\n(I reached the step limit for one question. Ask me to continue.)";
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    /// <summary>Turn state shared with the engine iterators (C# iterators cannot yield inside a try with a catch).</summary>
    private sealed class TurnState
    {
        public List<JsonObject> Blocks { get; } = [];
        public List<JsonObject> TurnMsgs { get; set; } = [];
        public string ReplyText = "";
        public string UsedModel = "";
        public long[] Usage { get; } = new long[4]; // in, out, cache write, cache read
    }

    private static string Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

    private static int Int(JsonObject o, string key, int fallback) => (int)(J.Long(o[key]) ?? fallback);

    /// <summary>Reference: agent._model_text — the question as the model reads it, with the attached files named.</summary>
    private static string ModelText(string text, JsonArray files) =>
        files.Count > 0
            ? text + "\n\n[Attached: " + string.Join("; ", files.OfType<JsonObject>().Select(f => $"{Str(f["filename"])} (file_id {Str(f["id"])})")) + "]"
            : text;

    /// <summary>Reference: agent.run — streams the events for one question.</summary>
    public async IAsyncEnumerable<JsonObject> AskEventsAsync(
        UserModel user, Guid convId, string text, JsonObject? page, bool voice,
        [EnumeratorCancellation] CancellationToken cancellationToken = default, List<string>? uploadIds = null)
    {
        var conv = await dal.ConversationAsync(convId);
        if (conv is null || conv.UserId != user.Id)
        {
            yield return new JsonObject { ["type"] = "error", ["message"] = "Conversation not found" };
            yield break;
        }
        var cfg = await asst.ConfigForRunAsync(); // reference: settings.get(reveal=True)
        var perms = await access.PermissionsForAsync(user);
        var allowed = AssistantTools.Available(perms).Where(t => tools.RegisteredNames.Contains(t.Name)).ToList();
        var names = allowed.Select(t => t.Name).ToHashSet();
        var now = DateTimeFunctions.UtcNow();
        var files = new JsonArray();
        var ownedIds = new List<string>();
        foreach (var id in (uploadIds ?? []).Take(5))
            if (Guid.TryParse(id, out var fid) && await uploads.OwnAsync(user.Id, fid, now) is { } up)
            {
                files.Add(new JsonObject
                {
                    ["id"] = up.Id.ToString(), ["filename"] = up.Filename, ["rows"] = up.RowCount,
                    ["columns"] = (JsonNode.Parse(up.Columns) as JsonArray)?.Count ?? 0,
                });
                ownedIds.Add(up.Id.ToString());
            }
        var userMsg = new AssistantMessageModel
        {
            Id = Guid.NewGuid(), ConversationId = conv.Id, Role = "user", Text = text,
            Blocks = files.Count > 0 ? new JsonArray(new JsonObject { ["type"] = "files", ["items"] = files.DeepClone() }).ToJsonString() : "[]",
            ModelContent = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = ModelText(text, files) }).ToJsonString(),
            UploadIds = JsonSerializer.Serialize(ownedIds), Status = "done", Mode = "", CreatedAt = now,
        };
        await dal.InsertMessageAsync(userMsg);
        string? title = null;
        if (conv.Title is "" or "New chat")
        {
            var t = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            title = t.Length > 60 ? t[..60] : t;
            if (title.Length == 0) title = "New chat";
        }
        await dal.TouchForAskAsync(conv.Id, title, page?.ToJsonString(), now); // title, updated_at and the page context
        var replyId = Guid.NewGuid();
        var replyCreatedAt = DateTimeFunctions.UtcNow();

        var chain = await llmConfig.TargetsAsync(Route);
        var mode = chain.Count > 0 ? "live" : "sandbox";
        if (mode == "live" && LlmTransport.TestHandler is null && env.IsTest)
            mode = "sandbox"; // tests never call a real provider
        var dec = await AssistantDecision.DecideAsync(text, cfg["decision"] as JsonObject ?? [], names, files.Count > 0, cancellationToken);
        if (voice && dec.VoiceFast && mode == "live")
        {
            var fast = ((await llmConfig.RawAsync())["routes"] as JsonObject)?["assistant_fast"];
            if (J.Truthy(fast)) // only when the admin set a fast route; otherwise the assistant route stays
                chain = await llmConfig.TargetsAsync("assistant_fast");
        }
        yield return new JsonObject
        {
            ["type"] = "start", ["user_message_id"] = userMsg.Id.ToString(), ["message_id"] = replyId.ToString(),
            ["conversation_id"] = conv.Id.ToString(), ["title"] = title ?? conv.Title, ["mode"] = mode,
        };
        var decEvent = new JsonObject { ["type"] = "decision" };
        foreach (var (k, v) in dec.AsDict()) decEvent[k] = v?.DeepClone();
        yield return decEvent;

        var shareContacts = J.Truthy(cfg["share_contact_details"]);
        var ctx = new AssistantToolsBAL.AssistantToolContext(user.Id, perms, conv.Id, shareContacts, ownedIds);
        var state = new TurnState();
        var status = "done";
        var started = Stopwatch.GetTimestamp();
        var finished = false;
        try
        {
            var engine = mode == "sandbox"
                ? SandboxTurnAsync(ctx, names, text, state, cancellationToken)
                : LiveTurnAsync(new LiveTurn(user, conv.Id, cfg, perms, allowed, dec, text, files, page, voice, chain, replyId, userMsg.Id),
                    ctx, state, cancellationToken);
            await using var enumerator = engine.GetAsyncEnumerator(cancellationToken);
            while (true)
            {
                JsonObject ev;
                try
                {
                    if (!await enumerator.MoveNextAsync()) break;
                    ev = enumerator.Current;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    status = "stopped";
                    throw;
                }
                catch (AppException exc)
                {
                    status = "error";
                    state.ReplyText = (state.ReplyText.Length > 0 ? state.ReplyText + "\n\n" : "") + exc.Message;
                    state.Blocks.Add(new JsonObject { ["type"] = "error", ["text"] = exc.Message });
                    ev = new JsonObject { ["type"] = "error", ["message"] = exc.Message, ["code"] = exc.Code };
                }
                catch (Exception ex) // never leave the chat hanging; details go to the log
                {
                    log.LogError(ex, "assistant turn failed");
                    status = "error";
                    const string msg = "Something went wrong while answering. Please try again.";
                    state.Blocks.Add(new JsonObject { ["type"] = "error", ["text"] = msg });
                    ev = new JsonObject { ["type"] = "error", ["message"] = msg };
                }
                yield return ev;
                if (status != "done") break;
            }
            finished = true;
        }
        finally
        {
            // The reply is saved however the turn ended; a consumer that stops reading (the browser went away) is the
            // reference's GeneratorExit: "stopped".
            if (!finished && status == "done") status = "stopped";
            await SaveAsync(state, replyId, replyCreatedAt, conv.Id, user, mode, status, started, text);
        }
        if (status == "done")
            yield return new JsonObject
            {
                ["type"] = "done", ["message"] = MessageOut(ReplyRecord(state, replyId, replyCreatedAt, conv.Id, mode, status)),
                ["model"] = state.UsedModel,
                ["usage"] = new JsonObject { ["input_tokens"] = state.Usage[0], ["output_tokens"] = state.Usage[1] },
            };
    }

    /// <summary>Reference: agent.run sandbox branch — sandbox.choose, run the picked tools, then sandbox.reply.</summary>
    private async IAsyncEnumerable<JsonObject> SandboxTurnAsync(
        AssistantToolsBAL.AssistantToolContext ctx, HashSet<string> names, string text, TurnState state,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var (d, calls) = AssistantSandbox.Choose(text, names, ctx.UploadIds.Count > 0);
        var results = new List<(string Name, JsonNode? Data)>();
        foreach (var (name, args) in calls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return ToolEvent(name);
            var (output, _) = await tools.ExecuteAsync(ctx, name, args);
            results.Add((name, output.Data));
            foreach (var card in output.Cards)
            {
                state.Blocks.Add(card);
                yield return new JsonObject { ["type"] = "card", ["card"] = card.DeepClone() };
            }
        }
        var answer = AssistantSandbox.Reply(d, results);
        yield return new JsonObject { ["type"] = "text", ["delta"] = answer };
        state.Blocks.Add(new JsonObject { ["type"] = "text", ["text"] = answer });
        state.ReplyText = answer;
        state.TurnMsgs = [new JsonObject { ["role"] = "assistant", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = answer }) }];
        state.UsedModel = "sandbox";
    }

    private static JsonObject ToolEvent(string? name) => new()
    {
        ["type"] = "tool", ["name"] = name,
        ["label"] = name is not null && AssistantTools.ByName.TryGetValue(name, out var def) ? def.Label : "Working",
    };

    /// <summary>What the live branch needs from the start of the turn.</summary>
    private sealed record LiveTurn(
        UserModel User, Guid ConvId, JsonObject Cfg, HashSet<string> Perms, List<AssistantTools.ToolDef> Allowed,
        AssistantDecision.Decision Dec, string Text, JsonArray Files, JsonObject? Page, bool Voice, List<LlmTarget> Chain,
        Guid ReplyId, Guid UserMsgId);

    /// <summary>
    /// Reference: agent.run live branch — the AI switches and the monthly token budget, history, the three system
    /// blocks, the offered tools, the prefetch, then model steps until the model answers without calling a tool (or
    /// the step limit). Model text and tool/card events stream as they happen.
    /// </summary>
    private async IAsyncEnumerable<JsonObject> LiveTurnAsync(LiveTurn lt, AssistantToolsBAL.AssistantToolContext ctx, TurnState state,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var cfg = lt.Cfg;
        var aiCfg = await AiSettings.GetAsync(settings, env); // reference: get_ai_settings
        if (!J.Truthy(aiCfg["enabled"]) || !J.Truthy(cfg["enabled"]))
            throw new AppException("The AI assistant is switched off in Admin → AI assistant", "assistant_off", 409);
        if (J.Long(aiCfg["monthly_token_budget"]) is { } budget && budget != 0)
        {
            var u = await ai.UsageThisMonthAsync(MonthStart()); // reference: usage_this_month (live runs, IST month)
            if (u.InputTokens + u.OutputTokens >= budget)
                throw new AppException("This month's AI budget is used up. Raise it in AI studio.", "ai_budget", 429);
        }
        var (history, earlier) = await HistoryAsync(lt.ConvId, Int(cfg, "history_messages", 16), lt.UserMsgId);
        var siteCfg = await site.GetSiteAsync();
        var memories = await asst.GetMemoryNotesAsync(lt.User.Id);
        var roleName = await access.RoleNameAsync(access.RoleCode(lt.User));
        var system = new List<SystemBlock>
        {
            new(AssistantPrompts.Rules, Cache: true),
            new(AssistantPrompts.Knowledge(Str(siteCfg["brand_name"]), Str(cfg["instructions"])), Cache: true),
            new(AssistantPrompts.Context(lt.User.Name, roleName, lt.Perms, lt.Page, memories, lt.Voice,
                lt.Dec.Source != "off" ? lt.Dec.AsDict() : null, lt.Files, earlier)),
        };
        var offered = lt.Allowed.Where(t => lt.Dec.Tools is null || lt.Dec.Tools.Contains(t.Name)).ToList();
        var offeredNames = offered.Select(t => t.Name).ToHashSet();
        var specs = new JsonArray(offered.Select(t => (JsonNode)AssistantTools.Spec(t.Name)).ToArray());
        var messages = new JsonArray(history.Select(m => (JsonNode)m).ToArray());
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = ModelText(lt.Text, lt.Files) });

        // Prefetch: the obvious first lookup runs now and is handed to the model as if it had asked for it.
        if (lt.Dec.Prefetch.Count > 0)
        {
            var calls = new JsonArray();
            var results = new JsonArray();
            for (var i = 0; i < lt.Dec.Prefetch.Count; i++)
            {
                var (name, args) = lt.Dec.Prefetch[i];
                if (!offeredNames.Contains(name)) continue;
                yield return ToolEvent(name);
                var (output, err) = await tools.ExecuteAsync(ctx, name, (JsonObject)args.DeepClone());
                var tid = $"prefetch_{lt.ReplyId:N}"[..17] + "_" + i; // reference: f"prefetch_{reply.id.hex[:8]}_{i}"
                calls.Add(new JsonObject { ["type"] = "tool_use", ["id"] = tid, ["name"] = name, ["input"] = args.DeepClone() });
                results.Add(new JsonObject
                {
                    ["type"] = "tool_result", ["tool_use_id"] = tid,
                    ["content"] = AssistantToolsBAL.ModelView(output.Data, ctx.ShareContacts), ["is_error"] = err,
                });
                foreach (var c in output.Cards)
                {
                    state.Blocks.Add(c);
                    yield return new JsonObject { ["type"] = "card", ["card"] = c.DeepClone() };
                }
            }
            if (calls.Count > 0)
            {
                var pre = new[]
                {
                    new JsonObject { ["role"] = "assistant", ["content"] = calls },
                    new JsonObject { ["role"] = "user", ["content"] = results },
                };
                foreach (var m in pre)
                {
                    messages.Add(m.DeepClone());
                    state.TurnMsgs.Add(m);
                }
            }
        }

        var textParts = new List<string>();
        var maxSteps = Int(cfg, "max_steps", 8);
        var maxTokens = Int(cfg, "max_output_tokens", 1500);
        for (var step = 0; step < maxSteps; step++)
        {
            LlmTurn? turn = null;
            var stepText = new System.Text.StringBuilder();
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var events = Channel.CreateBounded<LlmEvent>(new BoundedChannelOptions(1)
            {
                SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait,
            });
            Exception? failure = null;
            async Task ProduceAsync()
            {
                try
                {
                    await llmRouter.StreamAsync(Route, system, messages, specs, maxTokens,
                        ev => events.Writer.WriteAsync(ev, lifetime.Token).AsTask(), lt.Chain, lifetime.Token);
                }
                catch (Exception e) { failure = e; }
                finally { events.Writer.TryComplete(); }
            }
            var producer = ProduceAsync();
            try
            {
                await foreach (var ev in events.Reader.ReadAllAsync(ct))
                {
                    switch (ev.Kind)
                    {
                        case "text":
                            stepText.Append(ev.Text);
                            yield return new JsonObject { ["type"] = "text", ["delta"] = ev.Text };
                            break;
                        case "tool":
                            yield return ToolEvent(ev.ToolName);
                            break;
                        case "turn":
                            turn = ev.Turn;
                            break;
                        case "used":
                            var used = ev.Used!;
                            state.UsedModel = $"{used.Model} via {used.ConnectionName}" + (used.Fallbacks > 0 ? $" (fallback {used.Fallbacks})" : "");
                            break;
                    }
                }
                await producer;
                if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
            }
            finally
            {
                // Consumer disposal or cancellation must not leave a blocked producer behind.
                await lifetime.CancelAsync();
                await producer;
            }
            if (turn is null) throw new InvalidOperationException("the model stream ended without a turn"); // reference: assert turn is not None
            state.Usage[0] += turn.InputTokens;
            state.Usage[1] += turn.OutputTokens;
            state.Usage[2] += turn.CacheCreationTokens;
            state.Usage[3] += turn.CacheReadTokens;
            if (stepText.Length > 0)
            {
                state.Blocks.Add(new JsonObject { ["type"] = "text", ["text"] = stepText.ToString() });
                textParts.Add(stepText.ToString());
            }
            messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = turn.Content.DeepClone() });
            state.TurnMsgs.Add(new JsonObject { ["role"] = "assistant", ["content"] = turn.Content.DeepClone() });
            var toolCalls = turn.Content.OfType<JsonObject>().Where(b => Str(b["type"]) == "tool_use").ToList();
            if (toolCalls.Count == 0) break;
            var toolResults = new JsonArray();
            foreach (var b in toolCalls)
            {
                var (output, err) = await tools.ExecuteAsync(ctx, Str(b["name"]), b["input"] is JsonObject input ? (JsonObject)input.DeepClone() : []);
                toolResults.Add(new JsonObject
                {
                    ["type"] = "tool_result", ["tool_use_id"] = Str(b["id"]),
                    ["content"] = AssistantToolsBAL.ModelView(output.Data, ctx.ShareContacts), ["is_error"] = err,
                });
                foreach (var c in output.Cards)
                {
                    state.Blocks.Add(c);
                    yield return new JsonObject { ["type"] = "card", ["card"] = c.DeepClone() };
                }
            }
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = toolResults.DeepClone() });
            state.TurnMsgs.Add(new JsonObject { ["role"] = "user", ["content"] = toolResults });
            if (step == maxSteps - 1)
            {
                textParts.Add(StepLimitNote);
                state.Blocks.Add(new JsonObject { ["type"] = "text", ["text"] = StepLimitNote });
                yield return new JsonObject { ["type"] = "text", ["delta"] = StepLimitNote };
                state.TurnMsgs.Add(new JsonObject
                {
                    ["role"] = "assistant", ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = StepLimitNote.Trim() }),
                });
            }
        }
        state.ReplyText = string.Join("\n\n", textParts.Select(p => p.Trim()).Where(p => p.Length > 0));
    }

    private static DateTime MonthStart()
    {
        var now = DateTimeFunctions.UtcNow() + Ist;
        return new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc) - Ist;
    }

    // ----------------------------------------------------------------------------- history (reference: agent._history, _clean)

    /// <summary>Reference: agent._history — recent messages word for word (as the model saw them) and a condensed note of older ones.</summary>
    private async Task<(List<JsonObject> Messages, string Earlier)> HistoryAsync(Guid convId, int keep, Guid exclude)
    {
        var rows = (await dal.MessagesAsync(convId)).Where(m => m.Id != exclude).ToList();
        // Python: recent = rows[-keep:]; older = rows[:-keep] if len(rows) > keep else []
        var recent = keep > 0 ? rows.TakeLast(keep).ToList() : rows.ToList();
        var older = keep > 0 && rows.Count > keep ? rows.Take(rows.Count - keep).ToList() : [];
        while (recent.Count > 0 && recent[0].Role != "user") // the model's history must start with the person
        {
            older.Add(recent[0]);
            recent.RemoveAt(0);
        }
        var msgs = new List<JsonObject>();
        foreach (var m in recent)
        {
            var content = J.Parse(m.ModelContent) as JsonArray;
            if (content is { Count: > 0 })
                msgs.AddRange(content.OfType<JsonObject>().Select(c => (JsonObject)c.DeepClone()));
            else
                msgs.Add(new JsonObject { ["role"] = m.Role, ["content"] = m.Text.Length > 0 ? m.Text : "(no text)" });
        }
        var earlier = string.Join("\n", older.TakeLast(20).Select(m =>
        {
            var flat = string.Join(' ', (m.Text ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            return $"{(m.Role == "user" ? "Person" : "You")}: {(flat.Length > 240 ? flat[..240] : flat)}";
        }));
        return (Clean(msgs), earlier);
    }

    /// <summary>Reference: agent._clean — keeps the conversation valid for every provider: alternating roles, every tool call answered.</summary>
    private static List<JsonObject> Clean(List<JsonObject> msgs)
    {
        static JsonArray Blocks(JsonObject m) => m["content"] is JsonArray arr
            ? (JsonArray)arr.DeepClone()
            : new JsonArray(new JsonObject { ["type"] = "text", ["text"] = Str(m["content"]) });
        var outp = new List<JsonObject>();
        foreach (var m in msgs)
        {
            if (outp.Count > 0 && Str(outp[^1]["role"]) == Str(m["role"]))
            {
                var a = Blocks(outp[^1]);
                foreach (var b in Blocks(m)) a.Add(b?.DeepClone());
                outp[^1] = new JsonObject { ["role"] = Str(m["role"]), ["content"] = a };
            }
            else
            {
                outp.Add((JsonObject)m.DeepClone());
            }
        }
        // Drop a trailing assistant tool call without its result (an interrupted turn).
        if (outp.Count > 0 && Str(outp[^1]["role"]) == "assistant" && outp[^1]["content"] is JsonArray last
            && last.OfType<JsonObject>().Any(b => Str(b["type"]) == "tool_use"))
        {
            var texts = last.OfType<JsonObject>().Where(b => Str(b["type"]) == "text").Select(b => (JsonNode)b.DeepClone()).ToArray();
            outp[^1] = new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = texts.Length > 0 ? new JsonArray(texts) : new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "(stopped)" }),
            };
        }
        return outp;
    }

    // ----------------------------------------------------------------------------- saving (reference: agent.run finally, _compact, _save)

    private static JsonObject AnswerOnly(string text) => new()
    {
        ["role"] = "assistant",
        ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text.Length > 0 ? text : "(no answer)" }),
    };

    /// <summary>The reply as saved (reference: the finally block of agent.run).</summary>
    private static AssistantMessageModel ReplyRecord(TurnState state, Guid replyId, DateTime createdAt, Guid convId, string mode, string status)
    {
        var content = new List<JsonObject>();
        if (state.TurnMsgs.Count > 0)
        {
            var withQuestion = new List<JsonObject> { new() { ["role"] = "user", ["content"] = "x" } };
            withQuestion.AddRange(state.TurnMsgs);
            content.AddRange(Clean(withQuestion).Skip(1));
        }
        else
        {
            content.Add(AnswerOnly(state.ReplyText));
        }
        if (content.Count == 0 || Str(content[0]["role"]) != "assistant")
            content.Insert(0, AnswerOnly(state.ReplyText));
        return new AssistantMessageModel
        {
            Id = replyId, ConversationId = convId, Role = "assistant", Text = state.ReplyText,
            Blocks = Compact(state.Blocks).ToJsonString(),
            ModelContent = new JsonArray(content.Select(c => (JsonNode)c).ToArray()).ToJsonString(),
            UploadIds = "[]", Status = status, Mode = mode,
            InputTokens = (int)state.Usage[0], OutputTokens = (int)state.Usage[1], CreatedAt = createdAt,
        };
    }

    /// <summary>Reference: agent._save — the reply, the conversation's updated time and, in live mode, the AI usage record.</summary>
    private async Task SaveAsync(TurnState state, Guid replyId, DateTime createdAt, Guid convId, UserModel user, string mode, string status,
        long started, string question)
    {
        try
        {
            var reply = ReplyRecord(state, replyId, createdAt, convId, mode, status);
            await dal.InsertMessageAsync(reply);
            await dal.TouchForAskAsync(convId, null, null, DateTimeFunctions.UtcNow());
            if (mode == "live")
                await ai.InsertRunAsync(new AiRunModel
                {
                    Id = Guid.NewGuid(), Task = "assistant", SubjectType = "conversation", SubjectId = convId.ToString(),
                    Inputs = new JsonObject { ["question"] = question.Length > 500 ? question[..500] : question }.ToJsonString(J.Relaxed),
                    Output = new JsonObject { ["blocks"] = (JsonNode.Parse(reply.Blocks) as JsonArray)?.Count ?? 0 }.ToJsonString(),
                    FinalText = reply.Text.Length > 4000 ? reply.Text[..4000] : reply.Text,
                    Status = status == "done" ? "applied" : "failed", Mode = mode,
                    Model = state.UsedModel.Length > 80 ? state.UsedModel[..80] : state.UsedModel,
                    InputTokens = (int)state.Usage[0], OutputTokens = (int)state.Usage[1],
                    CacheCreationTokens = (int)state.Usage[2], CacheReadTokens = (int)state.Usage[3],
                    LatencyMs = (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                    Error = status == "done" ? "" : status, CreatedBy = user.Id, CreatedAt = DateTimeFunctions.UtcNow(),
                });
        }
        catch (Exception e)
        {
            log.LogError(e, "could not save assistant reply");
        }
    }

    /// <summary>Reference: agent._compact — merges neighbouring text blocks so the saved message reads as it streamed.</summary>
    private static JsonArray Compact(List<JsonObject> blocks)
    {
        var outBlocks = new JsonArray();
        foreach (var b in blocks)
        {
            if (Str(b["type"]) == "text" && outBlocks.LastOrDefault() is JsonObject last && Str(last["type"]) == "text")
                last["text"] = Str(last["text"]) + Str(b["text"]);
            else
                outBlocks.Add(b.DeepClone());
        }
        return outBlocks;
    }

    /// <summary>Reference: agent.message_out.</summary>
    public static JsonObject MessageOut(AssistantMessageModel m) => new()
    {
        ["id"] = m.Id.ToString(), ["role"] = m.Role, ["text"] = m.Text,
        ["blocks"] = JsonNode.Parse(m.Blocks)?.DeepClone() ?? new JsonArray(),
        ["status"] = m.Status, ["mode"] = m.Mode, ["created_at"] = m.CreatedAt.ToString("o"),
    };
}
