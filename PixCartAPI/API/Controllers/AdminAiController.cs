using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
using Utils;

namespace API.Controllers;

/// <summary>
/// AI studio and staff AI tasks (reference: routers/ai.py admin routes — same paths, bodies and payloads).
/// The provider call is fail-closed in this environment, so every run is a marked sandbox draft.
/// </summary>
[ApiController]
[Route("/api/admin/ai")]
[SignedIn]
public class AdminAiController(
    IAiBAL ai, IAccessBAL access, ICurrentUser current, INotifyBAL notifier,
    AiDAL aiDal, OrdersDAL orders, AccountDAL accounts, AuditDAL audit) : ControllerBase
{
    /// <summary>Studio home: settings, status, models, this month's usage and per-task stats (reference: GET /api/admin/ai).</summary>
    [HttpGet("")]
    public async Task<JsonObject> Studio()
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "settings");
        return await ai.StudioAsync();
    }

    /// <summary>Save AI settings (reference: PUT /api/admin/ai).</summary>
    [HttpPut("")]
    public async Task<JsonObject> StudioSave([FromBody] JsonObject body)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "settings");
        await ai.SaveSettingsAsync(user, body ?? new JsonObject());
        return await ai.StudioAsync();
    }

    /// <summary>Run history, newest first (reference: GET /api/admin/ai/runs).</summary>
    [HttpGet("runs")]
    public async Task<JsonObject> Runs([FromQuery] string? task, [FromQuery] string? status,
        [FromQuery, Range(1, 100000)] int page = 1)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "settings");
        return await ai.RunsPageAsync(task, status, page);
    }

    /// <summary>One run with its inputs (reference: GET /api/admin/ai/runs/{run_id}).</summary>
    [HttpGet("runs/{runId}")]
    public async Task<JsonObject> RunDetail(Guid runId)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "settings");
        var r = await aiDal.RunByIdAsync(runId) ?? throw new NotFoundException("AI run");
        return ai.RunOut(r, await ai.GetSettingsAsync(), includeInputs: true);
    }

    /// <summary>Run an admin-audience task (reference: POST /api/admin/ai/tasks/{task}).</summary>
    [HttpPost("tasks/{task}")]
    public async Task<JsonObject> RunTask(string task, AiRunIn body)
    {
        var user = await current.RequireAsync();
        if (!AiTasks.Tasks.TryGetValue(task, out var spec) || spec.Audience != "admin")
            throw new NotFoundException("AI task");
        await access.RequireAsync(user, spec.Permission);
        var inputs = await ai.InputsAsync(task, body.Notes, body.CategoryId, body.Brand, body.Tone, body.Intent);
        var (r, _) = await ai.RunAsync(task, user, inputs, body.SubjectId);
        return ai.RunOut(r, await ai.GetSettingsAsync());
    }

    /// <summary>The staff member's own drafts are also gated by the task's permission (reference: _own_admin_run).</summary>
    private async Task<AiRunModel> OwnAdminRunAsync(Guid runId, UserModel user)
    {
        var r = await aiDal.RunByIdAsync(runId);
        if (r is null || r.SellerId is not null)
            throw new NotFoundException("AI draft");
        if (AiTasks.Tasks.TryGetValue(r.Task, out var spec) && spec.Permission.Length > 0)
            await access.RequireAsync(user, spec.Permission);
        return r;
    }

    /// <summary>
    /// Send a reviewed customer message (reference: POST /api/admin/ai/runs/{run_id}/send): in the customer's
    /// notifications and by email. The text sent is exactly what the staff member approved.
    /// </summary>
    [HttpPost("runs/{runId}/send")]
    public async Task<JsonObject> Send(Guid runId, AiSendIn body)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "orders");
        var r = await OwnAdminRunAsync(runId, user);
        if (r.Task != "customer_message" || r.Status != "draft")
            throw new AppException("Only an unsent customer message draft can be sent", "ai_run_closed", 409);
        var order = Guid.TryParse(r.SubjectId, out var oid) ? await orders.GetOrderAsync(oid) : null;
        var customer = order is null ? null : await aiDal.UserBriefAsync(order.UserId);
        if (customer is null || customer.DeletedAt is not null)
            throw new AppException("The customer's account is closed", "customer_gone", 409);
        var subject = body.Subject.Trim();
        var text = body.Text.Trim();
        await notifier.NotifyAsync("staff_message", await accounts.GetUserAsync(customer.Id), new Dictionary<string, object?>
        {
            ["subject"] = subject, ["message"] = text, ["order_number"] = order!.Number,
        }, $"/orders/{order!.Id}", channels: ["inapp", "email"]);
        r = await ai.FinishAsync(runId.ToString(), "sent", user, $"{subject}\n\n{text}") ?? r;
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = user.Id, Action = "ai.customer_message.sent", EntityType = "order",
            EntityId = order.Id.ToString(), Detail = subject[..Math.Min(200, subject.Length)],
            CreatedAt = DateTimeFunctions.UtcNow(),
        });
        return ai.RunOut(r);
    }

    /// <summary>Apply or discard a draft (reference: POST /api/admin/ai/runs/{run_id}/{action}).</summary>
    [HttpPost("runs/{runId}/{act}")]
    public async Task<JsonObject> Finish(Guid runId, string act, AiFinishIn body)
    {
        API.Helpers.PathChoice.Require(act, "action", "apply", "discard");
        var user = await current.RequireAsync();
        await OwnAdminRunAsync(runId, user);
        var r = await ai.FinishAsync(runId.ToString(), act == "apply" ? "applied" : "discarded", user, body.FinalText)
            ?? throw new AppException("This draft was already used or discarded", "ai_run_closed", 409);
        return ai.RunOut(r);
    }

    /// <summary>Deterministic seller risk brief (reference: GET /api/admin/ai/briefs/seller/{seller_id}).</summary>
    [HttpGet("briefs/seller/{sellerId}")]
    public async Task<JsonObject> SellerBrief(Guid sellerId)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "sellers");
        return await ai.SellerRiskAsync(sellerId);
    }

    /// <summary>Deterministic order risk brief (reference: GET /api/admin/ai/briefs/order/{order_id}).</summary>
    [HttpGet("briefs/order/{orderId}")]
    public async Task<JsonObject> OrderBrief(Guid orderId)
    {
        var user = await current.RequireAsync();
        await access.RequireAsync(user, "orders");
        return await ai.OrderRiskAsync(orderId);
    }
}

/// <summary>Reference: routers/ai.py RunIn. An unknown tone falls back to "friendly", as the reference does.</summary>
public sealed record AiRunIn(
    [param: MaxLength(40)] string SubjectId = "",
    [param: MaxLength(10)] string Tone = "friendly",
    [param: MaxLength(300)] string Intent = "",
    [param: MaxLength(4000)] string Notes = "",
    Guid? CategoryId = null,
    [param: MaxLength(80)] string Brand = "");

/// <summary>Reference: routers/ai.py FinishIn.</summary>
public sealed record AiFinishIn([param: MaxLength(10000)] string FinalText = "");

/// <summary>Reference: routers/ai.py SendIn.</summary>
public sealed record AiSendIn(
    [param: MinLength(3), MaxLength(150)] string Subject,
    [param: MinLength(10), MaxLength(2000)] string Text);
