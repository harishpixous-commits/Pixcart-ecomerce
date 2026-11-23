using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BAL.AI;

/// <summary>The provider could not be reached or stopped answering (the reference version's httpx.HTTPError).</summary>
public sealed class LlmNetworkException(string kind, Exception? inner = null) : Exception(kind, inner)
{
    public string Kind { get; } = kind;
}

/// <summary>
/// Anthropic Messages API (Claude), streamed. System blocks marked Cache become prompt-cache breakpoints (at most 4;
/// dynamic blocks stay uncached). Tool calls arrive as tool_use blocks whose input JSON streams in pieces. Usage tokens
/// (input, output, cache write, cache read) come from message_start and message_delta.
/// </summary>
public sealed class AnthropicAdapter : ILlmAdapter
{
    public const string AnthropicVersion = "2023-06-01";

    public static JsonObject Body(string model, IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray tools, int maxTokens)
    {
        var sys = new JsonArray();
        var marks = 0;
        foreach (var b in system)
        {
            var blk = J.O(("type", "text"), ("text", b.Text));
            if (b.Cache && marks < 4)
            {
                blk["cache_control"] = J.O(("type", "ephemeral"));
                marks++;
            }
            sys.Add(blk);
        }
        var body = J.O(("model", model), ("max_tokens", maxTokens), ("system", sys), ("messages", messages.DeepClone()), ("stream", true));
        if (tools.Count > 0) body["tools"] = tools.DeepClone();
        return body;
    }

    public async Task StreamAsync(LlmConnection conn, string key, string model, IReadOnlyList<SystemBlock> system, JsonArray messages, JsonArray tools,
        int maxTokens, Func<LlmEvent, Task> emit, CancellationToken ct)
    {
        var body = Body(model, system, messages, tools, maxTokens);
        var blocks = new SortedDictionary<int, JsonObject>();
        var partial = new Dictionary<int, StringBuilder>();
        int input = 0, output = 0, cacheW = 0, cacheR = 0;
        string stop = "", usedModel = model;
        var timeout = TimeSpan.FromSeconds(conn.TimeoutS);
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(timeout);
        try
        {
            using var client = LlmTransport.Client();
            using var req = new HttpRequestMessage(HttpMethod.Post, LlmTransport.Url(conn, "/v1/messages"))
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            LlmTransport.AddHeaders(req, conn, key);
            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, idle.Token);
            if ((int)resp.StatusCode >= 400)
                throw ProviderException.Classify((int)resp.StatusCode, await resp.Content.ReadAsStringAsync(idle.Token));
            await using var stream = await resp.Content.ReadAsStreamAsync(idle.Token);
            await foreach (var ev in SseReader.ReadAsync(stream, idle.Token))
            {
                idle.CancelAfter(timeout);
                switch (J.S(ev, "type"))
                {
                    case "message_start":
                    {
                        var msg = ev["message"] as JsonObject ?? [];
                        usedModel = J.S(msg, "model") is { Length: > 0 } m ? m : model;
                        var u = msg["usage"] as JsonObject ?? [];
                        input = (int)(J.Long(u["input_tokens"]) ?? 0);
                        cacheW = (int)(J.Long(u["cache_creation_input_tokens"]) ?? 0);
                        cacheR = (int)(J.Long(u["cache_read_input_tokens"]) ?? 0);
                        break;
                    }
                    case "content_block_start":
                    {
                        var idx = (int)(J.Long(ev["index"]) ?? 0);
                        var cb = (ev["content_block"] as JsonObject)?.DeepClone() as JsonObject ?? [];
                        if (J.S(cb, "type") == "tool_use")
                        {
                            cb["input"] = new JsonObject();
                            partial[idx] = new StringBuilder();
                            await emit(new LlmEvent("tool", ToolId: J.S(cb, "id"), ToolName: J.S(cb, "name")));
                        }
                        else if (J.S(cb, "type") == "text")
                        {
                            cb["text"] = J.S(cb, "text");
                        }
                        blocks[idx] = cb;
                        break;
                    }
                    case "content_block_delta":
                    {
                        var idx = (int)(J.Long(ev["index"]) ?? 0);
                        var d = ev["delta"] as JsonObject ?? [];
                        if (J.S(d, "type") == "text_delta" && blocks.TryGetValue(idx, out var tb))
                        {
                            var t = J.S(d, "text");
                            tb["text"] = J.S(tb, "text") + t;
                            await emit(new LlmEvent("text", Text: t));
                        }
                        else if (J.S(d, "type") == "input_json_delta")
                        {
                            if (!partial.TryGetValue(idx, out var sb)) partial[idx] = sb = new StringBuilder();
                            sb.Append(J.S(d, "partial_json"));
                        }
                        break;
                    }
                    case "content_block_stop":
                    {
                        var idx = (int)(J.Long(ev["index"]) ?? 0);
                        if (partial.Remove(idx, out var sb) && blocks.TryGetValue(idx, out var blk))
                        {
                            var raw = sb.ToString();
                            JsonNode? parsed = null;
                            if (raw.Trim().Length > 0)
                            {
                                try { parsed = JsonNode.Parse(raw); } catch (JsonException) { parsed = null; }
                            }
                            blk["input"] = parsed as JsonObject ?? new JsonObject();
                        }
                        break;
                    }
                    case "message_delta":
                    {
                        var d = ev["delta"] as JsonObject;
                        if (J.S(d, "stop_reason") is { Length: > 0 } sr) stop = sr;
                        output = (int)(J.Long((ev["usage"] as JsonObject)?["output_tokens"]) ?? output);
                        break;
                    }
                    case "error":
                    {
                        var err = ev["error"] as JsonObject;
                        var m = J.S(err, "message");
                        throw new ProviderException(J.Cut(string.IsNullOrEmpty(m) ? "stream error" : m, 200), 529);
                    }
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
        foreach (var b in blocks.Values)
        {
            var t = J.S(b, "type");
            if (t == "tool_use" || (t == "text" && J.S(b, "text").Length > 0)) content.Add(b.DeepClone());
        }
        await emit(new LlmEvent("turn", Turn: new LlmTurn
        {
            Content = content, StopReason = string.IsNullOrEmpty(stop) ? "end_turn" : stop, Model = usedModel,
            InputTokens = input, OutputTokens = output, CacheCreationTokens = cacheW, CacheReadTokens = cacheR,
        }));
    }
}
