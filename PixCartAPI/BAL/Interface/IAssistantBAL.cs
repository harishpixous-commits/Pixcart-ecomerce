using System.Text.Json.Nodes;
using Model.DomainModel;
using Model.DomainModel.AI;

namespace BAL.Interface;

/// <summary>
/// The admin AI assistant: chats (streamed), file uploads, confirm-before-run actions, downloads, memory, settings, and
/// Admin → AI providers (LLM connections and fallback routes).
/// </summary>
public interface IAssistantBAL
{
    Task<JsonObject> StatusAsync(UserModel user);
    Task<JsonObject> GetSettingsAsync();
    Task<JsonObject> PutSettingsAsync(JsonObject body, UserModel admin);
    Task<JsonObject> DecisionTestAsync(string text);

    Task<JsonObject> ConversationsAsync(UserModel user, bool archived, string q);
    Task<JsonObject> CreateConversationAsync(UserModel user, AssistantConversationIn body);
    Task<JsonObject> PatchConversationAsync(UserModel user, Guid id, AssistantConversationPatch body);
    Task DeleteConversationAsync(UserModel user, Guid id);
    Task<JsonObject> ConversationAsync(UserModel user, Guid id);

    /// <summary>Checks the request (switch, ownership, permissions, rate limit) before anything is streamed.</summary>
    Task PrepareAskAsync(UserModel user, Guid conversationId, AssistantAskIn body);

    /// <summary>Answers one question, calling emit for every event (start, decision, tool, card, text, done | error).</summary>
    Task AskAsync(UserModel user, Guid conversationId, AssistantAskIn body, Func<JsonObject, Task> emit, CancellationToken ct);

    Task<JsonObject> UploadAsync(UserModel user, string filename, string contentType, byte[] data);
    Task DeleteUploadAsync(UserModel user, Guid id);
    Task<JsonObject> DecideActionAsync(UserModel user, Guid actionId, string decision);
    Task<(byte[] Data, string ContentType, string FileName)> DownloadMessageAsync(UserModel user, Guid messageId, string fmt);
    Task<(byte[] Data, string ContentType, string FileName)> DownloadConversationAsync(UserModel user, Guid conversationId, string fmt);
    Task<JsonObject> MemoryAsync(UserModel user);
    Task<JsonObject> PutMemoryAsync(UserModel user, List<string> notes);

    Task<JsonObject> ProvidersAsync();
    Task<JsonObject> AddConnectionAsync(LlmConnectionIn body, UserModel admin);
    Task<JsonObject> EditConnectionAsync(string connId, LlmConnectionIn body, UserModel admin);
    Task<JsonObject> RemoveConnectionAsync(string connId, UserModel admin);
    Task<JsonObject> TestConnectionAsync(string connId, string model, UserModel admin);
    Task<JsonObject> PutRoutesAsync(LlmRoutesIn body, UserModel admin);
}
