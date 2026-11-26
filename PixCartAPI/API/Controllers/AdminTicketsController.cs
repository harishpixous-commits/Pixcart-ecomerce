using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>Admin support desk (reference: routers/admin_extras.py ticket/staff_reply).</summary>
[ApiController]
[Route("api/admin/tickets")]
public class AdminTicketsController(ISupportDeskBAL bal, ICurrentUser current) : ControllerBase
{
    private static readonly HashSet<string> Statuses = ["open", "awaiting_customer", "resolved", "closed"];
    private static readonly HashSet<string> Priorities = ["low", "normal", "high", "urgent"];

    /// <summary>Ticket with messages and customer (reference: GET /api/admin/tickets/{ticket_id}).</summary>
    [HttpGet("{ticket_id}")]
    public async Task<JsonObject> Get(Guid ticket_id) =>
        await bal.GetAsync(await current.RequireAsync(), ticket_id);

    /// <summary>Staff reply or internal note (reference: POST /api/admin/tickets/{ticket_id}/reply).</summary>
    [HttpPost("{ticket_id}/reply")]
    [Consumes("application/json")]
    public async Task<JsonObject> Reply(Guid ticket_id, [FromBody] StaffReplyIn body)
    {
        if (body.Status is not null && !Statuses.Contains(body.Status))
            throw new AppException("Invalid ticket status", "validation_error", 422);
        if (body.Priority is not null && !Priorities.Contains(body.Priority))
            throw new AppException("Invalid ticket priority", "validation_error", 422);
        return await bal.ReplyAsync(await current.RequireAsync(), ticket_id, body.Body, body.Internal,
            body.Status, body.Priority, body.AiRunId);
    }
}

/// <summary>Reference: StaffReply.</summary>
public sealed record StaffReplyIn(
    [property: Required, MinLength(1), MaxLength(5000)] string Body,
    bool Internal,
    string? Status,
    string? Priority,
    [property: MaxLength(40)] string? AiRunId)
{
    public StaffReplyIn()
        : this("", false, null, null, null)
    {
    }
}
