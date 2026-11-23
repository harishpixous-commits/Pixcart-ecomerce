using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.Catalog;

namespace BAL.Interface;

/// <summary>The product-page reviews query (GET /api/catalog/products/{slug}/reviews), already validated.</summary>
public sealed record ReviewQuery(string Sort = "recent", int Page = 1, int? Star = null, bool Media = false, bool Verified = false, string Topic = "");

/// <summary>
/// Ratings and reviews on the storefront: reading (anyone), writing, photos and videos, helpful votes and reports
/// (signed-in customers; by default only after delivery), and "report an issue with this product".
/// </summary>
public interface IReviewBAL
{
    Task<JsonObject> ProductReviewsAsync(string slug, UserModel? user, ReviewQuery q);

    /// <summary>All customer photos and videos for the full-screen viewer, 30 at a time.</summary>
    Task<JsonObject> ProductMediaAsync(string slug, UserModel? user, int page);

    Task<JsonObject> WriteReviewAsync(string slug, UserModel user, ReviewIn body);

    Task<JsonObject> DeleteReviewAsync(string slug, UserModel user);

    /// <summary>A photo or video for a review (checked by its content); returns {"url", "kind"}.</summary>
    Task<JsonObject> UploadMediaAsync(UserModel user, byte[] data);

    Task<JsonObject> HelpfulAsync(Guid reviewId, UserModel user);

    Task<JsonObject> ReportReviewAsync(Guid reviewId, UserModel user, ReviewReportIn body);

    /// <summary>Files a report on a review (shared with the seller hub's "report a review"); counts each person once.</summary>
    Task<JsonObject> FileReviewReportAsync(ReviewModel review, Guid userId, ReviewReportIn body);

    Task<JsonObject> ReportProductAsync(string slug, UserModel user, ProductReportIn body);

    /// <summary>Recomputes the product's and its seller's rating average and count from published reviews.</summary>
    Task RefreshRatingsAsync(Guid productId);

    /// <summary>Customer photos and videos of a product, newest first: (items, number of items).</summary>
    Task<(JsonArray Items, long Total)> CustomerMediaAsync(Guid productId, int limit = 30, int offset = 0);

    /// <summary>"What customers talk about": mentions per topic with positive and negative counts.</summary>
    Task<JsonArray> ReviewTopicsAsync(JsonArray topics, Guid? productId = null, Guid? sellerId = null);
}
