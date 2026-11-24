using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.AI;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The staff assistant's settings, status, memory and conversations (reference: routers/assistant.py — same
/// paths and payloads). The chat engine (ask, uploads, actions, downloads) is a later slice; until it lands the
/// assistant answers in sandbox mode only.
/// </summary>
[ApiController]
[Route("/api/admin")]
[SignedIn]
public class AdminAssistantController(IAssistantBAL assistant, IAccessBAL access, ICurrentUser current, BAL.AssistantAskBAL ask, BAL.Interface.IRateLimitBAL rateLimit, BAL.AssistantActionsBAL actions,
    ILlmConfigBAL llmConfig, ILlmRouterBAL llmRouter, AuditDAL audit) : ControllerBase
{
    private async Task<UserModel> RequireAsync(string permission)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, permission);
        return user;
    }

    /// <summary>What the assistant can do for this staff member (reference: GET /api/admin/assistant/status).</summary>
    [HttpGet("assistant/status")]
    public async Task<JsonObject> Status() => await assistant.StatusAsync(await RequireAsync("assistant"));

    /// <summary>Assistant settings with language and tool/action metadata (reference: GET /api/admin/assistant/settings).</summary>
    [HttpGet("assistant/settings")]
    public async Task<JsonObject> GetSettings()
    {
        await RequireAsync("settings");
        return await assistant.SettingsPayloadAsync();
    }

    /// <summary>Save assistant settings (reference: PUT /api/admin/assistant/settings; password/totp step-up for Laya changes).</summary>
    [HttpPut("assistant/settings")]
    public async Task<JsonObject> PutSettings([FromBody] JsonObject body) =>
        await assistant.SaveSettingsAsync(await RequireAsync("settings"), body ?? new JsonObject());

    /// <summary>Dry-run the decision layer (reference: POST /api/admin/assistant/decision-test).</summary>
    [HttpPost("assistant/decision-test")]
    public async Task<JsonObject> DecisionTest(AssistantDecisionTestIn body)
    {
        await RequireAsync("settings");
        return await assistant.DecisionTestAsync(body.Text);
    }

    /// <summary>The staff member's memory notes (reference: GET /api/admin/assistant/memory).</summary>
    [HttpGet("assistant/memory")]
    public async Task<JsonObject> GetMemory() => await assistant.GetMemoryAsync(await RequireAsync("assistant"));

    /// <summary>Replace the memory notes (reference: PUT /api/admin/assistant/memory).</summary>
    [HttpPut("assistant/memory")]
    public async Task<JsonObject> PutMemory(AssistantMemoryIn body) =>
        await assistant.PutMemoryAsync(await RequireAsync("assistant"), body.Notes ?? new JsonArray());

    /// <summary>List conversations (reference: GET /api/admin/assistant/conversations).</summary>
    [HttpGet("assistant/conversations")]
    public async Task<JsonObject> ListConversations([FromQuery] bool archived = false,
        [FromQuery, MaxLength(60)] string q = "") =>
        await assistant.ListConversationsAsync(await RequireAsync("assistant"), archived, q);

    /// <summary>New conversation (reference: POST /api/admin/assistant/conversations; 201).</summary>
    [HttpPost("assistant/conversations")]
    public async Task<IActionResult> CreateConversation(AssistantConvIn body)
    {
        var out_ = await assistant.CreateConversationAsync(await RequireAsync("assistant"), body.Title, body.Context);
        return StatusCode(201, out_);
    }

    /// <summary>Rename or archive (reference: PATCH /api/admin/assistant/conversations/{conv_id}).</summary>
    [HttpPatch("assistant/conversations/{convId:guid}")]
    public async Task<JsonObject> PatchConversation(Guid convId, AssistantConvPatch body) =>
        await assistant.PatchConversationAsync(await RequireAsync("assistant"), convId, body.Title, body.Archived);

    /// <summary>Delete a conversation (reference: DELETE /api/admin/assistant/conversations/{conv_id}).</summary>
    [HttpDelete("assistant/conversations/{convId:guid}")]
    public async Task<JsonObject> DeleteConversation(Guid convId) =>
        await assistant.DeleteConversationAsync(await RequireAsync("assistant"), convId);

    /// <summary>A conversation with its messages (reference: GET /api/admin/assistant/conversations/{conv_id}).</summary>
    [HttpGet("assistant/conversations/{convId:guid}")]
    public async Task<JsonObject> GetConversation(Guid convId) =>
        await assistant.GetConversationAsync(await RequireAsync("assistant"), convId);

    /// <summary>
    /// Ask the assistant; the answer streams back as server-sent events (reference: POST
    /// /api/admin/assistant/conversations/{conv_id}/messages). Sandbox mode only: no external model is ever called.
    /// </summary>
    [HttpPost("assistant/conversations/{convId:guid}/messages")]
    public async Task Ask(Guid convId, AssistantAskIn body, CancellationToken cancellationToken)
    {
        var user = await RequireAsync("assistant");
        var cfg = await assistant.ConfigForRunAsync();
        if (cfg["enabled"]?.GetValue<bool>() != true)
            throw new AppException("The AI assistant is switched off. An admin can turn it on in Admin → AI assistant.", "assistant_off", 409);
        var perms = await access.PermissionsForAsync(user);
        if (body.UploadIds is { Count: > 0 } && !perms.Contains("assistant_files"))
            throw new ForbiddenException("Your role cannot share files with the assistant (assistant_files)");
        if (body.Voice && !perms.Contains("assistant_voice"))
            throw new ForbiddenException("Your role cannot use voice (assistant_voice)");
        await rateLimit.RateLimitAsync($"assistant:{user.Id}", 120, 3600);
        JsonObject? page = null;
        if (body.Page is not null)
        {
            page = new JsonObject();
            foreach (var key in new[] { "path", "title", "filters" })
                if (body.Page[key]?.GetValue<string>() is { } v)
                    page[key] = v.Length > 300 ? v[..300] : v;
            if (page.Count == 0) page = null;
        }
        Response.StatusCode = 200;
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-store";
        Response.Headers["X-Accel-Buffering"] = "no";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        await Response.Body.FlushAsync(cancellationToken);
        await foreach (var ev in ask.AskEventsAsync(user, convId, body.Text.Trim(), page, body.Voice, cancellationToken,body.UploadIds))
        {
            var line = "data: " + ev.ToJsonString() + "\n\n";
            await Response.Body.WriteAsync(System.Text.Encoding.UTF8.GetBytes(line), cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }
    }
    /// <summary>Confirm or cancel a proposed change (reference: POST /api/admin/assistant/actions/{action_id}/{decision_}).</summary>
    [HttpPost("assistant/actions/{actionId:guid}/{decision}")]
    public async Task<JsonObject> DecideAction(Guid actionId, string decision)
    {
        if (decision is not ("confirm" or "cancel"))
            throw new AppException("decision must be confirm or cancel", "validation", 422);
        return await actions.DecideAsync(await current.RequireAsync(), actionId, decision);
    }

    // ----------------------------------------------------------------------------- AI providers
    // (reference: routers/assistant.py ai-providers endpoints — same paths, payload shape and audit entries)

    private async Task AuditAsync(UserModel user, string action, string entityId, string detail = "") =>
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = user.Id, Action = action, EntityType = "ai_provider",
            EntityId = entityId, Detail = detail, CreatedAt = DateTimeFunctions.UtcNow(),
        });

    /// <summary>The LLM connections, key health and fallback routes (reference: GET /api/admin/ai-providers).</summary>
    [HttpGet("ai-providers")]
    public async Task<JsonObject> Providers()
    {
        await RequireAsync("ai_providers");
        return await llmConfig.ViewAsync();
    }

    /// <summary>Add a connection (reference: POST /api/admin/ai-providers/connections; 201 with the updated view).</summary>
    [HttpPost("ai-providers/connections")]
    public async Task<IActionResult> AddConnection([FromBody] JsonObject body)
    {
        var user = await RequireAsync("ai_providers");
        JsonObject rec;
        try { rec = await llmConfig.SaveConnectionAsync(body ?? new JsonObject(), null); }
        catch (LlmConfigException e) { throw new AppException(e.Message, "invalid_connection", 400); }
        await AuditAsync(user, "ai_provider.create", rec["id"]!.GetValue<string>(),
            $"{rec["type"]!.GetValue<string>()} {rec["name"]!.GetValue<string>()} keys={(rec["keys"] as JsonArray)?.Count ?? 0}");
        return StatusCode(201, await llmConfig.ViewAsync());
    }

    /// <summary>Edit a connection (reference: PUT /api/admin/ai-providers/connections/{conn_id}; the built-in is edited in Integrations).</summary>
    [HttpPut("ai-providers/connections/{connId}")]
    public async Task<JsonObject> EditConnection(string connId, [FromBody] JsonObject body)
    {
        var user = await RequireAsync("ai_providers");
        if (connId == LlmConfigBAL.BuiltinId)
            throw new AppException("This connection uses the Claude key from Integrations; change it there.", "builtin_connection", 400);
        JsonObject rec;
        try { rec = await llmConfig.SaveConnectionAsync(body ?? new JsonObject(), connId); }
        catch (LlmConfigException e) { throw new AppException(e.Message, "invalid_connection", 400); }
        var added = (body?["add_keys"] as JsonArray)?.Count ?? 0;
        var removed = (body?["remove_keys"] as JsonArray)?.Count ?? 0;
        await AuditAsync(user, "ai_provider.update", connId,
            $"keys added={added} removed={removed} models={(rec["models"] as JsonArray)?.Count ?? 0}");
        return await llmConfig.ViewAsync();
    }

    /// <summary>Delete a connection (reference: DELETE /api/admin/ai-providers/connections/{conn_id}).</summary>
    [HttpDelete("ai-providers/connections/{connId}")]
    public async Task<JsonObject> RemoveConnection(string connId)
    {
        var user = await RequireAsync("ai_providers");
        await llmConfig.DeleteConnectionAsync(connId);
        await AuditAsync(user, "ai_provider.delete", connId);
        return await llmConfig.ViewAsync();
    }

    /// <summary>Live-test one connection/model (reference: POST /api/admin/ai-providers/connections/{conn_id}/test; rate-limited 30 per 10 minutes).</summary>
    [HttpPost("ai-providers/connections/{connId}/test")]
    public async Task<JsonObject> TestConnection(string connId, AiProviderTestIn body)
    {
        var user = await RequireAsync("ai_providers");
        await rateLimit.RateLimitAsync($"llm-test:{user.Id}", 30, 600);
        var conn = (await llmConfig.ConnectionsAsync()).FirstOrDefault(c => c.Id == connId) ?? throw new NotFoundException("Connection");
        var model = body.Model ?? (conn.Models.Count > 0 ? conn.Models[0] : "");
        var (ok, message, latency) = await llmRouter.TestTargetAsync(conn, model);
        if (connId != LlmConfigBAL.BuiltinId) await llmConfig.RecordTestAsync(connId, ok, message);
        await AuditAsync(user, "ai_provider.test", connId, ok ? "ok" : "failed");
        return new JsonObject { ["ok"] = ok, ["message"] = message, ["latency_ms"] = latency };
    }

    /// <summary>Replace the fallback routes (reference: PUT /api/admin/ai-providers/routes).</summary>
    [HttpPut("ai-providers/routes")]
    public async Task<JsonObject> PutRoutes([FromBody] JsonObject body)
    {
        var user = await RequireAsync("ai_providers");
        var routes = body?["routes"] as JsonObject ?? new JsonObject();
        try { await llmConfig.SaveRoutesAsync(routes); }
        catch (LlmConfigException e) { throw new AppException(e.Message, "invalid_routes", 400); }
        await AuditAsync(user, "ai_provider.routes", "routes", string.Join(", ", routes.Select(r => $"{r.Key}:{(r.Value as JsonArray)?.Count ?? 0}")));
        return await llmConfig.ViewAsync();
    }

}

/// <summary>Reference: routers/assistant.py AskIn.</summary>
public sealed record AssistantAskIn(
    [param: MinLength(1), MaxLength(8000)] string Text,
    [param: MaxLength(5)] List<string>? UploadIds = null,
    JsonObject? Page = null,
    bool Voice = false);

/// <summary>Reference: routers/assistant.py ConvIn.</summary>
public sealed record AssistantConvIn([param: MaxLength(120)] string Title = "New chat", JsonObject? Context = null);

/// <summary>Reference: routers/assistant.py ConvPatch.</summary>
public sealed record AssistantConvPatch([param: MinLength(1), MaxLength(120)] string? Title = null, bool? Archived = null);

/// <summary>Reference: routers/assistant.py DecisionTest.</summary>
public sealed record AssistantDecisionTestIn([param: MinLength(1), MaxLength(2000)] string Text);

/// <summary>Reference: routers/assistant.py MemoryIn.</summary>
public sealed record AssistantMemoryIn(JsonArray? Notes = null);

/// <summary>Reference: routers/assistant.py TestIn (ai-providers connection test).</summary>
public sealed record AiProviderTestIn([param: MaxLength(120)] string? Model = null);
