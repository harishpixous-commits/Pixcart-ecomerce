using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Staff seller KYC operations (reference: routers/admin.py — same paths, bodies and payloads).
/// </summary>
[ApiController]
[Route("/api/admin")]
[SignedIn]
public class AdminSellersController(ISellerModerationBAL sellers, ICurrentUser current) : ControllerBase
{
    /// <summary>Seller profile with owner and product counts (reference: GET /api/admin/sellers/{seller_id}).</summary>
    [HttpGet("sellers/{sellerId}")]
    public async Task<JsonObject> Get(Guid sellerId) =>
        await sellers.GetAsync(await current.RequireAsync(), sellerId);

    /// <summary>Approve a seller (reference: POST /api/admin/sellers/{seller_id}/approve).</summary>
    [HttpPost("sellers/{sellerId}/approve")]
    public async Task<JsonObject> Approve(Guid sellerId) =>
        await sellers.ApproveAsync(await current.RequireAsync(), sellerId);

    public sealed record ReasonIn([param: Required, MinLength(5), MaxLength(1000)] string Reason);

    /// <summary>Send the application back to the seller (reference: POST /api/admin/sellers/{seller_id}/reject).</summary>
    [HttpPost("sellers/{sellerId}/reject")]
    public async Task<JsonObject> Reject(Guid sellerId, ReasonIn body) =>
        await sellers.RejectAsync(await current.RequireAsync(), sellerId, body.Reason.Trim());

    /// <summary>Suspend an approved seller (reference: POST /api/admin/sellers/{seller_id}/suspend).</summary>
    [HttpPost("sellers/{sellerId}/suspend")]
    public async Task<JsonObject> Suspend(Guid sellerId, ReasonIn body) =>
        await sellers.SuspendAsync(await current.RequireAsync(), sellerId, body.Reason.Trim());

    public sealed record CommissionIn([param: Range(0, 5000)] int? CommissionBpsOverride = null);

    /// <summary>Set or clear a commission override (reference: PUT /api/admin/sellers/{seller_id}/commission).</summary>
    [HttpPut("sellers/{sellerId}/commission")]
    public async Task<JsonObject> Commission(Guid sellerId, CommissionIn body) =>
        await sellers.CommissionAsync(await current.RequireAsync(), sellerId, body.CommissionBpsOverride);
}
