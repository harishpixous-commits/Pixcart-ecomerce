using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>The shopper's saved products (reference: routers/customer.py wishlist routes).</summary>
public interface IWishlistBAL
{
    Task<JsonObject> ListAsync(Guid userId);
    Task<JsonObject> AddAsync(Guid userId, Guid productId);
    Task<JsonObject> RemoveAsync(Guid userId, Guid productId);
}
