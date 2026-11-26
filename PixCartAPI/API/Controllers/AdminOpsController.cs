using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Cross-module staff operations (reference: routers/admin.py — same paths, bodies and payloads): package
/// cancel/deliver, refund list/retry/settle, customer block/unblock and platform settings.
/// </summary>
[ApiController]
[Route("/api/admin")]
[SignedIn]
public class AdminOpsController(IAdminOpsBAL adminOps, ICurrentUser current) : ControllerBase
{
    public sealed record ReasonIn([param: Required, MinLength(5), MaxLength(1000)] string Reason);

    /// <summary>Cancel a package and refund what is owed (reference: POST /api/admin/sub-orders/{sub_id}/cancel).</summary>
    [HttpPost("sub-orders/{subId}/cancel")]
    public async Task<JsonObject> Cancel(Guid subId, ReasonIn body) =>
        await adminOps.CancelSubOrderAsync(await current.RequireAsync(), subId, body.Reason.Trim());

    /// <summary>Mark a package delivered (reference: POST /api/admin/sub-orders/{sub_id}/deliver).</summary>
    [HttpPost("sub-orders/{subId}/deliver")]
    public async Task<JsonObject> Deliver(Guid subId) =>
        await adminOps.DeliverSubOrderAsync(await current.RequireAsync(), subId);

    /// <summary>Refund list (reference: GET /api/admin/refunds).</summary>
    [HttpGet("refunds")]
    public async Task<JsonObject> Refunds(
        [FromQuery, RegularExpression("^(pending|processed|failed)$")] string? status,
        [FromQuery, MaxLength(40)] string q = "",
        [FromQuery, Range(1, 100000)] int page = 1) =>
        await adminOps.ListRefundsAsync(await current.RequireAsync(), status, q, page);

    /// <summary>Requeue a failed refund (reference: POST /api/admin/refunds/{refund_id}/retry).</summary>
    [HttpPost("refunds/{refundId}/retry")]
    public async Task<JsonObject> RetryRefund(Guid refundId) =>
        await adminOps.RetryRefundAsync(await current.RequireAsync(), refundId);

    public sealed record SettleIn(
        [param: Required, RegularExpression("^(upi|neft|imps|rtgs|cheque|other)$")] string Method,
        [param: Required, MinLength(4), MaxLength(40), RegularExpression("^[A-Za-z0-9\\-/ ]+$")] string Reference);

    /// <summary>Record a refund paid outside the gateway (reference: POST /api/admin/refunds/{refund_id}/settle).</summary>
    [HttpPost("refunds/{refundId}/settle")]
    public async Task<JsonObject> SettleRefund(Guid refundId, SettleIn body) =>
        await adminOps.SettleRefundAsync(await current.RequireAsync(), refundId, body.Method, body.Reference);

    /// <summary>Block a customer and revoke their sessions (reference: POST /api/admin/customers/{user_id}/block).</summary>
    [HttpPost("customers/{userId}/block")]
    public async Task<JsonObject> Block(Guid userId, ReasonIn body) =>
        await adminOps.BlockUserAsync(await current.RequireAsync(), userId, body.Reason.Trim());

    /// <summary>Unblock a customer (reference: POST /api/admin/customers/{user_id}/unblock).</summary>
    [HttpPost("customers/{userId}/unblock")]
    public async Task<JsonObject> Unblock(Guid userId) =>
        await adminOps.UnblockUserAsync(await current.RequireAsync(), userId);

    /// <summary>Current platform settings (reference: GET /api/admin/settings).</summary>
    [HttpGet("settings")]
    public async Task<JsonObject> ReadSettings() =>
        await adminOps.ReadSettingsAsync(await current.RequireAsync());

    /// <summary>Merge platform setting updates (reference: PUT /api/admin/settings).</summary>
    [HttpPut("settings")]
    public async Task<JsonObject> WriteSettings([FromBody] JsonObject body) =>
        await adminOps.WriteSettingsAsync(await current.RequireAsync(), body);
}
