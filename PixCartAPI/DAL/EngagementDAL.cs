using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Product Q&A, stock alerts, comparison and bought-together reads (reference: routers/engagement.py).</summary>
public class EngagementDAL(IMySqlDapperHelper db)
{
    public class QuestionRow : ProductQuestionModel
    {
        public string? Name { get; set; }
    }

    public class AnswerRow : ProductAnswerModel
    {
        public string? Name { get; set; }
    }

    public Task<ProductModel?> PublicProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>(
            "SELECT * FROM products WHERE slug = @slug AND status = 'approved' AND price_from > 0 " +
            "AND seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)", new { slug });

    public Task<ProductQuestionModel?> GetQuestionAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductQuestionModel>("SELECT * FROM product_questions WHERE id = @id", new { id });

    public Task<ProductAnswerModel?> GetAnswerAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductAnswerModel>("SELECT * FROM product_answers WHERE id = @id", new { id });

    public Task<ProductModel?> GetProductAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id });

    public Task<SellerModel?> GetSellerAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id });

    public Task<SellerModel?> SellerByUserAsync(Guid userId) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE user_id = @userId", new { userId });

    public Task<UserModel?> GetUserAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id });

    /// <summary>A delivered package containing the product, if any (reference: _is_buyer).</summary>
    public async Task<bool> IsBuyerAsync(Guid userId, Guid productId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id JOIN order_items i ON i.sub_order_id = s.id " +
            "WHERE o.user_id = @userId AND i.product_id = @productId AND s.status = 'delivered' LIMIT 1", new { userId, productId }) > 0;

    /// <summary>Published questions with asker names for the listing (reference: questions).</summary>
    public async Task<(List<QuestionRow> Rows, long Total)> QuestionsAsync(Guid productId, string? like, string sort, int offset, int size)
    {
        var where = "q.product_id = @productId AND q.status = 'published'";
        if (like is not null)
        {
            // utf8mb4's default collation is case-insensitive, so LIKE matches the reference's ilike.
            where += " AND (q.text LIKE @like OR q.id IN (SELECT question_id FROM product_answers WHERE status = 'published' AND text LIKE @like))";
        }
        var order = sort == "helpful" ? "q.answer_count DESC, q.created_at DESC" : "q.created_at DESC";
        var total = await db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM product_questions q WHERE {where}", new { productId, like });
        var rows = await db.QueryAsync<QuestionRow>(
            $"SELECT q.*, u.name FROM product_questions q LEFT JOIN users u ON u.id = q.user_id WHERE {where} " +
            $"ORDER BY {order}, q.id LIMIT {size} OFFSET {offset}", new { productId, like });
        return (rows.ToList(), total);
    }

    /// <summary>Published answers for the given questions, seller first then most helpful (reference: questions).</summary>
    public Task<IEnumerable<AnswerRow>> AnswersForAsync(IReadOnlyList<Guid> questionIds) =>
        db.QueryAsync<AnswerRow>(
            "SELECT a.*, u.name FROM product_answers a LEFT JOIN users u ON u.id = a.user_id " +
            "WHERE a.question_id IN @questionIds AND a.status = 'published' ORDER BY a.role = 'seller' DESC, a.helpful_count DESC, a.created_at",
            new { questionIds });

    /// <summary>The answers this user already voted on.</summary>
    public async Task<HashSet<Guid>> VotedAsync(Guid userId, IReadOnlyList<Guid> answerIds)
    {
        if (answerIds.Count == 0) return [];
        var rows = await db.QueryAsync<Guid>(
            "SELECT CAST(answer_id AS CHAR) FROM answer_votes WHERE user_id = @userId AND answer_id IN @answerIds", new { userId, answerIds });
        return rows.ToHashSet();
    }

    public Task<AnswerVoteModel?> GetVoteAsync(Guid answerId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<AnswerVoteModel>(
            "SELECT * FROM answer_votes WHERE answer_id = @answerId AND user_id = @userId", new { answerId, userId });

    public Task<VariantModel?> GetVariantAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id = @id", new { id });

    public Task<StockAlertModel?> GetAlertAsync(Guid userId, Guid variantId) =>
        db.QueryFirstOrDefaultAsync<StockAlertModel>(
            "SELECT * FROM stock_alerts WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    public async Task<long> ActiveAlertCountAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM stock_alerts WHERE user_id = @userId AND active = 1", new { userId });

    /// <summary>One active alert row: the alert, its variant's label parts and its product's card fields.</summary>
    public class AlertRow
    {
        public Guid VariantId { get; set; }
        public DateTime CreatedAt { get; set; }
        public string Options { get; set; } = "null";
        public int Stock { get; set; }
        public Guid ProductId { get; set; }
        public string Title { get; set; } = "";
        public string Slug { get; set; } = "";
    }

    /// <summary>The shopper's active alerts with their variants and products (reference: my_alerts).</summary>
    public async Task<List<AlertRow>> MyAlertsAsync(Guid userId, Guid? variantId)
    {
        var where = "a.user_id = @userId AND a.active = 1" + (variantId is null ? "" : " AND a.variant_id = @variantId");
        var rows = await db.QueryAsync<AlertRow>(
            $"SELECT a.variant_id, a.created_at, v.options, v.stock, v.product_id, p.title, p.slug " +
            $"FROM stock_alerts a JOIN variants v ON v.id = a.variant_id JOIN products p ON p.id = v.product_id " +
            $"WHERE {where} ORDER BY a.created_at DESC", new { userId, variantId });
        return rows.ToList();
    }

    /// <summary>Products still on sale in the requested order (reference: compare_rows).</summary>
    public async Task<List<ProductModel>> CompareRowsAsync(IReadOnlyList<Guid> ids)
    {
        var rows = await db.QueryAsync<ProductModel>(
            "SELECT * FROM products WHERE id IN @ids AND status = 'approved' AND price_from > 0 " +
            "AND seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)", new { ids });
        var byId = rows.ToDictionary(p => p.Id);
        return ids.Where(byId.ContainsKey).Select(i => byId[i]).ToList();
    }

    /// <summary>Products most often in the same order as this one, last 180 days, live orders, still on sale (reference: bought_together).</summary>
    public Task<IEnumerable<ProductModel>> BoughtTogetherAsync(Guid productId, int limit) =>
        db.QueryAsync<ProductModel>(
            "SELECT p.* FROM products p JOIN (" +
            "  SELECT i.product_id, COUNT(DISTINCT s.order_id) AS n FROM order_items i JOIN sub_orders s ON s.id = i.sub_order_id " +
            "  WHERE s.order_id IN (SELECT s2.order_id FROM sub_orders s2 JOIN order_items i2 ON i2.sub_order_id = s2.id " +
            "    WHERE i2.product_id = @productId AND s2.status IN ('confirmed','packed','shipped','delivered') AND s2.created_at >= @since) " +
            "  AND i.product_id != @productId AND s.status IN ('confirmed','packed','shipped','delivered') GROUP BY i.product_id" +
            ") x ON x.product_id = p.id " +
            "WHERE p.status = 'approved' AND p.price_from > 0 AND p.in_stock = 1 " +
            "AND p.seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0) " +
            $"ORDER BY x.n DESC, p.sold_count DESC LIMIT {limit}",
            new { productId, since = DateTime.UtcNow.AddDays(-180) });

    // ------------------------------------------------------------------ seller hub

    public class SellerQuestionRow : ProductQuestionModel
    {
        public string ProductTitle { get; set; } = "";
        public string ProductSlug { get; set; } = "";
    }

    /// <summary>The seller's published questions with product names (reference: seller_questions).</summary>
    public async Task<(List<SellerQuestionRow> Rows, long Total, long Waiting)> SellerQuestionsAsync(Guid sellerId, bool unansweredOnly, int page)
    {
        var where = "p.seller_id = @sellerId AND q.status = 'published'";
        var unanswered = "q.id NOT IN (SELECT question_id FROM product_answers WHERE role = 'seller')";
        if (unansweredOnly) where += $" AND {unanswered}";
        var total = await db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM product_questions q JOIN products p ON p.id = q.product_id WHERE {where}", new { sellerId });
        var rows = await db.QueryAsync<SellerQuestionRow>(
            $"SELECT q.*, p.title AS product_title, p.slug AS product_slug FROM product_questions q JOIN products p ON p.id = q.product_id " +
            $"WHERE {where} ORDER BY q.created_at DESC LIMIT 20 OFFSET {(page - 1) * 20}", new { sellerId });
        var waiting = await db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM product_questions q JOIN products p ON p.id = q.product_id " +
            $"WHERE p.seller_id = @sellerId AND q.status = 'published' AND {unanswered}", new { sellerId });
        return (rows.ToList(), total, waiting);
    }

    /// <summary>All non-hidden answers for the given questions (reference: seller_questions).</summary>
    public Task<IEnumerable<ProductAnswerModel>> SellerAnswersForAsync(IReadOnlyList<Guid> questionIds) =>
        db.QueryAsync<ProductAnswerModel>(
            "SELECT * FROM product_answers WHERE question_id IN @questionIds AND status != 'hidden' ORDER BY created_at", new { questionIds });

    /// <summary>Small counts for the seller hub menu (reference: seller_badges).</summary>
    public async Task<(long Orders, long Questions, long Reports, long Deals)> SellerBadgesAsync(Guid sellerId)
    {
        var orders = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND status = 'placed'", new { sellerId });
        var questions = (await SellerQuestionsAsync(sellerId, true, 1)).Waiting;
        var reports = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM product_reports r JOIN products p ON p.id = r.product_id WHERE p.seller_id = @sellerId AND r.status = 'open'", new { sellerId });
        var deals = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM deals WHERE seller_id = @sellerId AND status = 'active'", new { sellerId });
        return (orders, questions, reports, deals);
    }
}
