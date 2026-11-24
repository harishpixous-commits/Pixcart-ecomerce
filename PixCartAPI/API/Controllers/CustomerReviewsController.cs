using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Customer reviews and product reports (reference: routers/customer.py — same paths, bodies and payload). Reading is
/// public; writing, voting "helpful" and reporting need a signed-in customer.
/// </summary>
[ApiController]
public class CustomerReviewsController(ICustomerReviewsBAL reviews, ICurrentUser current, AppSettings settings) : ControllerBase
{
    /// <summary>Reference ReviewMediaIn: uploads must point at this site's own media folders.</summary>
    public sealed record ReviewMediaIn(
        [param: Required, RegularExpression("^(image|video)$", ErrorMessage = "kind must be image or video")] string Kind,
        [param: Required, StringLength(400)] string Url,
        [param: StringLength(400)] string? PosterUrl)
    {
        public JsonObject Node() => new()
        {
            ["kind"] = Kind,
            ["url"] = Url,
            ["poster_url"] = PosterUrl ?? "",
        };
    }

    public sealed record ReviewIn(
        [param: Range(1, 5)] int Rating,
        [param: StringLength(120)] string? Title,
        [param: StringLength(4000)] string? Body,
        [param: MaxLength(12)] List<ReviewMediaIn>? Media);

    public sealed record ReportIn([param: Required, StringLength(20)] string Reason, [param: StringLength(500)] string? Note);

    public sealed record ProductReportIn(
        [param: Required, StringLength(20)] string Reason,
        [param: StringLength(2000)] string? Note,
        [param: StringLength(400), RegularExpression(@"^(|https?://\S+)$", ErrorMessage = "Enter a web address starting with https://")] string? Url);

    [HttpGet("/api/catalog/products/{slug}/reviews")]
    public async Task<JsonObject> List(
        string slug,
        [FromQuery, RegularExpression("^(recent|helpful|high|low)$", ErrorMessage = "sort must be recent, helpful, high or low")] string sort = "recent",
        [FromQuery, Range(1, 500)] int page = 1,
        [FromQuery, Range(1, 5)] int? star = null,
        [FromQuery] bool media = false,
        [FromQuery] bool verified = false,
        [FromQuery, StringLength(30)] string topic = "") =>
        await reviews.ListAsync(await current.GetAsync(), slug, sort, page, star, media, verified, topic);

    /// <summary>All customer photos and videos for the full-screen viewer.</summary>
    [HttpGet("/api/catalog/products/{slug}/media")]
    public async Task<JsonObject> Media(string slug, [FromQuery, Range(1, 100)] int page = 1) =>
        await reviews.CustomerMediaAsync(await current.GetAsync(), slug, page);

    [HttpPut("/api/catalog/products/{slug}/reviews")]
    [SignedIn]
    public async Task<JsonObject> Write(string slug, ReviewIn body)
    {
        var media = new JsonArray();
        foreach (var m in body.Media ?? [])
        {
            if (!MediaOk(m.Url, m.Kind == "image" ? "reviews" : "review-videos") || (m.PosterUrl is { Length: > 0 } p && !MediaOk(p, "reviews")))
            {
                throw new AppException("Upload photos and videos here; links to other sites are not allowed", "validation", 422);
            }
            media.Add(m.Node());
        }
        return await reviews.WriteAsync(await User(), slug, body.Rating, body.Title ?? "", body.Body ?? "", media);
    }

    [HttpDelete("/api/catalog/products/{slug}/reviews")]
    [SignedIn]
    public async Task<JsonObject> Delete(string slug) => await reviews.DeleteAsync(await User(), slug);

    /// <summary>A photo or video for a review.</summary>
    [HttpPost("/api/reviews/media")]
    [SignedIn]
    public async Task<IActionResult> UploadMedia(IFormFile file)
    {
        var limit = Math.Max(100L * 1024 * 1024, settings.MaxImageBytes) + 1;
        await using var stream = file.OpenReadStream();
        using var ms = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(buffer)) > 0 && ms.Length <= limit)
        {
            ms.Write(buffer, 0, read);
        }
        var result = await reviews.UploadMediaAsync(await User(), ms.ToArray());
        return StatusCode(201, result);
    }

    [HttpPost("/api/reviews/{reviewId:guid}/helpful")]
    [SignedIn]
    public async Task<JsonObject> Helpful(Guid reviewId) => await reviews.HelpfulAsync(await User(), reviewId);

    [HttpPost("/api/reviews/{reviewId:guid}/report")]
    [SignedIn]
    public async Task<JsonObject> Report(Guid reviewId, ReportIn body) =>
        await reviews.ReportAsync(await User(), reviewId, body.Reason, body.Note ?? "");

    /// <summary>Report an issue with this product.</summary>
    [HttpPost("/api/catalog/products/{slug}/report")]
    [SignedIn]
    public async Task<IActionResult> ReportProduct(string slug, ProductReportIn body)
    {
        var result = await reviews.ReportProductAsync(await User(), slug, body.Reason, body.Note ?? "", (body.Url ?? "").Trim());
        return StatusCode(201, result);
    }

    /// <summary>Reference _media_ok: the site's own media base, the right folder, no "..", at most 400 characters.</summary>
    private bool MediaOk(string url, string folder) =>
        url.StartsWith($"{settings.MediaBaseUrl.TrimEnd('/')}/{folder}/") && !url.Contains("..") && url.Length <= 400;

    private async Task<Model.DomainModel.UserModel> User() => await current.RequireAsync();
}
