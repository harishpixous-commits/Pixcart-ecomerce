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
public class DeliveryController(IDeliveryBAL delivery, ICurrentUser current, AppSettings app) : ControllerBase
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
}
