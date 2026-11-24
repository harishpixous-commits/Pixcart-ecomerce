using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Delivery partner registration and profile (reference: routers/delivery.py — same paths and payload). Offers,
/// trips and the fleet arrive with the assignment slice.
/// </summary>
[ApiController]
[Route("/api/delivery")]
public class DeliveryController(
    IDeliveryFleetBAL fleet,IDeliveryBAL delivery, ICurrentUser current, AppSettings app) : ControllerBase
{
    /// <summary>For the join page and the registration form (reference: GET /api/delivery/options). No sign-in.</summary>
    [HttpGet("options")]
    public async Task<JsonObject> Options() => await delivery.OptionsAsync();

    /// <summary>My partner profile (reference: GET /api/delivery/me).</summary>
    [HttpGet("me"), SignedIn]
    public async Task<JsonObject> Me() => await delivery.MeAsync(await current.RequireAsync());

    /// <summary>Sign up as a partner (reference: POST /api/delivery/register).</summary>
    [HttpPost("register"), SignedIn]
    public async Task<JsonObject> Register(ProfileIn body)
    {
        var result = await delivery.RegisterAsync(await current.RequireAsync(), Body(body));
        Response.StatusCode = 201;
        return result;
    }

    /// <summary>Edit the profile (reference: PUT /api/delivery/me).</summary>
    [HttpPut("me"), SignedIn]
    public async Task<JsonObject> UpdateMe(ProfileIn body) =>
        await delivery.UpdateMeAsync(await current.RequireAsync(), Body(body));

    /// <summary>Upload a KYC document or the profile photo (reference: POST /api/delivery/me/docs/{kind}).</summary>
    [HttpPost("me/docs/{kind}"), SignedIn]
    public async Task<JsonObject> UploadDoc(string kind, IFormFile file)
    {
        if (kind is not ("photo" or "license" or "id_proof" or "vehicle_rc"))
            throw new AppException("Unknown document kind", "validation", 422);
        var max = kind == "photo" ? app.MaxImageBytes : app.MaxDocumentBytes;
        if (file is null || file.Length == 0)
            throw new AppException(kind == "photo" ? "This file is not a valid image" : "Upload a PDF, JPG or PNG file",
                kind == "photo" ? "invalid_image" : "invalid_document");
        if (file.Length > max)
            throw new AppException(
                kind == "photo" ? $"Image must be smaller than {max / (1024 * 1024)} MB" : $"File must be smaller than {max / (1024 * 1024)} MB",
                "file_too_large");
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        return await delivery.UploadDocAsync(await current.RequireAsync(), kind, ms.ToArray());
    }

    /// <summary>Read my own document (reference: GET /api/delivery/me/docs/{kind}). Private, never cached.</summary>
    [HttpGet("me/docs/{kind}"), SignedIn]
    public async Task<IActionResult> Doc(string kind)
    {
        var (data, media, fileName) = await delivery.ReadDocAsync(await current.RequireAsync(), kind);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.ContentDisposition = $"inline; filename=\"{fileName}\"";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(data, media);
    }

    /// <summary>Payout details (reference: PUT /api/delivery/me/bank).</summary>
    [HttpPut("me/bank"), SignedIn]
    public async Task<JsonObject> SetBank(BankIn body) =>
        await delivery.SetBankAsync(await current.RequireAsync(),
            body.Holder, body.AccountNumber, body.ConfirmAccountNumber, body.Ifsc, body.Upi);

    /// <summary>Send the registration for review (reference: POST /api/delivery/me/submit).</summary>
    [HttpPost("me/submit"), SignedIn]
    public async Task<JsonObject> Submit() => await delivery.SubmitAsync(await current.RequireAsync());

    /// <summary>Go online/offline for offers (reference: POST /api/delivery/me/online).</summary>
    [HttpPost("me/online"), SignedIn]
    public async Task<JsonObject> SetOnline(OnlineIn body) =>
        await delivery.SetOnlineAsync(await current.RequireAsync(), body.Online);

    private static DeliveryProfile Body(ProfileIn b) => new(
        b.Name, b.City, b.Address, b.ZoneId, b.VehicleType, b.VehicleNo, b.LicenseNo, b.IdProofType, b.IdProofNo);

    public sealed record ProfileIn(
        [param: StringLength(120, MinimumLength = 2)] string? Name = null,
        [param: StringLength(80, MinimumLength = 2)] string? City = null,
        [param: StringLength(500)] string? Address = null,
        Guid? ZoneId = null,
        [param: RegularExpression("^(bike|scooter|ev|cycle|auto|van)$")] string? VehicleType = null,
        [param: StringLength(15)] string? VehicleNo = null,
        [param: StringLength(20)] string? LicenseNo = null,
        [param: RegularExpression("^(aadhaar|pan|voter|passport)$")] string? IdProofType = null,
        [param: StringLength(20)] string? IdProofNo = null);

    public sealed record BankIn(
        [param: Required, StringLength(120, MinimumLength = 3)] string Holder = "",
        [param: StringLength(24)] string AccountNumber = "",
        [param: StringLength(24)] string ConfirmAccountNumber = "",
        [param: StringLength(11)] string Ifsc = "",
        [param: StringLength(80)] string Upi = "");

    public sealed record OnlineIn(bool Online);

    /// <summary>The partner's live position, rate-limited (reference: POST /api/delivery/me/location).</summary>
    [HttpPost("me/location"), SignedIn]
    public async Task<JsonObject> SetLocation(LocationIn body)
    {
        var user = await current.RequireAsync();
        return await fleet.SetLocationAsync(user, body.Lat, body.Lng);
    }

    /// <summary>What the app polls every few seconds (reference: GET /api/delivery/feed).</summary>
    [HttpGet("feed"), SignedIn]
    public async Task<JsonObject> Feed()
    {
        var user = await current.RequireAsync();
        return await fleet.FeedAsync(user);
    }

    /// <summary>Accept a request (reference: POST /api/delivery/offers/{assignment_id}/accept).</summary>
    [HttpPost("offers/{assignmentId:guid}/accept"), SignedIn]
    public async Task<JsonObject> Accept(Guid assignmentId)
    {
        var user = await current.RequireAsync();
        return await fleet.AcceptAsync(user, assignmentId);
    }

    /// <summary>Decline a request (reference: POST /api/delivery/offers/{assignment_id}/reject).</summary>
    [HttpPost("offers/{assignmentId:guid}/reject"), SignedIn]
    public async Task<JsonObject> Reject(Guid assignmentId, RejectIn body)
    {
        var user = await current.RequireAsync();
        return await fleet.RejectAsync(user, assignmentId, body.Reason, body.Note);
    }

    /// <summary>One trip with its status log (reference: GET /api/delivery/trips/{assignment_id}).</summary>
    [HttpGet("trips/{assignmentId:guid}"), SignedIn]
    public async Task<JsonObject> Trip(Guid assignmentId)
    {
        var user = await current.RequireAsync();
        return await fleet.TripAsync(user, assignmentId);
    }

    /// <summary>Advance a trip one step (reference: POST /api/delivery/trips/{assignment_id}/status).</summary>
    [HttpPost("trips/{assignmentId:guid}/status"), SignedIn]
    public async Task<JsonObject> TripStep(Guid assignmentId, StepIn body)
    {
        var user = await current.RequireAsync();
        return await fleet.StepAsync(user, assignmentId, body.To, body.Code, body.Lat, body.Lng);
    }

    /// <summary>Hand the package over (reference: POST /api/delivery/trips/{assignment_id}/deliver — multipart).</summary>
    [HttpPost("trips/{assignmentId:guid}/deliver"), SignedIn]
    public async Task<JsonObject> TripDeliver(Guid assignmentId, [FromForm] DeliverIn body)
    {
        var user = await current.RequireAsync();
        byte[]? photo = null;
        if (body.Photo is { Length: > 0 })
        {
            if (body.Photo.Length > app.MaxDocumentBytes + 1)
                throw new AppException("The photo is too large", "invalid_image");
            await using var ms = new MemoryStream();
            await body.Photo.CopyToAsync(ms);
            photo = ms.ToArray();
        }
        return await fleet.DeliverAsync(user, assignmentId, body.Otp, photo, body.CodCollected, body.CodMethod, body.Lat, body.Lng);
    }

    /// <summary>A delivery attempt that failed (reference: POST /api/delivery/trips/{assignment_id}/fail).</summary>
    [HttpPost("trips/{assignmentId:guid}/fail"), SignedIn]
    public async Task<JsonObject> TripFail(Guid assignmentId, FailIn body)
    {
        var user = await current.RequireAsync();
        return await fleet.FailAsync(user, assignmentId, body.Reason, body.Note, body.Lat, body.Lng);
    }

    public sealed record ReturnedIn(
        [param: MaxLength(8)] string Code = "",
        [param: Range(-90, 90)] decimal? Lat = null,
        [param: Range(-180, 180)] decimal? Lng = null);

    /// <summary>Hand a package back to the seller (reference: POST /api/delivery/trips/{assignment_id}/returned).</summary>
    [HttpPost("trips/{assignmentId:guid}/returned"), SignedIn]
    public async Task<JsonObject> TripReturned(Guid assignmentId, ReturnedIn body)
    {
        var user = await current.RequireAsync();
        return await fleet.ReturnedAsync(user, assignmentId, body.Code, body.Lat, body.Lng);
    }

    /// <summary>The partner's own delivery proof photo (reference: GET /api/delivery/trips/{assignment_id}/proof).</summary>
    [HttpGet("trips/{assignmentId:guid}/proof"), SignedIn]
    public async Task<FileContentResult> TripProof(Guid assignmentId)
    {
        var user = await current.RequireAsync();
        var (data, media) = await fleet.ProofAsync(user, assignmentId);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(data, media);
    }

    public sealed record LocationIn(
        [param: Range(-90, 90, ErrorMessage = "lat must be between -90 and 90")] decimal Lat,
        [param: Range(-180, 180, ErrorMessage = "lng must be between -180 and 180")] decimal Lng);

    public sealed record RejectIn(
        [param: RegularExpression("^(too_far|vehicle|busy|ending_shift|unsafe|other)$", ErrorMessage = "Choose a reason")]
        string Reason = "other",
        [param: MaxLength(200, ErrorMessage = "note must be at most 200 characters")] string Note = "");

    public sealed record StepIn(
        [param: RegularExpression("^(at_store|picked|on_the_way|reached)$", ErrorMessage = "Unknown step")] string To,
        [param: MaxLength(8, ErrorMessage = "code must be at most 8 characters")] string Code = "",
        [param: Range(-90, 90, ErrorMessage = "lat must be between -90 and 90")] decimal? Lat = null,
        [param: Range(-180, 180, ErrorMessage = "lng must be between -180 and 180")] decimal? Lng = null);

    public sealed class DeliverIn
    {
        [MaxLength(8, ErrorMessage = "otp must be at most 8 characters")]
        [FromForm(Name = "otp")]
        public string Otp { get; set; } = "";
        [Range(0, 100_000_000, ErrorMessage = "cod_collected must be between 0 and 100000000")]
        [FromForm(Name = "cod_collected")]
        public long CodCollected { get; set; }
        [MaxLength(6, ErrorMessage = "cod_method must be at most 6 characters")]
        [FromForm(Name = "cod_method")]
        public string CodMethod { get; set; } = "";
        [Range(-90, 90, ErrorMessage = "lat must be between -90 and 90")]
        [FromForm(Name = "lat")]
        public decimal? Lat { get; set; }
        [Range(-180, 180, ErrorMessage = "lng must be between -180 and 180")]
        [FromForm(Name = "lng")]
        public decimal? Lng { get; set; }
        [FromForm(Name = "photo")]
        public IFormFile? Photo { get; set; }
    }

    public sealed class FailIn
    {
        [Required(ErrorMessage = "Choose a reason")]
        [RegularExpression("^(not_available|wrong_address|refused|no_cash|damaged|other)$", ErrorMessage = "Choose a reason")]
        public string Reason { get; set; } = "";
        [MaxLength(200, ErrorMessage = "note must be at most 200 characters")]
        public string Note { get; set; } = "";
        [Range(-90, 90, ErrorMessage = "lat must be between -90 and 90")]
        public decimal? Lat { get; set; }
        [Range(-180, 180, ErrorMessage = "lng must be between -180 and 180")]
        public decimal? Lng { get; set; }
    }
}
