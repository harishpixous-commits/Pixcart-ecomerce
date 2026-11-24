using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Customer-side support tickets (reference: routers/customer.py support_*).</summary>
[ApiController]
[Route("/api/support")]
[SignedIn]
public class SupportController(ISupportBAL bal, ICurrentUser current) : ControllerBase
{
    [HttpGet("categories")]
    public JsonObject Categories() => bal.Categories();

    [HttpGet("tickets")]
    public async Task<JsonObject> MyTickets() => await bal.MyTicketsAsync((await current.RequireAsync()).Id);

    [HttpPost("tickets")]
    public async Task<JsonObject> Open([FromBody] TicketIn body) =>
        await bal.OpenTicketAsync((await current.RequireAsync()).Id, body.Category, body.Subject, body.Message,
            body.OrderId, body.IsGrievance);

    [HttpGet("tickets/{ticketId:guid}")]
    public async Task<JsonObject> Get(Guid ticketId) =>
        await bal.GetTicketAsync((await current.RequireAsync()).Id, ticketId);

    [HttpPost("tickets/{ticketId:guid}/messages")]
    public async Task<JsonObject> Reply(Guid ticketId, [FromBody] MessageIn body) =>
        await bal.ReplyAsync((await current.RequireAsync()).Id, ticketId, body.Body);

    [HttpPost("tickets/{ticketId:guid}/close")]
    public async Task<JsonObject> Close(Guid ticketId) =>
        await bal.CloseAsync((await current.RequireAsync()).Id, ticketId);

    /// <summary>Reference: TicketIn.</summary>
    public class TicketIn
    {
        [Required]
        public string Category { get; set; } = "";
        [Required, StringLength(200, MinimumLength = 1)]
        public string Subject { get; set; } = "";
        [Required, StringLength(5000, MinimumLength = 1)]
        public string Message { get; set; } = "";
        public Guid? OrderId { get; set; }
        public bool IsGrievance { get; set; }
    }

    /// <summary>Reference: MessageIn.</summary>
    public class MessageIn
    {
        [Required, StringLength(5000, MinimumLength = 1)]
        public string Body { get; set; } = "";
    }
}
