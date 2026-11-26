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

    /// <summary>Reject a pending listing or take down a live one (reference: POST /api/admin/products/{product_id}/reject).</summary>
    [HttpPost("products/{productId}/reject")]
    public async Task<JsonObject> Reject(Guid productId, ReasonIn body) =>
        await products.RejectAsync(await current.RequireAsync(), productId, body.Reason.Trim());
}
