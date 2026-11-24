using DAL.Helpers;
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
