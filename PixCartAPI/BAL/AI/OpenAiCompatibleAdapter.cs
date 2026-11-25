using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BAL.AI;

/// <summary>
/// OpenAI Chat Completions, streamed: OpenAI, Azure OpenAI, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together,
/// Fireworks, Cerebras, Ollama, LM Studio, vLLM and any compatible server. The canonical conversation is converted
/// (system text joined, tool_use → tool_calls, tool_result → role "tool"). Usage comes from stream_options.include_usage;
/// servers that reject that option get the same request without streaming.
/// </summary>
public sealed class OpenAiCompatibleAdapter : ILlmAdapter
{
    public static (JsonArray Messages, JsonArray Functions) ToOpenAi(IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray tools)
    {
        var outp = new JsonArray();
        var sysText = string.Join("\n\n", system.Where(b => !string.IsNullOrEmpty(b.Text)).Select(b => b.Text));
        if (sysText.Length > 0) outp.Add(J.O(("role", "system"), ("content", sysText)));
        foreach (var node in messages)
        {
            if (node is not JsonObject m) continue;
            var role = J.S(m, "role");
            var content = m["content"];
            if (content is not JsonArray blocks)
            {
                outp.Add(J.O(("role", role), ("content", J.S(content))));
                continue;
            }
            if (role == "assistant")
            {
                var text = string.Concat(blocks.OfType<JsonObject>().Where(b => J.S(b, "type") == "text").Select(b => J.S(b, "text")));
                var calls = new JsonArray();
                foreach (var b in blocks.OfType<JsonObject>().Where(b => J.S(b, "type") == "tool_use"))
                    calls.Add(J.O(("id", J.S(b, "id")), ("type", "function"),
                        ("function", J.O(("name", J.S(b, "name")), ("arguments", J.Dumps(b["input"] as JsonObject ?? []))))));
                var msg = J.O(("role", "assistant"), ("content", text.Length > 0 ? text : null));
                if (calls.Count > 0) msg["tool_calls"] = calls;
                outp.Add(msg);
            }
            else
            {
                var texts = new List<string>();
                foreach (var b in blocks.OfType<JsonObject>())
                {
                    var t = J.S(b, "type");
                    if (t == "tool_result")
                    {
                        var c = b["content"];
                        var s = c is JsonArray arr ? string.Concat(arr.OfType<JsonObject>().Select(x => J.S(x, "text"))) : J.S(c);
                        outp.Add(J.O(("role", "tool"), ("tool_call_id", J.S(b, "tool_use_id")), ("content", s)));
                    }
                    else if (t == "text") texts.Add(J.S(b, "text"));
                }
                if (texts.Count > 0) outp.Add(J.O(("role", "user"), ("content", string.Join("\n", texts))));
            }
        }
        var fns = new JsonArray();
        foreach (var t in tools.OfType<JsonObject>())
            fns.Add(J.O(("type", "function"), ("function", J.O(("name", J.S(t, "name")), ("description", J.S(t, "description")),
                ("parameters", t["input_schema"]?.DeepClone() ?? J.O(("type", "object")))))));
        return (outp, fns);
    }

