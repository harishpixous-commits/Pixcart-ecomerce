using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>The customer-facing shop assistant (the chat on the storefront). Reference: routers/shop_assistant.py +
/// shop_assistant/*. Guests chat with a session key; signed-in customers own their chats.</summary>
public interface IShopAssistantBAL
{
    Task<JsonObject> ConfigAsync(UserModel? user);
    Task<JsonObject> StartAsync(UserModel? user, JsonObject page, string ip);
    Task<JsonObject> MyChatsAsync(UserModel user);
    Task<JsonObject> GetChatAsync(UserModel? user, Guid chatId, string chatKey);
    /// <summary>The reply pipeline as a stream of events (start, card, text, done / error) for the SSE endpoint.</summary>
    IAsyncEnumerable<JsonObject> SendAsync(UserModel? user, Guid chatId, string chatKey, string text, bool voice, JsonObject? page, string ip, CancellationToken ct = default);
    Task<JsonObject> RaiseTicketAsync(UserModel user, Guid chatId, string chatKey, string category, string subject, string message, Guid? orderId, bool grievance);
    Task<JsonObject> ConfirmActionAsync(UserModel user, Guid actionId);
    Task<JsonObject> DismissActionAsync(UserModel user, Guid actionId);
    Task<JsonObject> FeedbackAsync(UserModel? user, Guid chatId, string chatKey, int value);
}
