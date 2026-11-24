using System.Text.Json.Nodes;
using API.Helpers;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.AI;

namespace API.Controllers;

/// <summary>AI studio (admin) and AI drafts for staff and sellers. Every draft is reviewed by a person before use.</summary>
[ApiController]
public class AiController(IAiBAL ai, ICurrentUser me) : ControllerBase
{
    // ---------------------------------------------------------------- AI studio (admin)

    [HttpGet("/api/admin/ai"), Perm("settings")]
    public Task<JsonObject> Studio() => ai.StudioAsync();

    [HttpPut("/api/admin/ai"), Perm("settings")]
    public async Task<JsonObject> StudioSave([FromBody] JsonObject body) => await ai.SaveStudioAsync(body, await me.RequireAsync());

    [HttpGet("/api/admin/ai/runs"), Perm("settings")]
    public Task<JsonObject> Runs([FromQuery] string? task = null, [FromQuery] string? status = null, [FromQuery] int page = 1)
    {
        if (page < 1)
            throw new Utils.AppException("Page: Input should be greater than or equal to 1", "validation_error", 422,
                new Dictionary<string, string> { ["page"] = "Input should be greater than or equal to 1" });
        return ai.RunsAsync(task, status, page);
    }

    [HttpGet("/api/admin/ai/runs/{runId}"), Perm("settings")]
    public Task<JsonObject> RunDetail(string runId) => ai.RunDetailAsync(AiHttp.Id(runId, "run_id"));

    [HttpPost("/api/admin/ai/tasks/{task}"), AdminOnly]
    public async Task<JsonObject> AdminRun(string task, AiRunIn body) => await ai.AdminRunAsync(task, body, await me.RequireAsync());

    /// <summary>Sends a reviewed customer message (in-app and email). The final text is what the staff member approved.</summary>
    [HttpPost("/api/admin/ai/runs/{runId}/send"), Perm("orders")]
    public async Task<JsonObject> AdminSend(string runId, AiSendIn body) => await ai.AdminSendAsync(AiHttp.Id(runId, "run_id"), body, await me.RequireAsync());

    [HttpPost("/api/admin/ai/runs/{runId}/{decision}"), AdminOnly]
    public async Task<JsonObject> AdminFinish(string runId, string decision, AiFinishIn? body) =>
        await ai.AdminFinishAsync(AiHttp.Id(runId, "run_id"), AiHttp.Choice(decision, "action", "apply", "discard"), body ?? new AiFinishIn(), await me.RequireAsync());

    [HttpGet("/api/admin/ai/briefs/seller/{sellerId}"), Perm("sellers")]
    public Task<JsonObject> SellerBrief(string sellerId) => ai.SellerBriefAsync(AiHttp.Id(sellerId, "seller_id"));

    [HttpGet("/api/admin/ai/briefs/order/{orderId}"), Perm("orders")]
    public Task<JsonObject> OrderBrief(string orderId) => ai.OrderBriefAsync(AiHttp.Id(orderId, "order_id"));

    // ---------------------------------------------------------------- sellers

    [HttpPost("/api/seller/ai/tasks/{task}"), Seller]
    public async Task<JsonObject> SellerRun(string task, AiRunIn body) => await ai.SellerRunAsync(task, body, await me.RequireSellerAsync(), await me.RequireAsync());

    [HttpPost("/api/seller/ai/runs/{runId}/{decision}"), Seller]
    public async Task<JsonObject> SellerFinish(string runId, string decision, AiFinishIn? body) =>
        await ai.SellerFinishAsync(AiHttp.Id(runId, "run_id"), AiHttp.Choice(decision, "action", "apply", "discard"), body ?? new AiFinishIn(),
            await me.RequireSellerAsync(), await me.RequireAsync());

    /// <summary>Kept for the product editor: the listing writer's fields plus the draft id.</summary>
    [HttpPost("/api/seller/ai/listing"), Seller]
    public async Task<JsonObject> SellerListing(AiRunIn body) => await ai.SellerListingAsync(body, await me.RequireSellerAsync(), await me.RequireAsync());
}
