using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.AI;
using BAL.Interface;
using BAL.ShopAssistant;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>Live mode: an AI model on the shop_assistant route answers with the customer tools
/// (reference: shop_assistant/agent.py choose_mode + the live branch of run, and _history/_clean/_compact).</summary>
public partial class ShopAssistantBAL
{
    private const string ShopRoute = "shop_assistant";
    private static readonly HashSet<string> AiFailures = ["ai_unavailable", "ai_not_configured", "ai_interrupted"];
    private static readonly TimeSpan IstTz = TimeSpan.FromHours(5.5);

    /// <summary>Reference: agent.choose_mode. Live only when the assistant is set to auto, a model is connected on the
    /// route and the monthly token budget is not used up; anything else answers in guided mode.</summary>
    private async Task<(string Mode, List<LlmTarget> Chain)> ChooseModeAsync(JsonObject cfg)
    {
        if (cfg.Str("ai") != "auto") return ("guided", []);
        var chain = await llmConfig.TargetsAsync(ShopRoute);
        if (chain.Count == 0) return ("guided", []);
        var budget = cfg.Long("monthly_token_budget");
        if (budget > 0)
        {
            var nowIst = DateTime.UtcNow + IstTz;
            var monthStartUtc = new DateTime(nowIst.Year, nowIst.Month, 1) - IstTz; // created_at is stored UTC
            if (await dal.MonthlyShopTokensAsync(monthStartUtc) >= budget) return ("guided", []);
        }
        return ("live", chain);
    }

