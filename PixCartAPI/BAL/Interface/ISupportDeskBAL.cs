using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Admin support desk (reference: routers/admin_extras.py ticket/staff_reply).</summary>
public interface ISupportDeskBAL
{
    /// <summary>Ticket with messages and customer (reference: GET /api/admin/tickets/{ticket_id}).</summary>
    Task<JsonObject> GetAsync(UserModel admin, Guid ticketId);
    Task<JsonObject> SatisfactionAsync(UserModel admin);

    /// <summary>Staff reply or internal note (reference: POST /api/admin/tickets/{ticket_id}/reply).</summary>
    Task<JsonObject> ReplyAsync(UserModel admin, Guid ticketId, string body, bool internalNote,
        string? status, string? priority, string? aiRunId);
}
