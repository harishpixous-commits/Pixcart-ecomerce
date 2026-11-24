using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Staff seller KYC operations (reference: routers/admin.py seller endpoints).</summary>
public interface ISellerModerationBAL
{
    /// <summary>Seller profile with owner and product counts (reference: GET /api/admin/sellers/{seller_id}).</summary>
    Task<JsonObject> GetAsync(UserModel admin, Guid sellerId);

    /// <summary>Approve a submitted, suspended or rejected seller (reference: POST /api/admin/sellers/{seller_id}/approve).</summary>
    Task<JsonObject> ApproveAsync(UserModel admin, Guid sellerId);

    /// <summary>Send the application back to the seller (reference: POST /api/admin/sellers/{seller_id}/reject).</summary>
    Task<JsonObject> RejectAsync(UserModel admin, Guid sellerId, string reason);

    /// <summary>Suspend an approved seller (reference: POST /api/admin/sellers/{seller_id}/suspend).</summary>
    Task<JsonObject> SuspendAsync(UserModel admin, Guid sellerId, string reason);

    /// <summary>Set or clear a commission override (reference: PUT /api/admin/sellers/{seller_id}/commission).</summary>
    Task<JsonObject> CommissionAsync(UserModel admin, Guid sellerId, int? bpsOverride);
}