    /// <summary>Reference: agent._history. Recent messages as model content, the older ones as one condensed text.</summary>
    private async Task<(List<JsonObject> Messages, string Earlier)> HistoryAsync(Guid chatId, int keep, Guid excludeId)
    {
        var rows = (await dal.MessagesAsync(chatId)).Where(m => m.Id != excludeId).ToList();
        var recent = rows.TakeLast(keep).ToList();
        var older = rows.Count > keep ? rows.Take(rows.Count - keep).ToList() : [];
        while (recent.Count > 0 && recent[0].Role != "user")
        {
            older.Add(recent[0]);
            recent.RemoveAt(0);
        }
        var msgs = new List<JsonObject>();
        foreach (var m in recent)
        {
            var content = JsonNode.Parse(string.IsNullOrEmpty(m.ModelContent) ? "[]" : m.ModelContent) as JsonArray ?? [];
            if (content.Count > 0)
                msgs.AddRange(content.OfType<JsonObject>().Select(c => (JsonObject)c.DeepClone()));
            else
                msgs.Add(new JsonObject { ["role"] = m.Role, ["content"] = m.Text.Length > 0 ? m.Text : "(no text)" });
        }
        var earlier = string.Join("\n", older.TakeLast(12).Select(m =>
            $"{(m.Role == "user" ? "Customer" : "You")}: {Collapse(m.Text, 200)}"));
        return (CleanModelMessages(msgs), earlier);

        static string Collapse(string text, int max)
        {
            var flat = string.Join(' ', (text ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            return flat[..Math.Min(max, flat.Length)];
        }
    }

    /// <summary>Reference: agent._clean — alternating roles and no dangling tool calls, so every provider accepts the history.</summary>
    private static List<JsonObject> CleanModelMessages(List<JsonObject> msgs)
    {
        var outp = new List<JsonObject>();
        foreach (var m in msgs)
        {
            if (outp.Count > 0 && outp[^1].Str("role") == m.Str("role"))
            {
                var a = Blocks(outp[^1]);
                foreach (var b in Blocks(m)) a.Add(b);
                outp[^1] = new JsonObject { ["role"] = m.Str("role"), ["content"] = a };
            }
            else outp.Add((JsonObject)m.DeepClone());
        }
        if (outp.Count > 0 && outp[^1].Str("role") == "assistant" && outp[^1]["content"] is JsonArray last
            && last.OfType<JsonObject>().Any(b => b.Str("type") == "tool_use"))
        {
            var texts = last.OfType<JsonObject>().Where(b => b.Str("type") == "text").Select(b => (JsonNode)b.DeepClone()).ToList();
            outp[^1] = new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = new JsonArray(texts.Count > 0 ? texts.ToArray() : [(JsonNode)new JsonObject { ["type"] = "text", ["text"] = "(stopped)" }]),
            };
        }
        return outp;

        static JsonArray Blocks(JsonObject m)
        {
            if (m["content"] is JsonArray arr) return (JsonArray)arr.DeepClone();
            return new JsonArray(new JsonObject { ["type"] = "text", ["text"] = m["content"]?.GetValue<string>() ?? "" });
        }
    }

    /// <summary>Reference: agent._compact — merge adjacent text blocks.</summary>
    private static List<JsonObject> CompactBlocks(List<JsonObject> blocks)
    {
        var outp = new List<JsonObject>();
        foreach (var b in blocks)
        {
            if (b.Str("type") == "text" && outp.Count > 0 && outp[^1].Str("type") == "text")
                outp[^1] = new JsonObject { ["type"] = "text", ["text"] = outp[^1].Str("text") + b.Str("text") };
            else outp.Add(b);
        }
        return outp;
    }

    /// <summary>Reference: tools.model_view — compact JSON the model reads, cut at 8000 chars.</summary>
    private static string ModelView(JsonObject data)
    {
        var text = data.ToJsonString(J.Relaxed);
        return text.Length <= 8000 ? text : text[..8000] + "…(cut)";
    }

    /// <summary>Reference: agent._prefetch — run the obvious tool before the model sees the question.</summary>
    private static List<(string Name, Dictionary<string, object?> Args)> Prefetch(ShopIntents.Intent it, bool signed) =>
        !signed ? [] :
        (it.Name is "track" or "cancel" or "return" or "damaged") && it.OrderNumber is not null
            ? [("order_details", new Dictionary<string, object?> { ["order_number"] = it.PackageNumber ?? it.OrderNumber })] :
        it.Name == "track" ? [("my_orders", new Dictionary<string, object?>())] :
        it.Name == "ticket_status" && it.TicketNumber is not null
            ? [("ticket_details", new Dictionary<string, object?> { ["ticket_number"] = it.TicketNumber })] :
        it.Name is "tickets" or "refund"
            ? [(it.Name == "tickets" ? "my_tickets" : "my_returns_and_refunds", new Dictionary<string, object?>())] : [];

    /// <summary>The live branch of agent.run: prefetch, then tool-calling steps until the model answers in text.
    /// Streams tool/card events as they happen like the reference; the model's own text deltas are collected per turn
    /// (the router callback cannot yield) and emitted before that turn's tool cards, preserving the reference order.
    /// The caller falls back to guided when the model fails before any text.</summary>
    private async IAsyncEnumerable<JsonObject> RunLiveEventsAsync(Ctx ctx, ShopIntents.Intent it, string text, JsonObject cfg, UserModel? user,
        bool voice, JsonObject? page, Guid chatId, Guid replyId, Guid userMsgId, List<LlmTarget> chain,
        List<JsonObject> blocks, List<JsonObject> turnMsgs, int[] usage, string[] usedModel,
        bool[] streamedText, [EnumeratorCancellation] CancellationToken ct)
    {
        var (history, earlier) = await HistoryAsync(chatId, cfg.Int("history_messages"), userMsgId);
        var hint = it.Name != "unknown"
            ? new JsonObject { ["intent"] = it.Name, ["order"] = it.OrderNumber }
            : null;
        var system = new List<SystemBlock>
        {
            new(ShopPrompts.Rules, Cache: true),
            new(ShopPrompts.Knowledge(ctx.Facts["brand"]?.ToString() ?? "our store", cfg.Str("instructions"), ctx.Facts), Cache: true),
            new(ShopPrompts.Context(user is not null, user?.Name ?? "", page, voice, earlier, hint)),
        };
        var specs = new JsonArray(ShopToolSpecs.Available(user is not null, ctx.Features).Select(t => (JsonNode)t.Spec()).ToArray());
        var messages = new JsonArray(history.Select(m => (JsonNode)m).ToArray());
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = text });
        var textParts = new List<string>();

