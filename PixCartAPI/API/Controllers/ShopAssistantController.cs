using System.ComponentModel.DataAnnotations;
using System.Text;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;

namespace API.Controllers;

/// <summary>Customer-facing shop assistant API, the chat on the storefront (reference: routers/shop_assistant.py).
/// Guests may chat when Admin allows it; their chat is reachable only with the session key their browser received
/// (X-Chat-Key). Signed-in customers own their chats; a guest chat becomes theirs when they sign in and continue it.</summary>
[ApiController]
[Route("/api/shop-assistant")]
public class ShopAssistantController(IShopAssistantBAL bal, ICurrentUser current) : ControllerBase
{
    private string ChatKey => Request.Headers["X-Chat-Key"].FirstOrDefault() ?? "";

    [HttpGet("config")]
    public async Task<JsonObject> Config() => await bal.ConfigAsync(await current.GetAsync());

    public sealed record StartIn(JsonObject? Page);

    [HttpPost("sessions")]
    public async Task<IActionResult> Start([FromBody] StartIn? body)
    {
        var outp = await bal.StartAsync(await current.GetAsync(), body?.Page ?? [], current.IpAddress);
        return StatusCode(201, outp);
    }

    [HttpGet("sessions")]
    [SignedIn]
    public async Task<JsonObject> MyChats() => await bal.MyChatsAsync(await current.RequireAsync());

    [HttpGet("sessions/{chatId}")]
    public async Task<JsonObject> GetChat(Guid chatId) =>
        await bal.GetChatAsync(await current.GetAsync(), chatId, ChatKey);

    public sealed record MessageIn(
        [Required, StringLength(2000, MinimumLength = 1)] string Text,
        bool Voice = false,
        JsonObject? Page = null);

    /// <summary>One customer message; the reply streams as server-sent events (reference: send -> agent.run).</summary>
    [HttpPost("sessions/{chatId}/messages")]
    public async Task Send(Guid chatId, [FromBody] MessageIn body, CancellationToken cancellationToken)
    {
        var user = await current.GetAsync();
        // Pull the first event before touching the response: access and validation failures thrown while
        // preparing the reply (unknown chat, wrong key, rate limit) must still produce their HTTP status.
        await using var stream = bal
            .SendAsync(user, chatId, ChatKey, body.Text.Trim(), body.Voice, body.Page, current.IpAddress, cancellationToken)
            .GetAsyncEnumerator(cancellationToken);
        if (!await stream.MoveNextAsync()) return;
        Response.StatusCode = 200;
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";
        do
        {
            var line = "data: " + stream.Current.ToJsonString() + "\n\n";
            await Response.Body.WriteAsync(Encoding.UTF8.GetBytes(line), cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }
        while (await stream.MoveNextAsync());
    }

    public sealed record TicketIn(
        [Required] string Category,
        [Required, StringLength(200, MinimumLength = 5)] string Subject,
        [Required, StringLength(5000, MinimumLength = 10)] string Message,
        Guid? OrderId = null,
        bool Grievance = false);

    /// <summary>Sends the support request the assistant prepared, with the chat attached (reference: raise_ticket).</summary>
    [HttpPost("sessions/{chatId}/ticket")]
    [SignedIn]
    public async Task<IActionResult> RaiseTicket(Guid chatId, [FromBody] TicketIn body)
    {
        var outp = await bal.RaiseTicketAsync(await current.RequireAsync(), chatId, ChatKey,
            body.Category, body.Subject, body.Message, body.OrderId, body.Grievance);
        return StatusCode(201, outp);
    }

    /// <summary>The customer pressed Confirm on a prepared change (reference: confirm).</summary>
    [HttpPost("actions/{actionId}/confirm")]
    [SignedIn]
    public async Task<JsonObject> Confirm(Guid actionId) =>
        await bal.ConfirmActionAsync(await current.RequireAsync(), actionId);

    [HttpPost("actions/{actionId}/dismiss")]
    [SignedIn]
    public async Task<JsonObject> Dismiss(Guid actionId) =>
        await bal.DismissActionAsync(await current.RequireAsync(), actionId);

    public sealed record FeedbackIn([Range(-1, 1)] int Value);

    [HttpPost("sessions/{chatId}/feedback")]
    public async Task<JsonObject> Feedback(Guid chatId, [FromBody] FeedbackIn body) =>
        await bal.FeedbackAsync(await current.GetAsync(), chatId, ChatKey, body.Value);
}
