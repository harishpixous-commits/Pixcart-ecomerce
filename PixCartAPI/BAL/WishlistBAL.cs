using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// The wishlist (reference: routers/customer.py wishlist routes): at most 200 saved products; adding the same
/// product twice is a no-op, and removing a product that was never saved is fine.
/// </summary>
public class WishlistBAL(WishlistDAL wishlist, ICatalogBAL catalog) : IWishlistBAL
{
    private const int MaxItems = 200;

    public async Task<JsonObject> ListAsync(Guid userId)
    {
        var products = (await wishlist.ProductsAsync(userId)).ToList();
        var cards = await catalog.ProductCardsAsync(products);
        var items = new JsonArray();
        foreach (var card in cards)
        {
            items.Add(card);
        }
        var ids = new JsonArray();
        foreach (var p in products)
        {
            ids.Add(p.Id.ToString());
        }
        return new JsonObject { ["items"] = items, ["ids"] = ids };
    }

    public async Task<JsonObject> AddAsync(Guid userId, Guid productId)
    {
        var product = await wishlist.GetProductAsync(productId);
        if (product is null)
        {
            throw new NotFoundException("Product");
        }
        if (await wishlist.GetAsync(userId, productId) is null)
        {
            if (await wishlist.CountAsync(userId) >= MaxItems)
            {
                throw new AppException($"Your wishlist is full ({MaxItems} items)", "wishlist_full");
            }
            await wishlist.InsertAsync(new WishlistItemModel
            {
                UserId = userId,
                ProductId = productId,
                CreatedAt = DateTime.UtcNow,
                PriceAtAdd = product.PriceFrom,
            });
        }
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> RemoveAsync(Guid userId, Guid productId)
    {
        await wishlist.DeleteAsync(userId, productId);
        return new JsonObject { ["ok"] = true };
    }
}