        var i = 0;
        foreach (var (name, args) in Prefetch(it, user is not null))
        {
            if (!FeatureOn(ctx, ShopToolSpecs.Find(name)?.Feature ?? "")) continue;
            yield return new JsonObject { ["type"] = "tool", ["name"] = name, ["label"] = ShopToolSpecs.LabelOf(name) };
            var outc = await CallToolAsync(ctx, name, args);
            var tid = $"prefetch_{replyId:N}"[..17] + "_" + i++; // reference: f"prefetch_{reply.id.hex[:8]}_{i}"
            var call = new JsonObject { ["type"] = "tool_use", ["id"] = tid, ["name"] = name, ["input"] = new JsonObject(args.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value is JsonNode jn ? jn : JsonValue.Create(kv.Value)))) };
            var result = new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = tid, ["content"] = ModelView(outc.Data), ["is_error"] = outc.Err };
            foreach (var c in outc.Cards) { blocks.Add(c); yield return new JsonObject { ["type"] = "card", ["card"] = c.DeepClone() }; }
            var pre = new JsonObject[]
            {
                new() { ["role"] = "assistant", ["content"] = new JsonArray(call) },
                new() { ["role"] = "user", ["content"] = new JsonArray(result) },
            };
            foreach (var m in pre) { messages.Add(m); turnMsgs.Add(m); }
        }

        for (var step = 0; step < cfg.Int("max_steps"); step++)
        {
            LlmTurn? turn = null;
            var stepText = new System.Text.StringBuilder();
            var pending = new List<JsonObject>(); // this turn's deltas/tool notices, in the reference's order
            await llmRouter.StreamAsync(ShopRoute, system, messages, specs, cfg.Int("max_output_tokens"), ev =>
            {
                switch (ev.Kind)
                {
                    case "text":
                        stepText.Append(ev.Text);
                        streamedText[0] = true;
                        pending.Add(new JsonObject { ["type"] = "text", ["delta"] = ev.Text });
                        break;
                    case "tool":
                        pending.Add(new JsonObject { ["type"] = "tool", ["name"] = ev.ToolName, ["label"] = ShopToolSpecs.LabelOf(ev.ToolName ?? "") });
                        break;
                    case "turn":
                        turn = ev.Turn;
                        break;
                    case "used":
                        usedModel[0] = $"{ev.Used!.Model} via {ev.Used.ConnectionName}";
                        break;
                }
                return Task.CompletedTask;
            }, chain, ct);
            foreach (var p in pending) yield return p;
            if (turn is null) throw new AppException("The AI did not answer.", "ai_unavailable", 502);
            usage[0] += turn.InputTokens;
            usage[1] += turn.OutputTokens;
            usage[2] += turn.CacheCreationTokens;
            usage[3] += turn.CacheReadTokens;
            if (stepText.Length > 0)
            {
                var s = stepText.ToString();
                blocks.Add(new JsonObject { ["type"] = "text", ["text"] = s });
                textParts.Add(s);
            }
            var assistantMsg = new JsonObject { ["role"] = "assistant", ["content"] = turn.Content.DeepClone() };
            messages.Add(assistantMsg);
            turnMsgs.Add(assistantMsg);
            var tcalls = (turn.Content as JsonArray ?? []).OfType<JsonObject>().Where(b => b.Str("type") == "tool_use").ToList();
            if (tcalls.Count == 0) break;
            var tresults = new JsonArray();
            foreach (var b in tcalls)
            {
                var input = (b["input"] as JsonObject ?? []).ToDictionary(kv => kv.Key, kv => (object?)kv.Value);
                var outc = await CallToolAsync(ctx, b.Str("name"), input);
                tresults.Add(new JsonObject
                {
                    ["type"] = "tool_result", ["tool_use_id"] = b.Str("id"), ["content"] = ModelView(outc.Data), ["is_error"] = outc.Err,
                });
                foreach (var c in outc.Cards) { blocks.Add(c); yield return new JsonObject { ["type"] = "card", ["card"] = c.DeepClone() }; }
            }
            var resultMsg = new JsonObject { ["role"] = "user", ["content"] = tresults };
            messages.Add(resultMsg);
            turnMsgs.Add(resultMsg);
        }
        ctx.ReplyText = string.Join("\n\n", textParts.Select(p => p.Trim()).Where(p => p.Length > 0));
    }
}
