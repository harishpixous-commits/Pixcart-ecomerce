using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>The cart and "Saved for later" (reference: routers/cart.py plus the cart parts of services/orders.py).</summary>
public interface ICartBAL
{
    /// <summary>The full cart view (groups, summary with fees, hints, checkout options).</summary>
    Task<JsonObject> ViewAsync(Guid userId);

    /// <summary>The cart lines with availability problems and buy limits filled in (reference: load_cart).</summary>
    Task<List<CartBAL.CartLine>> LoadCartAsync(Guid userId);

    /// <summary>Puts the quantity in the cart, lowered to what can be bought; returns the note when it was lowered.</summary>
    Task<string> SetAsync(Guid userId, Guid variantId, int qty, bool add = false);

    /// <summary>Moves a signed-out (browser) cart into the account after login; unavailable items are skipped.</summary>
    Task<JsonObject> MergeAsync(Guid userId, IReadOnlyList<(Guid VariantId, int Qty)> items);

    /// <summary>The saved lines for the view.</summary>
    Task<JsonObject> SavedViewAsync(Guid userId);

    /// <summary>Moves a cart line to "Saved for later".</summary>
    Task<JsonObject> SaveForLaterAsync(Guid userId, Guid variantId);

    /// <summary>Moves a saved line back into the cart.</summary>
    Task<JsonObject> MoveToCartAsync(Guid userId, Guid variantId);

    /// <summary>Forgets a saved line.</summary>
    Task<JsonObject> DeleteSavedAsync(Guid userId, Guid variantId);
}
