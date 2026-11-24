namespace DAL;

using Model.DomainModel;
using Utils.Interface;

/// <summary>Staff assistant conversations and messages (reference: routers/assistant.py queries).</summary>
public class AssistantDAL(IMySqlDapperHelper db)
{
    public Task<AssistantConversationModel?> ConversationAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<AssistantConversationModel>("SELECT * FROM assistant_conversations WHERE id = @id", new { id });

    public Task<IEnumerable<AssistantConversationModel>> ConversationsAsync(Guid userId, bool archived, string q) =>
        db.QueryAsync<AssistantConversationModel>(
            "SELECT * FROM assistant_conversations WHERE user_id = @userId AND is_archived = @archived" +
            (q.Length > 0 ? " AND title LIKE @pat" : "") + " ORDER BY updated_at DESC LIMIT 100",
            new { userId, archived, pat = $"%{q}%" });

    public Task InsertConversationAsync(AssistantConversationModel c) => db.ExecuteAsync(
        "INSERT INTO assistant_conversations (id, user_id, title, context, is_archived, created_at, updated_at)" +
        " VALUES (@Id, @UserId, @Title, CAST(@Context AS JSON), @IsArchived, @CreatedAt, @UpdatedAt)", c);

    public Task PatchConversationAsync(Guid id, string? title, bool? archived, DateTime now) => db.ExecuteAsync(
        "UPDATE assistant_conversations SET title = COALESCE(@title, title)," +
        " is_archived = COALESCE(@archived, is_archived), updated_at = @now WHERE id = @id",
        new { id, title, archived, now });

    public Task DeleteConversationAsync(Guid id) =>
        db.ExecuteAsync("DELETE FROM assistant_conversations WHERE id = @id", new { id });

    public Task<IEnumerable<AssistantMessageModel>> MessagesAsync(Guid conversationId) =>
        db.QueryAsync<AssistantMessageModel>(
            "SELECT * FROM assistant_messages WHERE conversation_id = @conversationId ORDER BY created_at", new { conversationId });

    /// <summary>Action statuses by id, for marking action blocks in a conversation's messages.</summary>
    public async Task<IReadOnlyDictionary<Guid, string>> ActionStatusesAsync(Guid conversationId) =>
        (await db.QueryAsync<AssistantActionModel>(
            "SELECT * FROM assistant_actions WHERE conversation_id = @conversationId", new { conversationId }))
        .ToDictionary(a => a.Id, a => a.Status);
}
