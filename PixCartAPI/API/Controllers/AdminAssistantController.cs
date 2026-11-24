using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
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
public class AdminAssistantController(IAssistantBAL assistant, IAccessBAL access, ICurrentUser current) : ControllerBase
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
}

/// <summary>Reference: routers/assistant.py ConvIn.</summary>
public sealed record AssistantConvIn([param: MaxLength(120)] string Title = "New chat", JsonObject? Context = null);

/// <summary>Reference: routers/assistant.py ConvPatch.</summary>
public sealed record AssistantConvPatch([param: MinLength(1), MaxLength(120)] string? Title = null, bool? Archived = null);

/// <summary>Reference: routers/assistant.py DecisionTest.</summary>
public sealed record AssistantDecisionTestIn([param: MinLength(1), MaxLength(2000)] string Text);

/// <summary>Reference: routers/assistant.py MemoryIn.</summary>
public sealed record AssistantMemoryIn(JsonArray? Notes = null);
