using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Catalog;
using Utils;

namespace API.Controllers;

/// <summary>
/// Reviews on the product page. Anyone can read reviews. Writing, voting "helpful" and reporting need a signed-in
/// customer; by default only customers whose order was delivered can write (Admin → Reviews → Settings).
/// </summary>
[ApiController]
public class ReviewsController(IReviewBAL reviews, ICurrentUser me) : ControllerBase
{
    /// <summary>Uploads are read up to this size (the largest review video allowed is 100 MB).</summary>
    private const long MaxUpload = 101L * 1024 * 1024;

    [HttpGet("/api/catalog/products/{slug}/reviews")]
    public async Task<JsonObject> ProductReviews(string slug,
        [FromQuery, OneOf("recent", "helpful", "high", "low")] string sort = "recent",
        [FromQuery, Between(1, 500)] int page = 1,
        [FromQuery, Between(1, 5)] int? star = null,
        [FromQuery] bool media = false,
        [FromQuery] bool verified = false,
        [FromQuery, Len(0, 30)] string topic = "") =>
        await reviews.ProductReviewsAsync(slug, await me.GetAsync(), new ReviewQuery(sort, page, star, media, verified, topic));

    /// <summary>All customer photos and videos for the full-screen viewer, 30 at a time.</summary>
    [HttpGet("/api/catalog/products/{slug}/media")]
    public async Task<JsonObject> ProductMedia(string slug, [FromQuery, Between(1, 100)] int page = 1) =>
        await reviews.ProductMediaAsync(slug, await me.GetAsync(), page);

    [HttpPut("/api/catalog/products/{slug}/reviews"), SignedIn]
    public async Task<JsonObject> WriteReview(string slug, [FromBody] ReviewIn body) => await reviews.WriteReviewAsync(slug, await me.RequireAsync(), body);

    [HttpDelete("/api/catalog/products/{slug}/reviews"), SignedIn]
    public async Task<JsonObject> DeleteReview(string slug) => await reviews.DeleteReviewAsync(slug, await me.RequireAsync());

    /// <summary>A photo or video for a review (the review itself is saved with PUT .../reviews).</summary>
    [HttpPost("/api/reviews/media"), SignedIn]
    [RequestSizeLimit(MaxUpload + 1024 * 1024), RequestFormLimits(MultipartBodyLengthLimit = MaxUpload + 1024 * 1024)]
    public async Task<IActionResult> UploadMedia(IFormFile? file)
    {
        var user = await me.RequireAsync();
        if (file is null)
            throw new AppException("File: is required", "validation_error", 422, new Dictionary<string, string> { ["file"] = "is required" });
        using var ms = new MemoryStream();
        await using (var s = file.OpenReadStream())
        {
            var buf = new byte[81920];
            int n;
            while ((n = await s.ReadAsync(buf)) > 0 && ms.Length <= MaxUpload) ms.Write(buf, 0, n);
        }
        return StatusCode(201, await reviews.UploadMediaAsync(user, ms.ToArray()));
    }

    /// <summary>Marks a review helpful; a second call takes the vote back.</summary>
    [HttpPost("/api/reviews/{reviewId}/helpful"), SignedIn]
    public async Task<JsonObject> Helpful(Guid reviewId) => await reviews.HelpfulAsync(reviewId, await me.RequireAsync());

    [HttpPost("/api/reviews/{reviewId}/report"), SignedIn]
    public async Task<JsonObject> ReportReview(Guid reviewId, [FromBody] ReviewReportIn body) => await reviews.ReportReviewAsync(reviewId, await me.RequireAsync(), body);

    /// <summary>Report an issue with this product. Staff see it in Admin → Product reports; the seller sees it without the customer's details.</summary>
    [HttpPost("/api/catalog/products/{slug}/report"), SignedIn]
    public async Task<IActionResult> ReportProduct(string slug, [FromBody] ProductReportIn body) =>
        StatusCode(201, await reviews.ReportProductAsync(slug, await me.RequireAsync(), body));
}
