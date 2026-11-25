namespace DAL;

using Model.DomainModel;
using Utils.Interface;

/// <summary>Assistant ask-path persistence (reference: routers/assistant.py ask + agent.run saves).</summary>
public partial class AssistantDAL
{
    /// <summary>Insert a conversation message (user question or assistant reply).</summary>
    public Task InsertMessageAsync(AssistantMessageModel m) => db.ExecuteAsync(
        "INSERT INTO assistant_messages (id, conversation_id, role, text, blocks, model_content, status, mode, upload_ids," +
        " input_tokens, output_tokens, created_at) VALUES (@Id, @ConversationId, @Role, @Text, @Blocks, @ModelContent," +
        " @Status, @Mode, @UploadIds, @InputTokens, @OutputTokens, @CreatedAt)", m);

    /// <summary>Reference: agent.run — retitle a fresh chat from the first question, refresh updated_at, store the page context.</summary>
    public Task TouchForAskAsync(Guid id, string? title, string? context, DateTime now) => db.ExecuteAsync(
        "UPDATE assistant_conversations SET title = COALESCE(@title, title)," +
        " context = COALESCE(@context, context), updated_at = @now WHERE id = @id",
        new { id, title, context, now });
}
