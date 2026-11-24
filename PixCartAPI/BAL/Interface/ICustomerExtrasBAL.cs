using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>Notifications inbox, read-all and the analytics beacon (reference: routers/customer.py).</summary>
public interface ICustomerExtrasBAL
{
    /// <summary>Reference: my_notifications — the signed-in shopper's in-app inbox, newest first, 20 a page.</summary>
    Task<JsonObject> NotificationsAsync(Guid userId, int page);

    /// <summary>Reference: read_all.</summary>
    Task ReadAllAsync(Guid userId);

    /// <summary>Reference: event — counts a visitor once per 30 minutes per product and type; always quiet.</summary>
    Task EventAsync(string ip, string type, Guid productId);
}
