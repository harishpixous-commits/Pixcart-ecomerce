namespace BAL;

using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;
using Utils.Interface;

/// <summary>
/// The assistant's agent loop (reference: app/assistant/agent.py). One question becomes a stream of events:
/// start → decision → [tool | card]* → text → done (or error). Only the sandbox engine runs in this build:
/// the live model branch is fail-closed until the LLM router is ported, and never calls an external provider.
/// </summary>
public class AssistantAskBAL(
    AssistantDAL dal,
    AssistantBAL asst,
    AssistantToolsBAL tools,
    IAccessBAL access,
    ILogger<AssistantAskBAL> log,AssistantUploadDAL uploads)
{
    /// <summary>Mutable turn state shared with the sandbox iterator (C# iterators cannot yield inside try/catch).</summary>
    private sealed class TurnState
    {
        public List<JsonObject> Blocks { get; } = [];
        public string ReplyText = "";
    }

    /// <summary>Reference: agent.run — streams the events for one question.</summary>
    public async IAsyncEnumerable<JsonObject> AskEventsAsync(
        UserModel user, Guid convId, string text, JsonObject? page, bool voice,
        [EnumeratorCancellation] CancellationToken cancellationToken = default,List<string>? uploadIds=null)
    {
        var conv = await dal.ConversationAsync(convId);
        if (conv is null || conv.UserId != user.Id)
        {
            yield return new JsonObject { ["type"] = "error", ["message"] = "Conversation not found" };
            yield break;
        }
        var cfg = await asst.ConfigForRunAsync();
        var perms = await access.PermissionsForAsync(user);
        var names = AssistantTools.Available(perms).Select(t => t.Name)
            .Where(n => tools.RegisteredNames.Contains(n)).ToHashSet();
        var now = DateTimeFunctions.UtcNow();var files=new JsonArray();var ownedIds=new List<string>();foreach(var id in (uploadIds??[]).Take(5))if(Guid.TryParse(id,out var fid)&&await uploads.OwnAsync(user.Id,fid,now) is {} up){files.Add(new JsonObject{["id"]=up.Id.ToString(),["filename"]=up.Filename,["rows"]=up.RowCount,["columns"]=(JsonNode.Parse(up.Columns) as JsonArray)?.Count??0});ownedIds.Add(up.Id.ToString());}
        var modelText=text+(files.Count>0?"\n\n[Attached: "+string.Join("; ",files.Select(f=>$"{f!["filename"]!.GetValue<string>()} (file_id {f["id"]!.GetValue<string>()})"))+"]":"");
        var userMsg = new AssistantMessageModel
        {
            Id = Guid.NewGuid(), ConversationId = conv.Id, Role = "user", Text = text,
            Blocks = files.Count>0?new JsonArray(new JsonObject{["type"]="files",["items"]=files}).ToJsonString():"[]",
            ModelContent = JsonSerializer.Serialize(new object[] { new { role = "user", content = modelText } }),
            UploadIds = JsonSerializer.Serialize(ownedIds), Status = "done", Mode = "", CreatedAt = now,
        };
        await dal.InsertMessageAsync(userMsg);
        string? title = null;
        if (conv.Title is "" or "New chat")
        {
            var t = string.Join(' ', text.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            title = t.Length > 60 ? t[..60] : t;
            if (title.Length == 0) title = "New chat";
        }
        if (title is not null || page is not null)
            await dal.TouchForAskAsync(conv.Id, title, page?.ToJsonString(), now);
        var replyId = Guid.NewGuid();
        const string mode = "sandbox";
        var dec = AssistantDecision.Decide(text, cfg["decision"] as JsonObject ?? new JsonObject(), names,ownedIds.Count>0);
        yield return new JsonObject
        {
            ["type"] = "start", ["user_message_id"] = userMsg.Id.ToString(), ["message_id"] = replyId.ToString(),
            ["conversation_id"] = conv.Id.ToString(), ["title"] = title ?? conv.Title, ["mode"] = mode,
        };
        var decEvent = dec.AsDict();
        decEvent["type"] = "decision";
        yield return decEvent;

        var shareContacts = cfg["share_contact_details"]?.GetValue<bool>() ?? false;
        var ctx = new AssistantToolsBAL.AssistantToolContext(user.Id, perms, conv.Id, shareContacts, ownedIds);
        var state = new TurnState();
        var status = "done";

        // Live branch: fail closed. The LLM router is not ported in this build, so a live model answer can
        // never be produced; sandbox is the only mode and never touches an external provider.
        JsonObject? errorEvent = null;
        await using var enumerator = SandboxTurnAsync(ctx, names, text, state, cancellationToken).GetAsyncEnumerator(cancellationToken);
        while (true)
        {
            JsonObject ev;
            try
            {
                if (!await enumerator.MoveNextAsync()) break;
                ev = enumerator.Current;
            }
            catch (OperationCanceledException)
            {
                status = "stopped";
                throw;
            }
            catch (AppException exc)
            {
                status = "error";
                state.ReplyText = (state.ReplyText.Length > 0 ? state.ReplyText + "\n\n" : "") + exc.Message;
                state.Blocks.Add(new JsonObject { ["type"] = "error", ["text"] = exc.Message });
                errorEvent = new JsonObject { ["type"] = "error", ["message"] = exc.Message, ["code"] = exc.Code };
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "assistant turn failed");
                status = "error";
                const string msg = "Something went wrong while answering. Please try again.";
                state.Blocks.Add(new JsonObject { ["type"] = "error", ["text"] = msg });
                errorEvent = new JsonObject { ["type"] = "error", ["message"] = msg };
                break;
            }
            yield return ev;
        }
        if (errorEvent is not null)
            yield return errorEvent;

        var reply = new AssistantMessageModel
        {
            Id = replyId, ConversationId = conv.Id, Role = "assistant", Text = state.ReplyText,
            Blocks = Compact(state.Blocks).ToJsonString(),
            ModelContent = JsonSerializer.Serialize(new object[]
            {
                new { role = "assistant", content = new object[] { new { type = "text", text = state.ReplyText.Length > 0 ? state.ReplyText : "(no answer)" } } },
            }),
            UploadIds = "[]", Status = status, Mode = mode, CreatedAt = DateTimeFunctions.UtcNow(),
        };
        await dal.InsertMessageAsync(reply);
        if (status == "done")
            yield return new JsonObject
            {
                ["type"] = "done", ["message"] = MessageOut(reply), ["model"] = "sandbox",
                ["usage"] = new JsonObject { ["input_tokens"] = 0, ["output_tokens"] = 0 },
            };
    }

    /// <summary>Reference: agent.run sandbox branch — sandbox.choose, run the picked tools, then sandbox.reply.</summary>
    private async IAsyncEnumerable<JsonObject> SandboxTurnAsync(
        AssistantToolsBAL.AssistantToolContext ctx, HashSet<string> names, string text, TurnState state,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var (d, calls) = AssistantSandbox.Choose(text, names, ctx.UploadIds.Count>0);
        var results = new List<(string Name, JsonNode? Data)>();
        foreach (var (name, args) in calls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return new JsonObject
            {
                ["type"] = "tool", ["name"] = name,
                ["label"] = AssistantTools.ByName.TryGetValue(name, out var def) ? def.Label : "Working",
            };
            var (output, _) = await tools.ExecuteAsync(ctx, name, args);
            results.Add((name, output.Data));
            foreach (var card in output.Cards)
            {
                state.Blocks.Add(card);
                yield return new JsonObject { ["type"] = "card", ["card"] = card.DeepClone() };
            }
        }
        var answer = AssistantSandbox.Reply(d, results);
        state.ReplyText = answer;
        state.Blocks.Add(new JsonObject { ["type"] = "text", ["text"] = answer });
        yield return new JsonObject { ["type"] = "text", ["delta"] = answer };
    }

    /// <summary>Reference: agent._compact — merges neighbouring text blocks so the saved message reads as it streamed.</summary>
    private static JsonArray Compact(List<JsonObject> blocks)
    {
        var outBlocks = new JsonArray();
        foreach (var b in blocks)
        {
            if (b["type"]?.GetValue<string>() == "text" && outBlocks.LastOrDefault() is JsonObject last &&
                last["type"]?.GetValue<string>() == "text")
            {
                last["text"] = last["text"]!.GetValue<string>() + b["text"]!.GetValue<string>();
            }
            else
            {
                outBlocks.Add(b.DeepClone());
            }
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
