using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>
/// The shopper's wishlist (reference: routers/customer.py — same paths and payloads). Signed-in shoppers only.
/// </summary>
[ApiController]
[Route("/api/wishlist")]
[SignedIn]
public class WishlistController(IWishlistBAL wishlist, ICurrentUser current) : ControllerBase
{
    [HttpGet("")]
    public async Task<JsonObject> Get() => await wishlist.ListAsync(await UserId());

    [HttpPut("{productId:guid}")]
    public async Task<JsonObject> Add(Guid productId) => await wishlist.AddAsync(await UserId(), productId);

    [HttpDelete("{productId:guid}")]
    public async Task<JsonObject> Remove(Guid productId) => await wishlist.RemoveAsync(await UserId(), productId);

    private async Task<Guid> UserId() => (await current.RequireAsync()).Id;
}
