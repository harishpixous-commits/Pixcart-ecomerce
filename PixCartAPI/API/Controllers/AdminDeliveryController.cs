using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using Utils;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>
/// Staff delivery-fleet operations (reference: routers/delivery_admin.py — same paths and payloads). Every
/// endpoint needs the "delivery" staff permission. KYC review, zones, the live map, cash/payouts, reports,
/// feedback and the app upload are later slices.
/// </summary>
[ApiController]
[Route("/api/admin/delivery")]
public class AdminDeliveryController(
    DeliveryAdminBAL admin, IDeliveryFleetBAL fleet, ICurrentUser current, AppSettings app) : ControllerBase
{
    /// <summary>The dispatch queue (reference: GET /api/admin/delivery/queue).</summary>
    [HttpGet("queue"), SignedIn]
    public async Task<JsonObject> Queue([FromQuery, RegularExpression("^(waiting|offered|failed|returns)$")] string tab = "waiting") =>
        await admin.QueueAsync(await current.RequireAsync(), tab);

    /// <summary>Partners who could take a package, best first (reference: GET .../packages/{sub_id}/candidates).</summary>
    [HttpGet("packages/{subOrderId:guid}/candidates"), SignedIn]
    public async Task<JsonArray> Candidates(Guid subOrderId) =>
        await admin.CandidatesAsync(await current.RequireAsync(), subOrderId);

    /// <summary>Partners who could fetch a return, best first (reference: GET .../returns/{return_id}/candidates).</summary>
    [HttpGet("returns/{returnId:guid}/candidates"), SignedIn]
    public async Task<JsonArray> ReturnCandidates(Guid returnId) =>
        await fleet.ReturnCandidatesAsync(await current.RequireAsync(), returnId);

        /// <summary>Offer or assign a package to a chosen partner (reference: POST .../assign).</summary>
    [HttpPost("assign"), SignedIn]
    public async Task<JsonObject> Assign(AssignIn body)
    {
        var user = await current.RequireAsync();
        if (body.SubOrderId is null || body.PartnerId is null)
            throw new AppException("Choose a package and a partner", "required", 422);
        return await fleet.AssignByStaffAsync(user, body.SubOrderId.Value, body.PartnerId.Value, body.Direct, body.Force);
    }

    public sealed record ReturnAssignIn(Guid? ReturnId, Guid? PartnerId, bool Direct = false, bool Force = false);

    public sealed record PickupAssignIn(Guid? PartnerId,bool Direct=false,bool Force=false);

    /// <summary>Reference route: the return ID is in the URL, not in the request body.</summary>
    [HttpPost("returns/{returnId:guid}/assign"), SignedIn]
    public async Task<JsonObject> AssignReturn(Guid returnId,PickupAssignIn body)
    {
        var user=await current.RequireAsync();
        if(body.PartnerId is null)throw new AppException("Choose a partner","required",422);
        return await fleet.AssignPickupByStaffAsync(user,returnId,body.PartnerId.Value,body.Direct,body.Force);
    }

    /// <summary>Older form of the route above, with the return id in the body; kept for existing callers.</summary>
    [HttpPost("returns/assign"), SignedIn, API.Infrastructure.RouteGuard("perm:delivery")]
    public async Task<JsonObject> AssignReturn(ReturnAssignIn body)
    {
        var user = await current.RequireAsync();
        if (body.ReturnId is null || body.PartnerId is null)
            throw new AppException("Choose a return and a partner", "required", 422);
        return await fleet.AssignPickupByStaffAsync(user, body.ReturnId.Value, body.PartnerId.Value, body.Direct, body.Force);
    }

        /// <summary>Run auto-assignment now (reference: POST .../packages/{sub_id}/auto-assign).</summary>
    [HttpPost("packages/{subOrderId:guid}/auto-assign"), SignedIn]
    public async Task<JsonObject> RunAuto(Guid subOrderId) =>
        await fleet.AutoAssignByStaffAsync(await current.RequireAsync(), subOrderId);

    /// <summary>Run return-pickup auto-assignment now (reference: POST .../returns/{return_id}/auto-assign).</summary>
    [HttpPost("returns/{returnId:guid}/auto-assign"), SignedIn]
    public async Task<JsonObject> RunReturnAuto(Guid returnId) =>
        await fleet.AutoAssignPickupByStaffAsync(await current.RequireAsync(), returnId);

    /// <summary>Move a return pickup to a courier (reference: POST .../returns/{return_id}/courier).</summary>
    [HttpPost("returns/{returnId:guid}/courier"), SignedIn]
    public async Task<JsonObject> ReturnToCourier(Guid returnId)
    {
        await fleet.PickupToCourierByStaffAsync(await current.RequireAsync(), returnId);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Take a request or trip off a partner before pickup (reference: POST .../assignments/{id}/cancel).</summary>
    [HttpPost("assignments/{assignmentId:guid}/cancel"), SignedIn]
    public async Task<JsonObject> Cancel(Guid assignmentId, ReasonIn body)
    {
        await fleet.CancelByStaffAsync(await current.RequireAsync(), assignmentId, body.Reason);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Retry a failed delivery or send the partner back to the store (reference: POST .../resolve).</summary>
    [HttpPost("assignments/{assignmentId:guid}/resolve"), SignedIn]
    public async Task<JsonObject> Resolve(Guid assignmentId, ResolveIn body) =>
        await fleet.ResolveFailedAsync(await current.RequireAsync(), assignmentId, body.Action);

    /// <summary>Move a package to a courier (reference: POST .../packages/{sub_id}/courier).</summary>
    [HttpPost("packages/{subOrderId:guid}/courier"), SignedIn]
    public async Task<JsonObject> ToCourier(Guid subOrderId)
    {
        await fleet.ToCourierByStaffAsync(await current.RequireAsync(), subOrderId);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Trips, newest first (reference: GET .../trips).</summary>
    [HttpGet("trips"), SignedIn]
    public async Task<JsonObject> Trips([FromQuery, StringLength(12)] string status = "",
        [FromQuery, StringLength(60)] string q = "", [FromQuery] Guid? partnerId = null, [FromQuery, Range(1, 100000)] int page = 1) =>
        await admin.TripsAsync(await current.RequireAsync(), status, q, partnerId, page);

    /// <summary>One trip with its status log (reference: GET .../trips/{assignment_id}).</summary>
    [HttpGet("trips/{assignmentId:guid}"), SignedIn]
    public async Task<JsonObject> TripDetail(Guid assignmentId) =>
        await admin.TripDetailAsync(await current.RequireAsync(), assignmentId);

    /// <summary>The delivery photo (reference: GET .../trips/{assignment_id}/proof).</summary>
    [HttpGet("trips/{assignmentId:guid}/proof"), SignedIn]
    public async Task<IActionResult> TripProof(Guid assignmentId)
    {
        await current.RequireAsync();
        var (data, media) = await fleet.ProofStaffAsync(assignmentId);
        return File(data, media);
    }

    /// <summary>Fleet numbers for the dashboard (reference: GET .../overview).</summary>
    [HttpGet("overview"), SignedIn]
    public async Task<JsonObject> Overview() => await admin.OverviewAsync(await current.RequireAsync());

    /// <summary>Fleet settings (reference: GET + PUT .../settings).</summary>
    [HttpGet("settings"), SignedIn]
    public async Task<JsonObject> GetSettings() => await admin.SettingsAsync(await current.RequireAsync());

    [HttpPut("settings"), SignedIn]
    public async Task<JsonObject> PutSettings([FromBody] JsonObject body) =>
        await admin.UpdateSettingsAsync(await current.RequireAsync(), body);

    /// <summary>Partners and trips right now, for the live map (reference: GET .../live).</summary>
    [HttpGet("live"), SignedIn]
    public async Task<JsonObject> Live() => await admin.LiveAsync(await current.RequireAsync());

    // ------------------------------------------------------------------ cash, payouts, reports, feedback

    /// <summary>Cash in hand per partner and recent deposits (reference: GET .../cash).</summary>
    [HttpGet("cash"), SignedIn]
    public async Task<JsonObject> Cash() => await admin.CashAsync(await current.RequireAsync());

    /// <summary>Record a cash deposit (reference: POST .../partners/{id}/deposits).</summary>
    [HttpPost("partners/{partnerId:guid}/deposits"), SignedIn]
    public async Task<JsonObject> AddDeposit(Guid partnerId, DepositIn body) =>
        await admin.AddDepositAsync(await current.RequireAsync(), partnerId, body.AmountPaise, body.Method,
            body.Reference, body.Note);

    /// <summary>Weekly payouts (reference: GET .../payouts).</summary>
    [HttpGet("payouts"), SignedIn]
    public async Task<JsonObject> Payouts([FromQuery, RegularExpression("^(|pending|paid)$")] string status = "",
        [FromQuery, Range(1, 100000)] int page = 1) =>
        await admin.PayoutsAsync(await current.RequireAsync(), status, page);

    /// <summary>Create this week's payouts (reference: POST .../payouts/generate; payouts permission).</summary>
    [HttpPost("payouts/generate"), SignedIn]
    public async Task<JsonObject> GeneratePayouts(GenerateIn body) =>
        await admin.GeneratePayoutsAsync(await current.RequireAsync(), body.WeekStart);

    /// <summary>Mark a payout paid (reference: POST .../payouts/{id}/paid; payouts permission).</summary>
    [HttpPost("payouts/{payoutId:guid}/paid"), SignedIn]
    public async Task<JsonObject> MarkPaid(Guid payoutId, PaidIn body) =>
        await admin.MarkPayoutPaidAsync(await current.RequireAsync(), payoutId, body.Reference);

    /// <summary>Per-day and per-partner numbers (reference: GET .../reports).</summary>
    [HttpGet("reports"), SignedIn]
    public async Task<JsonObject> Reports([FromQuery, Range(7, 180)] int days = 30) =>
        await admin.ReportsAsync(await current.RequireAsync(), days);

    /// <summary>Ratings and complaints (reference: GET .../feedback).</summary>
    [HttpGet("feedback"), SignedIn]
    public async Task<JsonObject> Feedback([FromQuery, RegularExpression("^(ratings|complaints)$")] string kind = "complaints",
        [FromQuery, RegularExpression("^(|open|resolved)$")] string status = "open",
        [FromQuery, Range(1, 100000)] int page = 1) =>
        await admin.FeedbackAsync(await current.RequireAsync(), kind, status, page);

    /// <summary>Resolve a complaint (reference: POST .../complaints/{id}/resolve).</summary>
    [HttpPost("complaints/{complaintId:guid}/resolve"), SignedIn]
    public async Task<JsonObject> ResolveComplaint(Guid complaintId, ResolveComplaintIn body) =>
        await admin.ResolveComplaintAsync(await current.RequireAsync(), complaintId, body.Note);

    public sealed record DepositIn(
        [param: Range(1, 100000000)] long AmountPaise,
        [param: RegularExpression("^(cash|upi|bank)$")] string Method = "cash",
        [param: StringLength(60)] string Reference = "", [param: StringLength(300)] string Note = "");

    public sealed record GenerateIn(DateOnly? WeekStart = null);

    public sealed record PaidIn([param: Required, StringLength(60, MinimumLength = 3)] string Reference = "");

    public sealed record ResolveComplaintIn([param: Required, StringLength(500, MinimumLength = 3)] string Note = "");

    // ------------------------------------------------------------------ partners (reference: delivery_admin.py)

    /// <summary>Partners, newest first, submitted KYC first (reference: GET .../partners).</summary>
    [HttpGet("partners"), SignedIn]
    public async Task<JsonObject> Partners([FromQuery, StringLength(12)] string status = "",
        [FromQuery, StringLength(80)] string q = "", [FromQuery] Guid? zoneId = null, [FromQuery] bool? online = null,
        [FromQuery, Range(1, 100000)] int page = 1) =>
        await admin.PartnersAsync(await current.RequireAsync(), status, q, zoneId, online, page);

    /// <summary>Staff add a partner by mobile number (reference: POST .../partners).</summary>
    [HttpPost("partners"), SignedIn]
    public async Task<JsonObject> AddPartner(NewPartnerIn body)
    {
        var result = await admin.PartnerCreateAsync(await current.RequireAsync(), body.Phone, body.Name, body.Profile());
        Response.StatusCode = 201;
        return result;
    }

    /// <summary>One partner with the decrypted ID number for verification (reference: GET .../partners/{id}).</summary>
    [HttpGet("partners/{partnerId:guid}"), SignedIn]
    public async Task<JsonObject> Partner(Guid partnerId) =>
        await admin.PartnerDetailAsync(await current.RequireAsync(), partnerId);

    /// <summary>Edit a partner's profile (reference: PUT .../partners/{id}).</summary>
    [HttpPut("partners/{partnerId:guid}"), SignedIn]
    public async Task<JsonObject> EditPartner(Guid partnerId, ProfileFieldsIn body) =>
        await admin.PartnerUpdateAsync(await current.RequireAsync(), partnerId, body.Profile());

    /// <summary>The full bank account, for paying the partner (reference: GET .../partners/{id}/bank; payouts permission).</summary>
    [HttpGet("partners/{partnerId:guid}/bank"), SignedIn]
    public async Task<JsonObject> PartnerBank(Guid partnerId) =>
        await admin.PartnerBankAsync(await current.RequireAsync(), partnerId);

    /// <summary>Read a partner's KYC document, audited (reference: GET .../partners/{partner_id}/docs/{kind}).</summary>
    [HttpGet("partners/{partnerId:guid}/docs/{kind}"), SignedIn]
    public async Task<IActionResult> PartnerDoc(Guid partnerId, string kind)
    {
        var (data, media, fileName) = await admin.PartnerDocAsync(await current.RequireAsync(), partnerId, kind);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.ContentDisposition = $"inline; filename=\"{fileName}\"";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(data, media);
    }

    /// <summary>Upload or replace a partner's document (reference: POST .../partners/{partner_id}/docs/{kind}).</summary>
    [HttpPost("partners/{partnerId:guid}/docs/{kind}"), SignedIn]
    public async Task<JsonObject> UploadPartnerDoc(Guid partnerId, string kind, IFormFile file)
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
        return await admin.UploadPartnerDocAsync(await current.RequireAsync(), partnerId, kind, ms.ToArray());
    }

    /// <summary>Publish the partner Android app (reference: POST .../app).</summary>
    [HttpPost("app"), SignedIn, RequestSizeLimit(130_000_000)]
    public async Task<JsonObject> UploadApp(IFormFile file, [FromQuery, StringLength(20)] string version = "")
    {
        if (file is null || file.Length == 0)
            throw new AppException("Upload the Android app file (.apk)", "invalid_apk");
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        return await admin.UploadAppAsync(await current.RequireAsync(), ms.ToArray(), version);
    }

    /// <summary>Approve or reject a registration (reference: POST .../partners/{id}/kyc).</summary>
    [HttpPost("partners/{partnerId:guid}/kyc"), SignedIn]
    public async Task<JsonObject> ReviewKyc(Guid partnerId, KycIn body) =>
        await admin.KycReviewAsync(await current.RequireAsync(), partnerId, body.Action, body.Note, body.ZoneId);

    /// <summary>Switch a partner on or off (reference: POST .../partners/{id}/active).</summary>
    [HttpPost("partners/{partnerId:guid}/active"), SignedIn]
    public async Task<JsonObject> SetActive(Guid partnerId, ActiveIn body) =>
        await admin.SetActiveAsync(await current.RequireAsync(), partnerId, body.Active, body.Reason);

    // ------------------------------------------------------------------ zones (reference: delivery_admin.py)

    /// <summary>Zones with partner stats (reference: GET .../zones).</summary>
    [HttpGet("zones"), SignedIn]
    public async Task<JsonArray> Zones() => await admin.ZonesAsync(await current.RequireAsync());

    /// <summary>Add a zone (reference: POST .../zones).</summary>
    [HttpPost("zones"), SignedIn]
    public async Task<JsonObject> CreateZone(ZoneIn body)
    {
        var result = await admin.ZoneCreateAsync(await current.RequireAsync(), body.Name, body.City, body.Pincodes,
            body.IsActive, body.CenterLat, body.CenterLng);
        Response.StatusCode = 201;
        return result;
    }

    /// <summary>Edit a zone (reference: PUT .../zones/{id}).</summary>
    [HttpPut("zones/{zoneId:guid}"), SignedIn]
    public async Task<JsonObject> UpdateZone(Guid zoneId, ZoneIn body) =>
        await admin.ZoneUpdateAsync(await current.RequireAsync(), zoneId, body.Name, body.City, body.Pincodes,
            body.IsActive, body.CenterLat, body.CenterLng);

    /// <summary>Remove an empty zone (reference: DELETE .../zones/{id}).</summary>
    [HttpDelete("zones/{zoneId:guid}"), SignedIn]
    public async Task<JsonObject> DeleteZone(Guid zoneId) =>
        await admin.ZoneDeleteAsync(await current.RequireAsync(), zoneId);

    /// <summary>Move partners into a zone (reference: POST .../zones/{id}/partners).</summary>
    [HttpPost("zones/{zoneId:guid}/partners"), SignedIn]
    public async Task<JsonObject> AssignZone(Guid zoneId, AssignZoneIn body) =>
        await admin.ZoneAssignAsync(await current.RequireAsync(), zoneId, body.PartnerIds);

    public sealed record ProfileFieldsIn(
        [param: StringLength(120, MinimumLength = 2)] string? Name = null,
        [param: StringLength(80, MinimumLength = 2)] string? City = null,
        [param: StringLength(500)] string? Address = null,
        Guid? ZoneId = null,
        [param: RegularExpression("^(bike|scooter|ev|cycle|auto|van)$")] string? VehicleType = null,
        [param: StringLength(15)] string? VehicleNo = null,
        [param: StringLength(20)] string? LicenseNo = null,
        [param: RegularExpression("^(aadhaar|pan|voter|passport)$")] string? IdProofType = null,
        [param: StringLength(20)] string? IdProofNo = null)
    {
        public DeliveryProfile Profile() => new(Name, City, Address, ZoneId, VehicleType, VehicleNo, LicenseNo,
            IdProofType, IdProofNo);
    }

    public sealed record NewPartnerIn(
        [param: Required, StringLength(15, MinimumLength = 10)] string Phone = "",
        [param: Required, StringLength(120, MinimumLength = 2)] string Name = "",
        string? City = null, string? Address = null, Guid? ZoneId = null, string? VehicleType = null,
        string? VehicleNo = null, string? LicenseNo = null, string? IdProofType = null, string? IdProofNo = null)
    {
        public DeliveryProfile Profile() => new(Name, City, Address, ZoneId, VehicleType, VehicleNo, LicenseNo,
            IdProofType, IdProofNo);
    }

    public sealed record KycIn(
        [param: Required, RegularExpression("^(approve|reject)$")] string Action = "",
        [param: StringLength(500)] string Note = "",
        Guid? ZoneId = null);

    public sealed record ActiveIn([param: Required] bool Active, [param: StringLength(300)] string Reason = "");

    public sealed record ZoneIn(
        [param: Required, StringLength(80, MinimumLength = 2)] string Name = "",
        [param: Required, StringLength(80, MinimumLength = 2)] string City = "",
        JsonNode? Pincodes = null, bool IsActive = true,
        [param: Range(-90, 90)] decimal? CenterLat = null, [param: Range(-180, 180)] decimal? CenterLng = null);

    public sealed record AssignZoneIn([param: Required, MinLength(1), MaxLength(200)] Guid[] PartnerIds = null!);

    public sealed record AssignIn(Guid? SubOrderId, Guid? PartnerId, bool Direct = false, bool Force = false);

    public sealed record ReasonIn([param: Required, StringLength(300, MinimumLength = 3)] string Reason = "");

    public sealed record ResolveIn([param: Required, RegularExpression("^(retry|return)$")] string Action = "");
}
