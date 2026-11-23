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
    DeliveryAdminBAL admin, IDeliveryFleetBAL fleet, ICurrentUser current) : ControllerBase
{
    /// <summary>The dispatch queue (reference: GET /api/admin/delivery/queue).</summary>
    [HttpGet("queue"), SignedIn]
    public async Task<JsonObject> Queue([FromQuery, RegularExpression("^(waiting|offered|failed|returns)$")] string tab = "waiting") =>
        await admin.QueueAsync(await current.RequireAsync(), tab);

    /// <summary>Partners who could take a package, best first (reference: GET .../packages/{sub_id}/candidates).</summary>
    [HttpGet("packages/{subOrderId:guid}/candidates"), SignedIn]
    public async Task<JsonArray> Candidates(Guid subOrderId) =>
        await admin.CandidatesAsync(await current.RequireAsync(), subOrderId);

    /// <summary>Offer or assign a package to a chosen partner (reference: POST .../assign).</summary>
    [HttpPost("assign"), SignedIn]
    public async Task<JsonObject> Assign(AssignIn body)
    {
        var user = await current.RequireAsync();
        if (body.SubOrderId is null || body.PartnerId is null)
            throw new AppException("Choose a package and a partner", "required", 422);
        return await fleet.AssignByStaffAsync(user, body.SubOrderId.Value, body.PartnerId.Value, body.Direct, body.Force);
    }

    /// <summary>Run auto-assignment now (reference: POST .../packages/{sub_id}/auto-assign).</summary>
    [HttpPost("packages/{subOrderId:guid}/auto-assign"), SignedIn]
    public async Task<JsonObject> RunAuto(Guid subOrderId) =>
        await fleet.AutoAssignByStaffAsync(await current.RequireAsync(), subOrderId);

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

    public sealed record AssignIn(Guid? SubOrderId, Guid? PartnerId, bool Direct = false, bool Force = false);

    public sealed record ReasonIn([param: Required, StringLength(300, MinimumLength = 3)] string Reason = "");

    public sealed record ResolveIn([param: Required, RegularExpression("^(retry|return)$")] string Action = "");
}
