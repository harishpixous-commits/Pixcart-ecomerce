namespace DAL;

using Model.DomainModel;
using Utils.Interface;

/// <summary>Staff assistant conversations and messages (reference: routers/assistant.py queries).</summary>
public partial class AssistantDAL(IMySqlDapperHelper db)
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

    // ------------------------------------------------------------------ action rows (assistant actions slice)

    public Task InsertActionAsync(AssistantActionModel a) =>
        db.ExecuteAsync(
            "INSERT INTO assistant_actions (conversation_id, user_id, kind, params, summary, status, result, created_at, decided_at, id) " +
            "VALUES (@ConversationId, @UserId, @Kind, CAST(@Params AS JSON), @Summary, @Status, CAST(@Result AS JSON), @CreatedAt, @DecidedAt, @Id)", a);

    /// <summary>One action row, locked (reference: routers/assistant.py _action FOR UPDATE).</summary>
    public Task<AssistantActionModel?> ActionForUpdateAsync(Guid actionId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<AssistantActionModel>("SELECT * FROM assistant_actions WHERE id = @actionId FOR UPDATE", new { actionId });

    public Task SaveActionDecisionAsync(Guid actionId, string status, DateTime decidedAt, string result, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE assistant_actions SET status = @status, decided_at = @decidedAt, result = CAST(@result AS JSON) WHERE id = @actionId",
            new { actionId, status, decidedAt, result });

    public Task SaveActionStatusAsync(Guid actionId, string status, IUnitOfWork uow) =>
        uow.ExecuteAsync("UPDATE assistant_actions SET status = @status WHERE id = @actionId", new { actionId, status });
}
