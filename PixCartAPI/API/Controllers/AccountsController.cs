using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel.Auth;
using Utils;

namespace API.Controllers;

/// <summary>Saved addresses (/api/addresses): the reference routers/addresses.py.</summary>
[ApiController, SignedIn]
public class AddressesController(IAddressBAL addresses, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/addresses")]
    public async Task<object> List() => await addresses.ListAsync(await me.RequireAsync());

    [HttpPost("/api/addresses")]
    public async Task<IActionResult> Create([FromBody] AddressIn body) => StatusCode(201, await addresses.CreateAsync(await me.RequireAsync(), body));

    [HttpPatch("/api/addresses/{addressId}/instructions")]
    public async Task<object> Instructions(Guid addressId, [FromBody] InstructionsIn body) =>
        await addresses.SetInstructionsAsync(await me.RequireAsync(), addressId, body.Instructions);

    [HttpPatch("/api/addresses/{addressId}/location")]
    public async Task<object> Location(Guid addressId, [FromBody] LocationIn body) =>
        await addresses.SetLocationAsync(await me.RequireAsync(), addressId, body.Lat, body.Lng);

    [HttpPut("/api/addresses/{addressId}")]
    public async Task<object> Update(Guid addressId, [FromBody] AddressIn body) => await addresses.UpdateAsync(await me.RequireAsync(), addressId, body);

    [HttpDelete("/api/addresses/{addressId}")]
    public async Task<object> Delete(Guid addressId)
    {
        await addresses.DeleteAsync(await me.RequireAsync(), addressId);
        return new { ok = true };
    }
}

/// <summary>Push notification devices (/api/push): the reference routers/push.py.</summary>
[ApiController]
public class PushController(IPushBAL push, ICurrentUser me) : ControllerBase
{
    [HttpGet("/api/push/config")]
    public Task<object> Config() => push.ConfigAsync();

    [HttpPost("/api/push/tokens"), SignedIn]
    public async Task<IActionResult> Register([FromBody] PushTokenIn body)
    {
        await push.RegisterAsync(await me.RequireAsync(), body.Token!, body.Platform, body.App);
        return StatusCode(201, new { ok = true });
    }

    [HttpPost("/api/push/tokens/remove"), SignedIn]
    public async Task<object> Unregister([FromBody] PushTokenOut body)
    {
        await push.UnregisterAsync(await me.RequireAsync(), body.Token!);
        return new { ok = true };
    }
}

/// <summary>
/// The customer endpoints of the reference routers/customer.py that belong to accounts: wishlist, notifications, support
/// tickets, the product beacon and privacy (consent, export, deletion).
/// </summary>
[ApiController]
public class CustomerAccountController(
    IWishlistBAL wishlist, INotifyBAL notify, ISupportTicketBAL support, IProductEventBAL events, IAccountBAL account, ICurrentUser me) : ControllerBase
{
    // ---------------------------------------------------------------- wishlist

    [HttpGet("/api/wishlist"), SignedIn]
    public async Task<object> Wishlist() => await wishlist.ListAsync(await me.RequireAsync());

    [HttpPut("/api/wishlist/{productId}"), SignedIn]
    public async Task<object> WishlistAdd(Guid productId)
    {
        await wishlist.AddAsync(await me.RequireAsync(), productId);
        return new { ok = true };
    }

    [HttpDelete("/api/wishlist/{productId}"), SignedIn]
    public async Task<object> WishlistRemove(Guid productId)
    {
        await wishlist.RemoveAsync(await me.RequireAsync(), productId);
        return new { ok = true };
    }

    // ---------------------------------------------------------------- notifications

    [HttpGet("/api/notifications"), SignedIn]
    public async Task<object> Notifications([FromQuery] int page = 1)
    {
        var user = await me.RequireAsync();
        if (page < 1)
            throw new AppException("Page: must be at least 1", "validation_error", 422, new Dictionary<string, string> { ["page"] = "must be at least 1" });
        return await notify.MyNotificationsAsync(user, page);
    }

    [HttpPost("/api/notifications/read-all"), SignedIn]
    public async Task<object> ReadAll()
    {
        await notify.MarkAllReadAsync(await me.RequireAsync());
        return new { ok = true };
    }

    // ---------------------------------------------------------------- support tickets

    [HttpGet("/api/support/categories")]
    public object Categories() => new { categories = support.Categories.Select(kv => new { code = kv.Key, label = kv.Value }) };

    [HttpGet("/api/support/tickets"), SignedIn]
    public async Task<object> MyTickets() => await support.MyTicketsAsync(await me.RequireAsync());

    [HttpPost("/api/support/tickets"), SignedIn]
    public async Task<IActionResult> OpenTicket([FromBody] TicketIn body)
    {
        var t = await support.CreateTicketAsync(await me.RequireAsync(), body.Category!, body.Subject!, body.Message!, body.OrderId, body.IsGrievance);
        return StatusCode(201, support.TicketOut(t, []));
    }

    [HttpGet("/api/support/tickets/{ticketId}"), SignedIn]
    public async Task<object> GetTicket(Guid ticketId) => await support.GetTicketAsync(await me.RequireAsync(), ticketId);

    [HttpPost("/api/support/tickets/{ticketId}/messages"), SignedIn]
    public async Task<object> Reply(Guid ticketId, [FromBody] TicketMessageIn body) => await support.ReplyAsync(await me.RequireAsync(), ticketId, body.Body!);

    [HttpPost("/api/support/tickets/{ticketId}/rating"), RouteGuard("signed_in")]
    public async Task<object> Rate(Guid ticketId, [FromBody] TicketRatingIn body)
    {
        if (body.Rating is < 1 or > 5 || (body.Comment ?? "").Length > 500) throw new AppException("Rating must be 1 to 5 and the comment at most 500 characters", "validation_error", 422);
        return await support.RateAsync(await me.RequireAsync(), ticketId, body.Rating, body.Comment ?? "");
    }

    [HttpPost("/api/support/tickets/{ticketId}/close"), SignedIn]
    public async Task<object> Close(Guid ticketId) => await support.CloseAsync(await me.RequireAsync(), ticketId);

    // ---------------------------------------------------------------- analytics beacon

    [HttpPost("/api/events")]
    public async Task<IActionResult> Event([FromBody] EventIn body)
    {
        await events.RecordAsync(me.IpAddress, body.Type!, body.ProductId!.Value);
        return NoContent();
    }

    // ---------------------------------------------------------------- privacy (DPDP Act 2023)

    [HttpPut("/api/account/consent"), SignedIn]
    public async Task<object> Consent([FromBody] ConsentIn body) => await account.ConsentAsync(await me.RequireAsync(), body.MarketingOptIn!.Value);

    [HttpGet("/api/account/export"), SignedIn]
    public async Task<object> Export() => await account.ExportAsync(await me.RequireAsync());

    [HttpDelete("/api/account"), SignedIn]
    public async Task<object> DeleteAccount()
    {
        await account.DeleteAsync(await me.RequireAsync());
        return new { ok = true };
    }
}
