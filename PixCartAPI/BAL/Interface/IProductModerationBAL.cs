using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Staff product moderation (reference: routers/admin.py product endpoints).</summary>
public interface IProductModerationBAL
{
    /// <summary>The staff listing detail (reference: seller_products.product_detail).</summary>
    Task<JsonObject> DetailAsync(ProductModel p);

    /// <summary>Approve a pending listing (reference: POST /api/admin/products/{product_id}/approve).</summary>
    Task<JsonObject> ApproveAsync(UserModel admin, Guid productId);

    /// <summary>Reject a pending listing or take down a live one (reference: POST /api/admin/products/{product_id}/reject).</summary>
    Task<JsonObject> RejectAsync(UserModel admin, Guid productId, string reason);
}
