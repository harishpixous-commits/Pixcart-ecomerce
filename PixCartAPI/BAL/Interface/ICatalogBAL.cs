using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils.Interface;

namespace BAL.Interface;

/// <summary>The storefront catalogue's search request (GET /api/catalog/products), already validated.</summary>
public sealed record ProductSearch(
    string Q = "", string? Category = null, IReadOnlyList<string>? Brand = null, string? Seller = null, long? MinPrice = null, long? MaxPrice = null,
    double? MinRating = null, int? MinDiscount = null, bool InStock = false, string Sort = "relevance", int Page = 1, int? PageSize = null,
    string? Pincode = null, int? Delivery = null, bool Deal = false);

/// <summary>
/// The storefront catalogue: categories, product cards, search with facets, suggestions, product pages, stores, delivery
/// estimates, and the product aggregates other modules refresh after changing variants (seller products, orders, deals).
/// </summary>
public interface ICatalogBAL
{
    /// <summary>
    /// Cards for listings, in the given order: price and rating, the running deal, unit price, "N bought in past
    /// month", the version to add straight to the cart (when there is only one), and for ads the "Sponsored" link
    /// (<paramref name="sponsored"/>: product id → click token). <paramref name="deliveryBy"/> (seller id → date) adds delivery_by.
    /// </summary>
    Task<List<JsonObject>> ProductCardsAsync(IReadOnlyList<ProductModel> products, IReadOnlyDictionary<Guid, string>? sponsored = null,
        IReadOnlyDictionary<Guid, string?>? deliveryBy = null);

    Task<ProductModel?> GetProductAsync(Guid id);

    /// <summary>A product by slug; only ones customers may see when <paramref name="publicOnly"/>.</summary>
    Task<ProductModel?> GetProductBySlugAsync(string slug, bool publicOnly = true);

    /// <summary>Public products by id, in the order given (unknown or hidden ones left out).</summary>
    Task<List<ProductModel>> PublicProductsAsync(IReadOnlyList<Guid> ids);

    /// <summary>
    /// refresh_product_aggregates: the cheapest in-stock active version sets products.price_from, mrp_from and in_stock
    /// (0, 0, false without active versions). Pass the unit of work when called inside a transaction.
    /// </summary>
    Task RefreshProductAggregatesAsync(Guid productId, IUnitOfWork? uow = null);

    /// <summary>The category and every active category below it.</summary>
    Task<List<Guid>> CategoryDescendantIdsAsync(Guid rootId);

    /// <summary>Active categories as a tree with public product counts (including sub-categories) and inherited required details.</summary>
    Task<JsonArray> CategoryTreeAsync();

    /// <summary>Photos per product, in display order.</summary>
    Task<Dictionary<Guid, List<string>>> ImagesForAsync(IEnumerable<Guid> productIds);

    /// <summary>GET /api/catalog/home: categories and the deals, new arrivals, top rated and bestsellers rails.</summary>
    Task<JsonObject> HomeRailsAsync();

    /// <summary>
    /// GET /api/catalog/products. Returns the response and whether a sponsored product was served (the caller then keeps
    /// the visitor id in the pc_vid cookie).
    /// </summary>
    Task<(JsonObject Result, bool ServedAds)> SearchAsync(ProductSearch q, string visitor, string ip);

    /// <summary>GET /api/catalog/suggest.</summary>
    Task<JsonObject> SuggestAsync(string q);

    /// <summary>GET /api/catalog/products/{slug}: everything the product page shows; 404 "Product not found".</summary>
    Task<JsonObject> ProductPageAsync(string slug);

    /// <summary>GET /api/catalog/stores/{slug}; 404 "Store not found".</summary>
    Task<JsonObject> StoreAsync(string slug);

    /// <summary>GET /api/catalog/platform: operator details required by the Consumer Protection (E-Commerce) Rules 2020.</summary>
    Task<JsonObject> PlatformAsync();

    /// <summary>GET /api/catalog/delivery-estimate for a version and a PIN code.</summary>
    Task<JsonObject> DeliveryEstimateAsync(Guid variantId, string pincode);

    /// <summary>Fastest delivery estimate per seller to a PIN code: seller id → {"days", "date"}.</summary>
    Task<Dictionary<Guid, (int Days, string Date)>> SellerDeliveryAsync(IReadOnlyCollection<Guid> sellerIds, string pin);

    /// <summary>Products for a home section or card ("deals", "deals_live", "bestsellers", "top_rated", "new", "category", "manual"), as cards.</summary>
    Task<List<JsonObject>> ProductsForAsync(JsonObject config);
}
