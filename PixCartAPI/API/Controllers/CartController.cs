using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>
/// The shopper's cart and "Saved for later" (reference: routers/cart.py — same paths, bodies and payload). Signed-in
/// shoppers only; a visitor's cart lives in their browser and merges here at sign-in.
/// </summary>
[ApiController]
[Route("/api/cart")]
[SignedIn]
public class CartController(ICartBAL cart, ICurrentUser current) : ControllerBase
{
    /// <summary>One cart line change: qty 1..10; 0 on PUT removes the line.</summary>
    public sealed record SetQty(
        [param: Required] Guid VariantId,
        [param: Range(0, 10, ErrorMessage = "Quantity must be between 0 and 10")] int Qty);

    /// <summary>The browser cart merging into the account at sign-in.</summary>
    public sealed record MergeIn([param: MaxLength(50)] List<SetQty> Items);

    [HttpGet("")]
    public async Task<JsonObject> Get() => await cart.ViewAsync(await UserId());

    [HttpPost("items")]
    public async Task<JsonObject> AddItem(SetQty body)
    {
        if (body.Qty < 1) throw new Utils.AppException("Quantity must be at least 1", "invalid_qty");
        var note = await cart.SetAsync(await UserId(), body.VariantId, body.Qty, add: true);
        var view = await cart.ViewAsync(await UserId());
        view["notice"] = note;
        return view;
    }

    [HttpPut("items")]
    public async Task<JsonObject> SetItem(SetQty body)
    {
        var note = await cart.SetAsync(await UserId(), body.VariantId, body.Qty);
        var view = await cart.ViewAsync(await UserId());
        view["notice"] = note;
        return view;
    }

    [HttpPost("merge")]
    public async Task<JsonObject> Merge(MergeIn body) =>
        await cart.MergeAsync(await UserId(), body.Items.Select(i => (i.VariantId, i.Qty)).ToList());

    [HttpGet("saved")]
    public async Task<JsonObject> Saved() => await cart.SavedViewAsync(await UserId());

    [HttpPost("items/{variantId}/save-for-later")]
    public async Task<JsonObject> SaveForLater(Guid variantId) => await cart.SaveForLaterAsync(await UserId(), variantId);

    [HttpPost("saved/{variantId}/move-to-cart")]
    public async Task<JsonObject> MoveToCart(Guid variantId) => await cart.MoveToCartAsync(await UserId(), variantId);

    [HttpDelete("saved/{variantId}")]
    public async Task<JsonObject> DeleteSaved(Guid variantId) => await cart.DeleteSavedAsync(await UserId(), variantId);

    private async Task<Guid> UserId() => (await current.RequireAsync()).Id;
}