using System.Text.Json.Nodes;
using API.Helpers;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.AI;
using Utils;

namespace API.Controllers;

/// <summary>
/// Admin AI assistant API: chats (streamed as server-sent events), file uploads, confirm-before-run actions, downloads,
/// memory, settings, and the AI providers (LLM connections and fallback routes). Permissions: assistant (chat),
/// assistant_files, assistant_actions, assistant_voice; settings for assistant settings; ai_providers for keys.
/// </summary>
[ApiController]
public class AssistantController(IAssistantBAL assistant, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/admin/assistant/status"), Perm("assistant")]
    public async Task<JsonObject> Status() => await assistant.StatusAsync(await me.RequireAsync());

    [HttpGet("/api/admin/assistant/settings"), Perm("settings")]
    public Task<JsonObject> GetSettings() => assistant.GetSettingsAsync();

    [HttpPut("/api/admin/assistant/settings"), Perm("settings")]
    public async Task<JsonObject> PutSettings([FromBody] JsonObject body) => await assistant.PutSettingsAsync(body, await me.RequireAsync());

    [HttpPost("/api/admin/assistant/decision-test"), Perm("settings")]
    public Task<JsonObject> DecisionTest(AssistantDecisionTestIn body) => assistant.DecisionTestAsync(body.Text);

    // ---------------------------------------------------------------- conversations

    [HttpGet("/api/admin/assistant/conversations"), Perm("assistant")]
    public async Task<JsonObject> Conversations([FromQuery] bool archived = false, [FromQuery] string q = "") =>
        await assistant.ConversationsAsync(await me.RequireAsync(), archived, q ?? "");

    [HttpPost("/api/admin/assistant/conversations"), Perm("assistant")]
    public async Task<IActionResult> CreateConversation(AssistantConversationIn? body) =>
        StatusCode(201, await assistant.CreateConversationAsync(await me.RequireAsync(), body ?? new AssistantConversationIn()));

    [HttpPatch("/api/admin/assistant/conversations/{convId}"), Perm("assistant")]
    public async Task<JsonObject> PatchConversation(string convId, AssistantConversationPatch body) =>
        await assistant.PatchConversationAsync(await me.RequireAsync(), AiHttp.Id(convId, "conv_id"), body);

    [HttpDelete("/api/admin/assistant/conversations/{convId}"), Perm("assistant")]
    public async Task<object> DeleteConversation(string convId)
    {
        await assistant.DeleteConversationAsync(await me.RequireAsync(), AiHttp.Id(convId, "conv_id"));
        return new { ok = true };
    }

    [HttpGet("/api/admin/assistant/conversations/{convId}"), Perm("assistant")]
    public async Task<JsonObject> Conversation(string convId) => await assistant.ConversationAsync(await me.RequireAsync(), AiHttp.Id(convId, "conv_id"));

    /// <summary>One question; the answer streams as server-sent events (start, decision, tool, card, text, done | error).</summary>
    [HttpPost("/api/admin/assistant/conversations/{convId}/messages"), Perm("assistant")]
    public async Task Ask(string convId, AssistantAskIn body)
    {
        var user = await me.RequireAsync();
        var id = AiHttp.Id(convId, "conv_id");
        await assistant.PrepareAskAsync(user, id, body);
        var emit = AiHttp.StartSse(Response, "no-store", noSniff: true);
        await assistant.AskAsync(user, id, body, emit, HttpContext.RequestAborted);
    }

    // ---------------------------------------------------------------- uploads

    [HttpPost("/api/admin/assistant/uploads"), Perm("assistant_files")]
    public async Task<IActionResult> Upload(IFormFile? file)
    {
        if (file is null)
            throw new AppException("File: Field required", "validation_error", 422, new Dictionary<string, string> { ["file"] = "Field required" });
        using var ms = new MemoryStream();
        await file.OpenReadStream().CopyToAsync(ms);
        return StatusCode(201, await assistant.UploadAsync(await me.RequireAsync(), file.FileName ?? "file", file.ContentType ?? "", ms.ToArray()));
    }

    [HttpDelete("/api/admin/assistant/uploads/{uploadId}"), Perm("assistant_files")]
    public async Task<object> DeleteUpload(string uploadId)
    {
        await assistant.DeleteUploadAsync(await me.RequireAsync(), AiHttp.Id(uploadId, "upload_id"));
        return new { ok = true };
    }

    // ---------------------------------------------------------------- actions

    [HttpPost("/api/admin/assistant/actions/{actionId}/{decision}"), Perm("assistant_actions")]
    public async Task<JsonObject> DecideAction(string actionId, string decision) =>
        await assistant.DecideActionAsync(await me.RequireAsync(), AiHttp.Id(actionId, "action_id"), AiHttp.Choice(decision, "decision_", "confirm", "cancel"));

    // ---------------------------------------------------------------- downloads and memory

    [HttpGet("/api/admin/assistant/messages/{messageId}/download.{fmt}"), Perm("assistant")]
    public async Task<IActionResult> DownloadMessage(string messageId, string fmt)
    {
        var (data, type, name) = await assistant.DownloadMessageAsync(await me.RequireAsync(), AiHttp.Id(messageId, "message_id"), fmt);
        Response.Headers.CacheControl = "no-store";
        Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
        return File(data, type);
    }

    [HttpGet("/api/admin/assistant/conversations/{convId}/download.{fmt}"), Perm("assistant")]
    public async Task<IActionResult> DownloadConversation(string convId, string fmt)
    {
        var (data, type, name) = await assistant.DownloadConversationAsync(await me.RequireAsync(), AiHttp.Id(convId, "conv_id"), fmt);
        Response.Headers.CacheControl = "no-store";
        Response.Headers.ContentDisposition = $"attachment; filename=\"{name}\"";
        return File(data, type);
    }

    [HttpGet("/api/admin/assistant/memory"), Perm("assistant")]
    public async Task<JsonObject> Memory() => await assistant.MemoryAsync(await me.RequireAsync());

    [HttpPut("/api/admin/assistant/memory"), Perm("assistant")]
    public async Task<JsonObject> PutMemory(AssistantMemoryIn body) => await assistant.PutMemoryAsync(await me.RequireAsync(), body.Notes);

    // ---------------------------------------------------------------- AI providers

    [HttpGet("/api/admin/ai-providers"), Perm("ai_providers")]
    public Task<JsonObject> Providers() => assistant.ProvidersAsync();

    [HttpPost("/api/admin/ai-providers/connections"), Perm("ai_providers")]
    public async Task<IActionResult> AddConnection(LlmConnectionIn body) => StatusCode(201, await assistant.AddConnectionAsync(body, await me.RequireAsync()));

    [HttpPut("/api/admin/ai-providers/connections/{connId}"), Perm("ai_providers")]
    public async Task<JsonObject> EditConnection(string connId, LlmConnectionIn body) => await assistant.EditConnectionAsync(connId, body, await me.RequireAsync());

    [HttpDelete("/api/admin/ai-providers/connections/{connId}"), Perm("ai_providers")]
    public async Task<JsonObject> RemoveConnection(string connId) => await assistant.RemoveConnectionAsync(connId, await me.RequireAsync());

    [HttpPost("/api/admin/ai-providers/connections/{connId}/test"), Perm("ai_providers")]
    public async Task<JsonObject> TestConnection(string connId, LlmTestIn? body) => await assistant.TestConnectionAsync(connId, body?.Model ?? "", await me.RequireAsync());

    [HttpPut("/api/admin/ai-providers/routes"), Perm("ai_providers")]
    public async Task<JsonObject> PutRoutes(LlmRoutesIn body) => await assistant.PutRoutesAsync(body, await me.RequireAsync());
}
