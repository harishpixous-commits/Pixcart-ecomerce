namespace BAL.Interface;

using System.Text.Json.Nodes;
using Model.DomainModel;

public interface IAssistantBAL
{
    /// <summary>Reference: routers/assistant.py get_settings — settings (masked) + languages + tool/action metadata.</summary>
    Task<JsonObject> SettingsPayloadAsync();

    /// <summary>Reference: routers/assistant.py put_settings — validates, step-up for Laya changes, audits.</summary>
    Task<JsonObject> SaveSettingsAsync(UserModel actor, JsonObject body);

    /// <summary>Reference: routers/assistant.py status — what the signed-in staff member's assistant can do.</summary>
    Task<JsonObject> StatusAsync(UserModel user);

    /// <summary>Reference: routers/assistant.py decision_test — dry-run of the decision layer.</summary>
    Task<JsonObject> DecisionTestAsync(string text);

    /// <summary>Merged runtime settings for the ask path (reference: settings.get with reveal).</summary>
    Task<JsonObject> ConfigForRunAsync();

    /// <summary>Reference: routers/assistant.py get_memory / put_memory.</summary>
    Task<JsonObject> GetMemoryAsync(UserModel user);
    Task<JsonObject> PutMemoryAsync(UserModel user, JsonArray notes);

    /// <summary>Reference: routers/assistant.py conversation endpoints.</summary>
    Task<JsonObject> ListConversationsAsync(UserModel user, bool archived, string q);
    Task<JsonObject> CreateConversationAsync(UserModel user, string title, JsonObject? context);
    Task<JsonObject> PatchConversationAsync(UserModel user, Guid convId, string? title, bool? archived);
    Task<JsonObject> DeleteConversationAsync(UserModel user, Guid convId);
    Task<JsonObject> GetConversationAsync(UserModel user, Guid convId);
    Task<AssistantDownload> DownloadMessageAsync(UserModel user, Guid messageId, string format);
    Task<AssistantDownload> DownloadConversationAsync(UserModel user, Guid conversationId, string format);
}

public sealed record AssistantDownload(byte[] Bytes, string ContentType, string FileName);
