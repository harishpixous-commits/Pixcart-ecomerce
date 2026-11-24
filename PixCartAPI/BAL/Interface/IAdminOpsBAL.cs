using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Cross-module staff operations (reference: routers/admin.py order, refund, customer and settings
/// endpoints).</summary>
public interface IAdminOpsBAL
{
    /// <summary>Cancel a package as staff (reference: POST /api/admin/sub-orders/{sub_id}/cancel).</summary>
    Task<JsonObject> CancelSubOrderAsync(UserModel admin, Guid subId, string reason);

    /// <summary>Mark a package delivered as staff (reference: POST /api/admin/sub-orders/{sub_id}/deliver).</summary>
    Task<JsonObject> DeliverSubOrderAsync(UserModel admin, Guid subId);

    /// <summary>Refund list with order numbers (reference: GET /api/admin/refunds).</summary>
    Task<JsonObject> ListRefundsAsync(UserModel admin, string? status, string q, int page);

    /// <summary>Requeue a failed refund (reference: POST /api/admin/refunds/{refund_id}/retry).</summary>
    Task<JsonObject> RetryRefundAsync(UserModel admin, Guid refundId);

    /// <summary>Record a refund paid outside the gateway (reference: POST /api/admin/refunds/{refund_id}/settle).</summary>
    Task<JsonObject> SettleRefundAsync(UserModel admin, Guid refundId, string method, string refInput);

    /// <summary>Block a customer and revoke their sessions (reference: POST /api/admin/customers/{user_id}/block).</summary>
    Task<JsonObject> BlockUserAsync(UserModel admin, Guid userId, string reason);

    /// <summary>Unblock a customer (reference: POST /api/admin/customers/{user_id}/unblock).</summary>
    Task<JsonObject> UnblockUserAsync(UserModel admin, Guid userId);

    /// <summary>Current platform settings (reference: GET /api/admin/settings).</summary>
    Task<JsonObject> ReadSettingsAsync(UserModel admin);

    /// <summary>Merge platform setting updates (reference: PUT /api/admin/settings).</summary>
    Task<JsonObject> WriteSettingsAsync(UserModel admin, JsonObject body);
}
