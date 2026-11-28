using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>
/// Staff product moderation (reference: routers/admin.py — same paths, bodies and payloads).
/// </summary>
[ApiController]
[Route("/api/admin")]
[SignedIn]
public class AdminProductsController(IProductModerationBAL products, ICurrentUser current) : ControllerBase
{
    /// <summary>Approve a pending listing (reference: POST /api/admin/products/{product_id}/approve).</summary>
    [HttpPost("products/{productId}/approve")]
    public async Task<JsonObject> Approve(Guid productId) =>
        await products.ApproveAsync(await current.RequireAsync(), productId);

    public sealed record ReasonIn([param: Required, MinLength(5), MaxLength(1000)] string Reason);

    public sealed record PublishAtIn(DateTimeOffset? PublishAt);

    /// <summary>Staff sets or clears a listing's go-live time.</summary>
    [HttpPut("products/{productId}/publish-at")]
    public async Task<JsonObject> SetPublishAt(Guid productId, PublishAtIn body) =>
        await products.SetPublishAtAsync(await current.RequireAsync(), productId, body.PublishAt);

    public sealed record UnitLimitIn([param: Range(0, 100)] int MaxQty);

    /// <summary>Staff sets the most units of one option an order may hold (0 removes it). No new approval round.</summary>
    [HttpPut("products/{productId}/unit-limit")]
    public async Task<JsonObject> SetUnitLimit(Guid productId, UnitLimitIn body) =>
        await products.SetUnitLimitAsync(await current.RequireAsync(), productId, body.MaxQty);

    /// <summary>Reject a pending listing or take down a live one (reference: POST /api/admin/products/{product_id}/reject).</summary>
    [HttpPost("products/{productId}/reject")]
    public async Task<JsonObject> Reject(Guid productId, ReasonIn body) =>
        await products.RejectAsync(await current.RequireAsync(), productId, body.Reason.Trim());
}
