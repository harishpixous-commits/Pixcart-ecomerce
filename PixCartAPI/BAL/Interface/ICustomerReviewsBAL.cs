using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Customer reviews and product reports (reference: routers/customer.py review and report routes).</summary>
public interface ICustomerReviewsBAL
{
    Task<JsonObject> ListAsync(UserModel? user, string slug, string sort, int page, int? star, bool media, bool verified, string topic);
    Task<JsonObject> CustomerMediaAsync(UserModel? user, string slug, int page);
    Task<JsonObject> WriteAsync(UserModel user, string slug, int rating, string title, string body, JsonArray media);
    Task<JsonObject> DeleteAsync(UserModel user, string slug);
    Task<JsonObject> UploadMediaAsync(UserModel user, byte[] data);
    Task<JsonObject> HelpfulAsync(UserModel user, Guid reviewId);
    Task<JsonObject> ReportAsync(UserModel user, Guid reviewId, string reason, string note);
    Task<JsonObject> ReportProductAsync(UserModel user, string slug, string reason, string note, string url);
}
