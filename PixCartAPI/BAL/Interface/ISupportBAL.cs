using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Customer-side support tickets (reference: routers/customer.py support_* + services/support.py).</summary>
public interface ISupportBAL
{
    /// <summary>Reference: support_categories.</summary>
    JsonObject Categories();

    /// <summary>Reference: my_tickets — newest updates first, max 100.</summary>
    Task<JsonObject> MyTicketsAsync(Guid userId);

    /// <summary>Reference: open_ticket + services/support.py create_ticket.</summary>
    Task<JsonObject> OpenTicketAsync(Guid userId, string category, string subject, string message, Guid? orderId, bool isGrievance);

    /// <summary>Reference: get_ticket — the customer sees non-internal messages only.</summary>
    Task<JsonObject> GetTicketAsync(Guid userId, Guid ticketId);

    /// <summary>Reference: reply_ticket.</summary>
    Task<JsonObject> ReplyAsync(Guid userId, Guid ticketId, string body);

    /// <summary>Reference: close_ticket.</summary>
    Task<JsonObject> CloseAsync(Guid userId, Guid ticketId);
}