    public async Task StreamAsync(LlmConnection conn, string key, string model, IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray tools,
        int maxTokens, Func<LlmEvent, Task> emit, CancellationToken ct)
    {
        var (msgs, fns) = ToOpenAi(system, messages, tools);
        var body = J.O(("model", model), ("messages", msgs), ("stream", true), ("max_tokens", maxTokens), ("stream_options", J.O(("include_usage", true))));
        if (fns.Count > 0) body["tools"] = fns;
        var textParts = new StringBuilder();
        var anyText = false;
        var calls = new SortedDictionary<int, (string Id, string Name, StringBuilder Args)>();
        int input = 0, output = 0, cacheR = 0;
        string finish = "", usedModel = model;
        var timeout = TimeSpan.FromSeconds(conn.TimeoutS);
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(timeout);
        try
        {
            using var client = LlmTransport.Client();
            using var req = Post(conn, key, body);
            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, idle.Token);
            var status = (int)resp.StatusCode;
            if (status == 400)
            {
                var raw = await resp.Content.ReadAsStringAsync(idle.Token);
                if (raw.Contains("stream_options"))
                {
                    // some servers reject the usage option: the same request without streaming
                    await NonStreamingAsync(conn, key, model, msgs, fns, maxTokens, emit, idle.Token);
                    return;
                }
                throw ProviderException.Classify(400, raw);
            }
            if (status >= 400) throw ProviderException.Classify(status, await resp.Content.ReadAsStringAsync(idle.Token));
            await using var stream = await resp.Content.ReadAsStreamAsync(idle.Token);
            await foreach (var ev in SseReader.ReadAsync(stream, idle.Token))
            {
                idle.CancelAfter(timeout);
                if (J.Truthy(ev["error"]))
                {
                    var m = J.S((ev["error"] as JsonObject)?["message"]);
                    throw new ProviderException(J.Cut(string.IsNullOrEmpty(m) ? "stream error" : m, 200), 500);
                }
                if (J.S(ev, "model") is { Length: > 0 } em) usedModel = em;
                if (ev["usage"] is JsonObject u && u.Count > 0)
                {
                    input = (int)(J.Long(u["prompt_tokens"]) ?? 0);
                    output = (int)(J.Long(u["completion_tokens"]) ?? 0);
                    cacheR = (int)(J.Long((u["prompt_tokens_details"] as JsonObject)?["cached_tokens"]) ?? 0);
                }
                foreach (var chNode in ev["choices"] as JsonArray ?? [])
                {
                    if (chNode is not JsonObject ch) continue;
                    var d = ch["delta"] as JsonObject ?? [];
                    if (J.S(d, "content") is { Length: > 0 } piece)
                    {
                        textParts.Append(piece);
                        anyText = true;
                        await emit(new LlmEvent("text", Text: piece));
                    }
                    foreach (var tcNode in d["tool_calls"] as JsonArray ?? [])
                    {
                        if (tcNode is not JsonObject tc) continue;
                        var i = (int)(J.Long(tc["index"]) ?? calls.Count);
                        if (!calls.TryGetValue(i, out var slot)) slot = ("", "", new StringBuilder());
                        if (J.S(tc, "id") is { Length: > 0 } id) slot.Id = id;
                        var fn = tc["function"] as JsonObject ?? [];
                        if (J.S(fn, "name") is { Length: > 0 } name)
                        {
                            slot.Name = name;
                            calls[i] = slot;
                            await emit(new LlmEvent("tool", ToolId: slot.Id.Length > 0 ? slot.Id : $"call_{i}", ToolName: name));
                        }
                        if (J.S(fn, "arguments") is { Length: > 0 } args) slot.Args.Append(args);
                        calls[i] = slot;
                    }
                    if (J.S(ch, "finish_reason") is { Length: > 0 } fr) finish = fr;
                }
            }
        }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new LlmNetworkException("ReadTimeout", e);
        }
        catch (HttpRequestException e)
        {
            throw new LlmNetworkException(e.HttpRequestError == HttpRequestError.ConnectionError ? "ConnectError" : e.GetType().Name, e);
        }
        var content = new JsonArray();
        if (anyText) content.Add(J.O(("type", "text"), ("text", textParts.ToString())));
        foreach (var (i, slot) in calls)
        {
            var raw = slot.Args.ToString();
            JsonNode? args = null;
            if (raw.Trim().Length > 0)
            {
                try { args = JsonNode.Parse(raw); } catch (JsonException) { args = null; }
            }
            content.Add(J.O(("type", "tool_use"), ("id", slot.Id.Length > 0 ? slot.Id : $"call_{i}"), ("name", slot.Name), ("input", args as JsonObject ?? [])));
        }
        var stop = content.OfType<JsonObject>().Any(b => J.S(b, "type") == "tool_use") ? "tool_use" : finish == "length" ? "max_tokens" : "end_turn";
        await emit(new LlmEvent("turn", Turn: new LlmTurn
        {
            Content = content, StopReason = stop, Model = usedModel, InputTokens = input, OutputTokens = output, CacheReadTokens = cacheR,
        }));
    }

    private static HttpRequestMessage Post(LlmConnection conn, string key, JsonObject body)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, LlmTransport.Url(conn, "/chat/completions"))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        LlmTransport.AddHeaders(req, conn, key);
        return req;
    }

    private static async Task NonStreamingAsync(LlmConnection conn, string key, string model, JsonArray msgs, JsonArray fns, int maxTokens,
        Func<LlmEvent, Task> emit, CancellationToken ct)
    {
        var body = J.O(("model", model), ("messages", msgs.DeepClone()), ("stream", false), ("max_tokens", maxTokens));
        if (fns.Count > 0) body["tools"] = fns.DeepClone();
        using var client = LlmTransport.Client();
        using var req = Post(conn, key, body);
        using var r = await client.SendAsync(req, ct);
        var text = await r.Content.ReadAsStringAsync(ct);
        if ((int)r.StatusCode >= 400) throw ProviderException.Classify((int)r.StatusCode, text);
        var data = J.Obj(text);
        var msg = ((data["choices"] as JsonArray)?.FirstOrDefault() as JsonObject)?["message"] as JsonObject ?? [];
        var content = new JsonArray();
        if (J.S(msg, "content") is { Length: > 0 } c)
        {
            content.Add(J.O(("type", "text"), ("text", c)));
            await emit(new LlmEvent("text", Text: c));
        }
        var i = 0;
        foreach (var tcNode in msg["tool_calls"] as JsonArray ?? [])
        {
            if (tcNode is not JsonObject tc) { i++; continue; }
            var fn = tc["function"] as JsonObject ?? [];
            JsonNode? args;
            try { args = JsonNode.Parse(J.S(fn, "arguments") is { Length: > 0 } a ? a : "{}"); } catch (JsonException) { args = null; }
            var id = J.S(tc, "id");
            content.Add(J.O(("type", "tool_use"), ("id", id.Length > 0 ? id : $"call_{i}"), ("name", J.S(fn, "name")), ("input", args as JsonObject ?? [])));
            await emit(new LlmEvent("tool", ToolId: id, ToolName: J.S(fn, "name")));
            i++;
        }
        var u = data["usage"] as JsonObject ?? [];
        await emit(new LlmEvent("turn", Turn: new LlmTurn
        {
            Content = content, StopReason = content.OfType<JsonObject>().Any(b => J.S(b, "type") == "tool_use") ? "tool_use" : "end_turn",
            Model = J.S(data, "model") is { Length: > 0 } dm ? dm : model,
            InputTokens = (int)(J.Long(u["prompt_tokens"]) ?? 0), OutputTokens = (int)(J.Long(u["completion_tokens"]) ?? 0),
        }));
    }
}
