using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// The shopper's returns (reference: routers/customer.py returns endpoints — same paths, bodies and payloads).
/// Seller and staff decisions are in the seller and admin returns controllers.
/// </summary>
[ApiController]
public class ReturnsController(IReturnsBAL returns, ICurrentUser current, Utils.Interface.IMySqlDapperHelper db) : ControllerBase
{
    /// <summary>Why a customer can return an item; defect reasons stay allowed past the normal window
    /// (reference: GET /api/returns/reasons).</summary>
    [HttpGet("/api/returns/reasons")]
    public async Task<JsonObject> Reasons() => new()
    {
        ["photos"] = await returns.PhotoConfigAsync(),
        ["reasons"] = new JsonArray((await ReturnReasonsConfig.Async(db)).Select(kv => (JsonNode?)new JsonObject
        {
            ["code"] = kv.Key, ["label"] = kv.Value,
            ["defect"] = PlatformSettingsBAL.DefectReasons.Contains(kv.Key),
        }).ToArray()),
    };

    /// <summary>What can still be returned from the order, and its returns so far
    /// (reference: GET /api/orders/{order_id}/returnable).</summary>
    [HttpGet("/api/orders/{orderId}/returnable")]
    [SignedIn]
    public async Task<JsonObject> Returnable(Guid orderId) =>
        await returns.ReturnableAsync(await current.RequireAsync(), orderId);

    public sealed record CreateIn(
        [param: Required] Guid SubOrderId,
        [param: Required, MinLength(1), MaxLength(50)] List<JsonElement> Items, // free-form objects, checked by ReturnLines.Parse
        [param: Required] string Reason, // checked against the return reasons by the business layer, like the reference
        [param: MaxLength(2000)] string Comment = "",
        [param: MaxLength(60)] string RefundUpi = "",
        [param: MaxLength(6)] List<string>? Photos = null);

    /// <summary>Ask to return items of a delivered package (reference: POST /api/returns).</summary>
    [HttpPost("/api/returns")]
    [SignedIn]
    public async Task<JsonObject> Create(CreateIn body)
    {
        var lines = API.Helpers.ReturnLines.Parse(body.Items); // the reference's ReturnIn.lines()
        var ret = await returns.CreateAsync(await current.RequireAsync(), body.SubOrderId, lines,
            body.Reason, body.Comment, body.RefundUpi.Trim(), body.Photos);
        Response.StatusCode = StatusCodes.Status201Created;
        return await returns.ReturnOutAsync(ret);
    }

    /// <summary>A photo for a return request (reference: POST /api/returns/photos).</summary>
    [HttpPost("/api/returns/photos")]
    [RouteGuard("signed_in")]
    [RequestSizeLimit(MaxUpload + 1024 * 1024), RequestFormLimits(MultipartBodyLengthLimit = MaxUpload + 1024 * 1024)]
    public async Task<IActionResult> UploadPhoto(IFormFile? file)
    {
        var user = await current.RequireAsync();
        if (file is null)
            throw new AppException("File: is required", "validation_error", 422, new Dictionary<string, string> { ["file"] = "is required" });
        using var ms = new MemoryStream();
        await using (var s = file.OpenReadStream())
        {
            var buf = new byte[81920];
            int n;
            while ((n = await s.ReadAsync(buf)) > 0 && ms.Length <= MaxUpload) ms.Write(buf, 0, n);
        }
        return StatusCode(201, await returns.UploadPhotoAsync(user, ms.ToArray()));
    }

    private const int MaxUpload = 10 * 1024 * 1024;

    /// <summary>Cancel your own return request (reference: POST /api/returns/{return_id}/cancel).</summary>
    [HttpPost("/api/returns/{returnId}/cancel")]
    [SignedIn]
    public async Task<JsonObject> Cancel(Guid returnId) =>
        await returns.CancelAsync(await current.RequireAsync(), returnId);
}
