using DAL.Helpers;
using Dapper;
using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Shop assistant tables (reference: models/shop_assistant.py). Kept apart from the admin assistant's tables.</summary>
public class ShopAssistantDAL(IMySqlDapperHelper db)
{
    // ---- sessions
    public Task<ShopChatSessionModel?> GetSessionAsync(Guid id, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<ShopChatSessionModel>("SELECT * FROM shop_chat_sessions WHERE id = @id", new { id }, tx);

    public Task<ShopChatSessionModel?> GetSessionForUpdateAsync(Guid id, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<ShopChatSessionModel>("SELECT * FROM shop_chat_sessions WHERE id = @id FOR UPDATE", new { id }, tx);

    public Task<IEnumerable<ShopChatSessionModel>> MySessionsAsync(Guid userId) =>
        db.QueryAsync<ShopChatSessionModel>(
            "SELECT * FROM shop_chat_sessions WHERE user_id = @userId ORDER BY updated_at DESC LIMIT 10", new { userId });

    public Task<int> InsertSessionAsync(ShopChatSessionModel c) =>
        db.ExecuteAsync(
            "INSERT INTO shop_chat_sessions (user_id, guest_key_hash, title, language, page, ticket_id, feedback, message_count, created_at, updated_at, id) " +
            "VALUES (@UserId, @GuestKeyHash, @Title, @Language, CAST(@Page AS JSON), @TicketId, @Feedback, @MessageCount, @CreatedAt, @UpdatedAt, @Id)", c);

    public Task<int> UpdateSessionAsync(ShopChatSessionModel c, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE shop_chat_sessions SET user_id = @UserId, guest_key_hash = @GuestKeyHash, title = @Title, language = @Language, " +
            "page = CAST(@Page AS JSON), ticket_id = @TicketId, feedback = @Feedback, message_count = @MessageCount, updated_at = @UpdatedAt WHERE id = @Id", c, tx);

    // ---- messages
    public Task<int> InsertMessageAsync(ShopChatMessageModel m, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO shop_chat_messages (session_id, role, text, blocks, model_content, intent, mode, status, voice, input_tokens, output_tokens, created_at, id) " +
            "VALUES (@SessionId, @Role, @Text, CAST(@Blocks AS JSON), CAST(@ModelContent AS JSON), @Intent, @Mode, @Status, @Voice, @InputTokens, @OutputTokens, @CreatedAt, @Id)", m, tx);

    public Task<int> UpdateMessageAsync(ShopChatMessageModel m, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE shop_chat_messages SET text = @Text, blocks = CAST(@Blocks AS JSON), model_content = CAST(@ModelContent AS JSON), " +
            "status = @Status, mode = @Mode, input_tokens = @InputTokens, output_tokens = @OutputTokens WHERE id = @Id", m, tx);

    public Task<IEnumerable<ShopChatMessageModel>> MessagesAsync(Guid sessionId, int limit = 200) =>
        db.QueryAsync<ShopChatMessageModel>(
            "SELECT * FROM shop_chat_messages WHERE session_id = @sessionId ORDER BY created_at LIMIT @limit", new { sessionId, limit });

    public Task<IEnumerable<string>> RecentUserTextsAsync(Guid sessionId, int limit = 6) =>
        db.QueryAsync<string>(
            "SELECT text FROM shop_chat_messages WHERE session_id = @sessionId AND role = 'user' ORDER BY created_at DESC LIMIT @limit",
            new { sessionId, limit });

    public Task<string?> LastAssistantIntentAsync(Guid sessionId) =>
        db.QueryFirstOrDefaultAsync<string?>(
            "SELECT intent FROM shop_chat_messages WHERE session_id = @sessionId AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
            new { sessionId });

    // ---- actions
    public Task<int> InsertActionAsync(ShopChatActionModel a, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO shop_chat_actions (session_id, user_id, kind, params, summary, status, result, created_at, decided_at, id) " +
            "VALUES (@SessionId, @UserId, @Kind, CAST(@Params AS JSON), @Summary, @Status, CAST(@Result AS JSON), @CreatedAt, @DecidedAt, @Id)", a, tx);

    public Task<ShopChatActionModel?> GetActionForUpdateAsync(Guid id, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<ShopChatActionModel>("SELECT * FROM shop_chat_actions WHERE id = @id FOR UPDATE", new { id }, tx);

    public Task<int> UpdateActionAsync(ShopChatActionModel a, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "UPDATE shop_chat_actions SET status = @Status, result = CAST(@Result AS JSON), decided_at = @DecidedAt WHERE id = @Id", a, tx);

    // ---- knowledge base
    public Task<IEnumerable<ShopKbArticleModel>> PublishedArticlesAsync() =>
        db.QueryAsync<ShopKbArticleModel>("SELECT * FROM shop_kb_articles WHERE is_published = 1 ORDER BY position");

    public Task<IEnumerable<CmsPageModel>> PublishedPagesAsync() =>
        db.QueryAsync<CmsPageModel>("SELECT * FROM cms_pages WHERE is_published = 1");

    public Task<int> BumpArticleUsesAsync(IReadOnlyList<Guid> ids) =>
        ids.Count == 0 ? Task.FromResult(0)
        : db.ExecuteAsync("UPDATE shop_kb_articles SET uses = uses + 1 WHERE id IN @ids", new { ids });

    public Task<bool> AnyArticleAsync() =>
        db.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM shop_kb_articles LIMIT 1)");

    // ---- admin: knowledge base CRUD
    public Task<IEnumerable<ShopKbArticleModel>> AllArticlesAsync() =>
        db.QueryAsync<ShopKbArticleModel>("SELECT * FROM shop_kb_articles ORDER BY position, title");

    public Task<ShopKbArticleModel?> GetArticleAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ShopKbArticleModel>("SELECT * FROM shop_kb_articles WHERE id = @id", new { id });

    public Task<int> UpdateArticleAsync(ShopKbArticleModel a) =>
        db.ExecuteAsync(
            "UPDATE shop_kb_articles SET title=@Title, body=@Body, keywords=CAST(@Keywords AS JSON), topic=@Topic, link=@Link, " +
            "is_published=@IsPublished, position=@Position, uses=@Uses, updated_at=@UpdatedAt WHERE id=@Id", a);

    public Task<int> DeleteArticleAsync(Guid id) =>
        db.ExecuteAsync("DELETE FROM shop_kb_articles WHERE id = @id", new { id });

    // ---- admin: customer chats and statistics
    public async Task<(IEnumerable<AdminChatRow> Rows, int Total)> AdminChatsAsync(int? feedback, bool escalated, string q, int offset)
    {
        var where = "c.message_count > 0";
        var p = new DynamicParameters();
        if (feedback is not null) { where += " AND c.feedback = @feedback"; p.Add("feedback", feedback); }
        if (escalated) where += " AND c.ticket_id IS NOT NULL";
        if (q.Length > 0) { where += " AND (c.title LIKE @q OR u.name LIKE @q OR u.phone LIKE @q)"; p.Add("q", "%" + q + "%"); }
        p.Add("offset", offset);
        var total = await db.ExecuteScalarAsync<int>(
            $"SELECT COUNT(*) FROM shop_chat_sessions c LEFT JOIN users u ON u.id = c.user_id WHERE {where}", p);
        var rows = await db.QueryAsync<AdminChatRow>(
            $"SELECT c.id, c.title, c.user_id AS UserId, u.name AS CustomerName, u.phone AS CustomerPhone, c.message_count AS Messages, " +
            $"c.feedback, c.language, CAST(c.page AS CHAR) AS Page, c.ticket_id AS TicketId, c.updated_at AS UpdatedAt, " +
            $"(SELECT number FROM support_tickets t WHERE t.id = c.ticket_id) AS TicketNumber " +
            $"FROM shop_chat_sessions c LEFT JOIN users u ON u.id = c.user_id WHERE {where} ORDER BY c.updated_at DESC LIMIT 25 OFFSET @offset", p);
        return (rows, total);
    }

    public sealed class AdminChatRow
    {
        public Guid Id { get; set; }
        public string Title { get; set; } = "";
        public Guid? UserId { get; set; }
        public string? CustomerName { get; set; }
        public string? CustomerPhone { get; set; }
        public int Messages { get; set; }
        public int? Feedback { get; set; }
        public string Language { get; set; } = "";
        public string Page { get; set; } = "{}";
        public Guid? TicketId { get; set; }
        public string? TicketNumber { get; set; }
        public DateTime UpdatedAt { get; set; }
    }

    public sealed class AdminChatDetailRow
    {
        public Guid Id { get; set; }
        public string Title { get; set; } = "";
        public Guid? UserId { get; set; }
        public string? CustomerName { get; set; }
        public string? CustomerPhone { get; set; }
        public int? Feedback { get; set; }
        public string Language { get; set; } = "";
        public string Page { get; set; } = "{}";
        public Guid? TicketId { get; set; }
        public string? TicketNumber { get; set; }
        public string? TicketStatus { get; set; }
    }

    public Task<AdminChatDetailRow?> AdminChatDetailAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<AdminChatDetailRow>(
            "SELECT c.id, c.title, c.user_id AS UserId, u.name AS CustomerName, u.phone AS CustomerPhone, c.feedback, c.language, " +
            "CAST(c.page AS CHAR) AS Page, c.ticket_id AS TicketId, t.number AS TicketNumber, t.status AS TicketStatus " +
            "FROM shop_chat_sessions c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN support_tickets t ON t.id = c.ticket_id WHERE c.id = @id",
            new { id });

    public async Task<AdminStatsRow> AdminStatsAsync(DateTime since)
    {
        var r = new AdminStatsRow();
        var p = new { since };
        var chats = await db.QueryFirstOrDefaultAsync<CountRow>(
            "SELECT COUNT(*) AS A, COUNT(user_id) AS B, COUNT(ticket_id) AS C FROM shop_chat_sessions WHERE created_at >= @since AND message_count > 0", p);
        r.Chats = chats?.A ?? 0; r.CustomerChats = chats?.B ?? 0; r.Escalated = chats?.C ?? 0;
        r.Helpful = await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM shop_chat_sessions WHERE created_at >= @since AND feedback = 1", p);
        r.NotHelpful = await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM shop_chat_sessions WHERE created_at >= @since AND feedback = -1", p);
        r.Messages = await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM shop_chat_messages WHERE role = 'user' AND created_at >= @since", p);
        r.VoiceMessages = await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM shop_chat_messages WHERE role = 'user' AND voice = 1 AND created_at >= @since", p);
        r.Cancellations = await db.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM shop_chat_actions WHERE kind = 'cancel_order' AND status = 'done' AND created_at >= @since", p);
        r.Intents = (await db.QueryAsync<LabelCount>(
            "SELECT intent AS Label, COUNT(*) AS N FROM shop_chat_messages WHERE role = 'user' AND created_at >= @since GROUP BY intent ORDER BY N DESC LIMIT 12", p)).ToList();
        r.Modes = (await db.QueryAsync<LabelCount>(
            "SELECT mode AS Label, COUNT(*) AS N FROM shop_chat_messages WHERE role = 'assistant' AND created_at >= @since GROUP BY mode", p)).ToList();
        r.TopArticles = (await db.QueryAsync<LabelCount>(
            "SELECT title AS Label, uses AS N FROM shop_kb_articles WHERE uses > 0 ORDER BY uses DESC LIMIT 5")).ToList();
        return r;
    }

    public sealed class CountRow { public int A { get; set; } public int B { get; set; } public int C { get; set; } }
    public sealed class LabelCount { public string Label { get; set; } = ""; public int N { get; set; } }

    public sealed class AdminStatsRow
    {
        public int Chats { get; set; }
        public int CustomerChats { get; set; }
        public int Escalated { get; set; }
        public int Helpful { get; set; }
        public int NotHelpful { get; set; }
        public int Messages { get; set; }
        public int VoiceMessages { get; set; }
        public int Cancellations { get; set; }
        public List<LabelCount> Intents { get; set; } = [];
        public List<LabelCount> Modes { get; set; } = [];
        public List<LabelCount> TopArticles { get; set; } = [];
    }

    /// <summary>Tokens used this month by a route, for the admin status card (reference: _status).</summary>
    public Task<int> TokensThisMonthAsync(string task, DateTime monthStart) =>
        db.ExecuteScalarAsync<int>(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM ai_runs WHERE task = @task AND created_at >= @monthStart",
            new { task, monthStart });

    public Task<int> InsertArticleAsync(ShopKbArticleModel a, IDbTransaction? tx = null) =>
        db.ExecuteAsync(ShopAssistantDalArticleSql.Insert, a, tx);

    public Task<IEnumerable<string>> ArticleTitlesAsync(IReadOnlyList<string> titles, IDbTransaction? tx = null) =>
        titles.Count == 0 ? Task.FromResult(Enumerable.Empty<string>())
        : db.QueryAsync<string>("SELECT title FROM shop_kb_articles WHERE title IN @titles", new { titles }, tx);

    public Task<int> MaxArticlePositionAsync(IDbTransaction? tx = null) =>
        db.ExecuteScalarAsync<int>("SELECT COALESCE(MAX(position), 0) FROM shop_kb_articles", null, tx);

    /// <summary>Products with no search words (reference: tools.find_products empty-query branch).</summary>
    public async Task<IReadOnlyList<ProductModel>> FindProductsNoWordsAsync(long? minPrice, long? maxPrice, string sort, int limit)
    {
        var p = new Dapper.DynamicParameters();
        var where = CatalogDAL.PublicFilter;
        if (minPrice is not null) { where += " AND p.price_from >= @minPrice"; p.Add("minPrice", minPrice); }
        if (maxPrice is not null) { where += " AND p.price_from <= @maxPrice"; p.Add("maxPrice", maxPrice); }
        p.Add("limit", limit);
        var rows = await db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p WHERE {where} ORDER BY {ProductSort(sort, "p.sold_count DESC")}, p.id LIMIT @limit", p);
        return rows.ToList();
    }

    /// <summary>Products matching every search word (anyWord = false) or any word (reference: the "&" then "|" passes).
    /// Words match title, brand or description; the exact phrase and brand match too.</summary>
    public async Task<IReadOnlyList<ProductModel>> FindProductsAsync(string phrase, IReadOnlyList<string> words, bool anyWord,
        long? minPrice, long? maxPrice, string sort, int limit)
    {
        var p = new Dapper.DynamicParameters();
        var conds = new List<string> { CatalogDAL.PublicFilter };
        p.Add("textLike", SqlHelpers.Contains(phrase));
        p.Add("brandExact", phrase);
        var wordConds = new List<string>();
        for (var i = 0; i < words.Count; i++)
        {
            var w = $"w{i}";
            p.Add(w, SqlHelpers.Contains(words[i]));
            wordConds.Add($"(p.title LIKE @{w} OR p.brand LIKE @{w} OR p.description LIKE @{w})");
        }
        var text = "(p.title LIKE @textLike OR p.brand LIKE @brandExact OR " +
                   (anyWord ? "(" + string.Join(" OR ", wordConds) + ")" : string.Join(" AND ", wordConds)) + ")";
        conds.Add(text);
        if (minPrice is not null) { conds.Add("p.price_from >= @minPrice"); p.Add("minPrice", minPrice); }
        if (maxPrice is not null) { conds.Add("p.price_from <= @maxPrice"); p.Add("maxPrice", maxPrice); }
        p.Add("textPrefix", SqlHelpers.StartsWith(phrase));
        p.Add("textWord", "% " + SqlHelpers.StartsWith(phrase));
        p.Add("limit", limit);
        var rank = "((p.title = @brandExact) * 4 + (p.title LIKE @textPrefix) * 2 + (p.title LIKE @textWord))";
        var rows = await db.QueryAsync<ProductModel>(
            $"SELECT p.* FROM products p WHERE {string.Join(" AND ", conds)} " +
            $"ORDER BY {ProductSort(sort, $"p.in_stock DESC, {rank} DESC, p.sold_count DESC")}, p.id LIMIT @limit", p);
        return rows.ToList();
    }

    private static string ProductSort(string sort, string relevance) => sort switch
    {
        "price_asc" => "p.price_from ASC",
        "price_desc" => "p.price_from DESC",
        "rating" => "p.rating_avg DESC, p.rating_count DESC",
        "discount" => "(p.mrp_from - p.price_from) * 100.0 / NULLIF(p.mrp_from, 0) DESC",
        _ => relevance,
    };
}

/// <summary>KB article writes for the starter seeder (admin CRUD lives in ShopKbAdminDAL).</summary>
public static class ShopAssistantDalArticleSql
{
    public const string Insert =
        "INSERT INTO shop_kb_articles (title, body, keywords, topic, link, is_published, position, uses, created_at, updated_at, id) " +
        "VALUES (@Title, @Body, CAST(@Keywords AS JSON), @Topic, @Link, @IsPublished, @Position, @Uses, @CreatedAt, @UpdatedAt, @Id)";
}
