using Dapper;
using DAL.Helpers;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>A question or answer with its author's name (and, for queues, the product and question).</summary>
public sealed class QaRow
{
    public Guid Id { get; set; }
    public Guid? QuestionId { get; set; }
    public Guid? UserId { get; set; }
    public string Role { get; set; } = "customer";
    public string Text { get; set; } = "";
    public string Status { get; set; } = "";
    public int HelpfulCount { get; set; }
    public int AnswerCount { get; set; }
    public int ReportCount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string? AuthorName { get; set; }
    public string ProductTitle { get; set; } = "";
    public string ProductSlug { get; set; } = "";
    public string QuestionText { get; set; } = "";
}

/// <summary>A shopper's back-in-stock alert with its version and product.</summary>
public sealed class StockAlertRow
{
    public Guid UserId { get; set; }
    public Guid VariantId { get; set; }
    public DateTime CreatedAt { get; set; }
    public string Options { get; set; } = "{}";
    public int Stock { get; set; }
    public long PricePaise { get; set; }
    public Guid ProductId { get; set; }
    public string Title { get; set; } = "";
    public string Slug { get; set; } = "";
}

/// <summary>A wishlist entry whose product became cheaper.</summary>
public sealed class PriceDropRow
{
    public Guid UserId { get; set; }
    public Guid ProductId { get; set; }
    public long PriceAtAdd { get; set; }
    public long PriceFrom { get; set; }
    public string Title { get; set; } = "";
    public string Slug { get; set; } = "";
}

/// <summary>Product questions and answers, votes and reports, back-in-stock alerts and wishlist price-drop alerts.</summary>
public class EngagementDAL(IMySqlDapperHelper db)
{
    // ------------------------------------------------------------------------- questions

    private static string QuestionWhere(Guid productId, string q, DynamicParameters p)
    {
        p.Add("productId", productId);
        var where = "q.product_id = @productId AND q.status = 'published'";
        if (q.Length > 0)
        {
            p.Add("like", SqlHelpers.Contains(q));
            where += " AND (q.text LIKE @like OR q.id IN (SELECT a.question_id FROM product_answers a WHERE a.status = 'published' AND a.text LIKE @like))";
        }
        return where;
    }

    public async Task<long> CountQuestionsAsync(Guid productId, string q)
    {
        var p = new DynamicParameters();
        return await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM product_questions q WHERE {QuestionWhere(productId, q, p)}", p);
    }

    /// <summary>Sorts: helpful (most answers first) or recent.</summary>
    public Task<IEnumerable<QaRow>> QuestionsPageAsync(Guid productId, string q, string sort, int take, int skip)
    {
        var p = new DynamicParameters();
        var where = QuestionWhere(productId, q, p);
        var order = sort == "helpful" ? "q.answer_count DESC, q.created_at DESC" : "q.created_at DESC";
        p.Add("take", take);
        p.Add("skip", skip);
        return db.QueryAsync<QaRow>(
            $"SELECT q.id, q.user_id, q.text, q.status, q.answer_count, q.report_count, q.created_at, u.name AS author_name FROM product_questions q " +
            $"LEFT JOIN users u ON u.id = q.user_id WHERE {where} ORDER BY {order}, q.id LIMIT @take OFFSET @skip", p);
    }

    public Task<IEnumerable<QaRow>> PublishedAnswersAsync(IEnumerable<Guid> questionIds) =>
        db.QueryAsync<QaRow>(
            "SELECT a.id, a.question_id, a.user_id, a.`role`, a.text, a.status, a.helpful_count, a.report_count, a.created_at, u.name AS author_name " +
            "FROM product_answers a LEFT JOIN users u ON u.id = a.user_id WHERE a.question_id IN @ids AND a.status = 'published' " +
            "ORDER BY a.`role` = 'seller', a.helpful_count DESC, a.created_at", new { ids = questionIds.ToList() });

    public async Task<HashSet<Guid>> VotedAnswersAsync(Guid userId, IEnumerable<Guid> answerIds) =>
        (await db.QueryAsync<Guid>("SELECT answer_id FROM answer_votes WHERE user_id = @userId AND answer_id IN @ids", new { userId, ids = answerIds.ToList() })).ToHashSet();

    public Task<ProductQuestionModel?> GetQuestionAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductQuestionModel>("SELECT * FROM product_questions WHERE id = @id", new { id });

    public Task<ProductAnswerModel?> GetAnswerAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ProductAnswerModel>("SELECT * FROM product_answers WHERE id = @id", new { id });

    public Task InsertQuestionAsync(ProductQuestionModel q) =>
        db.ExecuteAsync(
            "INSERT INTO product_questions (id, product_id, user_id, text, status, answer_count, report_count, created_at) " +
            "VALUES (@Id, @ProductId, @UserId, @Text, @Status, @AnswerCount, @ReportCount, @CreatedAt)", q);

    public Task InsertAnswerAsync(ProductAnswerModel a) =>
        db.ExecuteAsync(
            "INSERT INTO product_answers (id, question_id, user_id, `role`, text, status, helpful_count, report_count, created_at) " +
            "VALUES (@Id, @QuestionId, @UserId, @Role, @Text, @Status, @HelpfulCount, @ReportCount, @CreatedAt)", a);

    /// <summary>The question's answer_count = its published answers.</summary>
    public Task RefreshAnswerCountAsync(Guid questionId, IUnitOfWork? uow = null)
    {
        const string sql = "UPDATE product_questions SET answer_count = (SELECT COUNT(*) FROM product_answers WHERE question_id = @questionId AND status = 'published') WHERE id = @questionId";
        return uow != null ? uow.ExecuteAsync(sql, new { questionId }) : db.ExecuteAsync(sql, new { questionId });
    }

    /// <summary>A delivered package of this user contains the product.</summary>
    public async Task<bool> IsBuyerAsync(Guid userId, Guid productId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM (SELECT so.id FROM sub_orders so JOIN orders o ON o.id = so.order_id JOIN order_items oi ON oi.sub_order_id = so.id " +
            "WHERE o.user_id = @userId AND oi.product_id = @productId AND so.status = 'delivered' LIMIT 1) x", new { userId, productId }) > 0;

    /// <summary>Adds the vote or takes it back; returns (voted now, helpful count).</summary>
    public async Task<(bool Voted, int HelpfulCount)> ToggleAnswerVoteAsync(Guid answerId, Guid userId)
    {
        await using var uow = await db.BeginAsync();
        var removed = await uow.ExecuteAsync("DELETE FROM answer_votes WHERE answer_id = @answerId AND user_id = @userId", new { answerId, userId });
        var delta = removed > 0 ? -1 : 1;
        if (delta == 1)
            await uow.ExecuteAsync("INSERT INTO answer_votes (answer_id, user_id, created_at) VALUES (@answerId, @userId, @now)",
                new { answerId, userId, now = DateTimeFunctions.UtcNow() });
        await uow.ExecuteAsync("UPDATE product_answers SET helpful_count = GREATEST(helpful_count + @delta, 0) WHERE id = @answerId", new { answerId, delta });
        var count = await uow.ExecuteScalarAsync<int>("SELECT helpful_count FROM product_answers WHERE id = @answerId", new { answerId });
        await uow.CommitAsync();
        return (delta == 1, count);
    }

    /// <summary>
    /// A report on a published question or answer, locked so reports arriving together count one by one. Returns null
    /// when the post is missing or not published; otherwise (already reported by this person, hidden now).
    /// </summary>
    public async Task<(bool Already, bool Hidden)?> ReportPostAsync(bool question, Guid postId, Guid userId, int hideAt)
    {
        var table = question ? "product_questions" : "product_answers";
        await using var uow = await db.BeginAsync();
        var post = await uow.QueryFirstOrDefaultAsync<(string Status, int ReportCount, Guid? QuestionId)>(
            question ? "SELECT status, report_count, NULL FROM product_questions WHERE id = @postId FOR UPDATE"
                     : "SELECT status, report_count, question_id FROM product_answers WHERE id = @postId FOR UPDATE", new { postId });
        if (post.Status != "published") return null;
        var inserted = await uow.ExecuteAsync(
            question ? "INSERT IGNORE INTO question_reports (question_id, user_id, created_at) VALUES (@postId, @userId, @now)"
                     : "INSERT IGNORE INTO answer_reports (answer_id, user_id, created_at) VALUES (@postId, @userId, @now)",
            new { postId, userId, now = DateTimeFunctions.UtcNow() });
        if (inserted == 0)
        {
            await uow.CommitAsync();
            return (true, false);
        }
        var count = post.ReportCount + 1;
        var hidden = hideAt > 0 && count >= hideAt;
        await uow.ExecuteAsync($"UPDATE {table} SET report_count = @count, status = @status WHERE id = @postId",
            new { postId, count, status = hidden ? "pending" : "published" });
        if (hidden && !question && post.QuestionId is { } qid) await RefreshAnswerCountAsync(qid, uow);
        await uow.CommitAsync();
        return (false, hidden);
    }

    // ------------------------------------------------------------------------- seller and staff

    private const string SellerAnswered = "q.id IN (SELECT a.question_id FROM product_answers a WHERE a.`role` = 'seller')";

    public async Task<long> SellerQuestionCountAsync(Guid sellerId, bool unanswered) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM product_questions q JOIN products p ON p.id = q.product_id WHERE p.seller_id = @sellerId AND q.status = 'published'" +
            (unanswered ? $" AND NOT {SellerAnswered}" : ""), new { sellerId });

    public Task<IEnumerable<QaRow>> SellerQuestionsAsync(Guid sellerId, bool unanswered, int take, int skip) =>
        db.QueryAsync<QaRow>(
            "SELECT q.id, q.text, q.status, q.created_at, p.title AS product_title, p.slug AS product_slug FROM product_questions q " +
            "JOIN products p ON p.id = q.product_id WHERE p.seller_id = @sellerId AND q.status = 'published'" +
            (unanswered ? $" AND NOT {SellerAnswered}" : "") + " ORDER BY q.created_at DESC LIMIT @take OFFSET @skip",
            new { sellerId, take, skip });

    public Task<IEnumerable<ProductAnswerModel>> VisibleAnswersAsync(IEnumerable<Guid> questionIds) =>
        db.QueryAsync<ProductAnswerModel>("SELECT * FROM product_answers WHERE question_id IN @ids AND status <> 'hidden' ORDER BY created_at",
            new { ids = questionIds.ToList() });

    /// <summary>(orders to confirm, open product reports, running deals) for the seller hub menu.</summary>
    public async Task<(long Orders, long Reports, long Deals)> SellerBadgeCountsAsync(Guid sellerId)
    {
        var orders = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM sub_orders WHERE seller_id = @sellerId AND status = 'placed'", new { sellerId });
        var reports = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM product_reports r JOIN products p ON p.id = r.product_id WHERE p.seller_id = @sellerId AND r.status = 'open'", new { sellerId });
        var deals = await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM deals WHERE seller_id = @sellerId AND status = 'active'", new { sellerId });
        return (orders, reports, deals);
    }

    public Task<IEnumerable<QaRow>> AdminQuestionsAsync(string status, string q) =>
        db.QueryAsync<QaRow>(
            "SELECT q.id, q.text, q.status, q.report_count, q.created_at, u.name AS author_name, p.title AS product_title, p.slug AS product_slug " +
            "FROM product_questions q JOIN products p ON p.id = q.product_id LEFT JOIN users u ON u.id = q.user_id WHERE q.status = @status" +
            (q.Length > 0 ? " AND (q.text LIKE @like OR p.title LIKE @like)" : "") + " LIMIT 200",
            new { status, like = SqlHelpers.Contains(q) });

    public Task<IEnumerable<QaRow>> AdminAnswersAsync(string status, string q) =>
        db.QueryAsync<QaRow>(
            "SELECT a.id, a.question_id, a.`role`, a.text, a.status, a.report_count, a.created_at, u.name AS author_name, q.text AS question_text, " +
            "p.title AS product_title, p.slug AS product_slug FROM product_answers a JOIN product_questions q ON q.id = a.question_id " +
            "JOIN products p ON p.id = q.product_id LEFT JOIN users u ON u.id = a.user_id WHERE a.status = @status" +
            (q.Length > 0 ? " AND (a.text LIKE @like OR p.title LIKE @like)" : "") + " LIMIT 200",
            new { status, like = SqlHelpers.Contains(q) });

    public async Task<long> CountPostsAsync(string status) =>
        await db.ExecuteScalarAsync<long>("SELECT (SELECT COUNT(*) FROM product_questions WHERE status = @status) + (SELECT COUNT(*) FROM product_answers WHERE status = @status)",
            new { status });

    /// <summary>Staff publish or hide a post; its report count starts again from 0.</summary>
    public Task SetPostStatusAsync(bool question, Guid id, string status) =>
        db.ExecuteAsync($"UPDATE {(question ? "product_questions" : "product_answers")} SET status = @status, report_count = 0 WHERE id = @id", new { id, status });

    // ------------------------------------------------------------------------- alerts

    public Task<StockAlertModel?> GetStockAlertAsync(Guid userId, Guid variantId) =>
        db.QueryFirstOrDefaultAsync<StockAlertModel>("SELECT * FROM stock_alerts WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    public async Task<long> ActiveStockAlertCountAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM stock_alerts WHERE user_id = @userId AND active = 1", new { userId });

    public Task InsertStockAlertAsync(Guid userId, Guid variantId) =>
        db.ExecuteAsync("INSERT INTO stock_alerts (user_id, variant_id, created_at, notified_at, active) VALUES (@userId, @variantId, @now, NULL, 1)",
            new { userId, variantId, now = DateTimeFunctions.UtcNow() });

    public Task ReactivateStockAlertAsync(Guid userId, Guid variantId) =>
        db.ExecuteAsync("UPDATE stock_alerts SET active = 1, notified_at = NULL WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    public Task DeleteStockAlertAsync(Guid userId, Guid variantId) =>
        db.ExecuteAsync("DELETE FROM stock_alerts WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId });

    public Task<IEnumerable<StockAlertRow>> MyStockAlertsAsync(Guid userId, Guid? variantId) =>
        db.QueryAsync<StockAlertRow>(
            "SELECT sa.user_id, sa.variant_id, sa.created_at, v.options, v.stock, v.price_paise, p.id AS product_id, p.title, p.slug FROM stock_alerts sa " +
            "JOIN variants v ON v.id = sa.variant_id JOIN products p ON p.id = v.product_id WHERE sa.user_id = @userId AND sa.active = 1" +
            (variantId != null ? " AND sa.variant_id = @variantId" : "") + " ORDER BY sa.created_at DESC", new { userId, variantId });

    /// <summary>Alerts whose version is back in stock (public products), not yet sent, at most 500.</summary>
    public Task<IEnumerable<StockAlertRow>> DueStockAlertsAsync() =>
        db.QueryAsync<StockAlertRow>(
            "SELECT sa.user_id, sa.variant_id, sa.created_at, v.options, v.stock, v.price_paise, p.id AS product_id, p.title, p.slug FROM stock_alerts sa " +
            "JOIN variants v ON v.id = sa.variant_id JOIN products p ON p.id = v.product_id " +
            $"WHERE sa.active = 1 AND sa.notified_at IS NULL AND v.stock > 0 AND v.is_active = 1 AND {CatalogDAL.PublicFilter} LIMIT 500");

    public Task MarkStockAlertSentAsync(Guid userId, Guid variantId, DateTime now) =>
        db.ExecuteAsync("UPDATE stock_alerts SET notified_at = @now, active = 0 WHERE user_id = @userId AND variant_id = @variantId", new { userId, variantId, now });

    /// <summary>Wishlist entries at least <paramref name="pct"/>% cheaper than when saved and cheaper than the last alert, at most 500.</summary>
    public Task<IEnumerable<PriceDropRow>> DuePriceDropsAsync(int pct) =>
        db.QueryAsync<PriceDropRow>(
            "SELECT w.user_id, w.product_id, w.price_at_add, p.price_from, p.title, p.slug FROM wishlist_items w JOIN products p ON p.id = w.product_id " +
            $"WHERE w.price_at_add IS NOT NULL AND p.in_stock = 1 AND {CatalogDAL.PublicFilter} AND p.price_from * 100 <= w.price_at_add * (100 - @pct) " +
            "AND (w.alerted_price IS NULL OR p.price_from < w.alerted_price) LIMIT 500", new { pct });

    public Task MarkPriceAlertedAsync(Guid userId, Guid productId, long price) =>
        db.ExecuteAsync("UPDATE wishlist_items SET alerted_price = @price WHERE user_id = @userId AND product_id = @productId", new { userId, productId, price });

    /// <summary>Remembers the price when a product is saved to the wishlist (once).</summary>
    public Task RememberWishlistPriceAsync(Guid userId, Guid productId) =>
        db.ExecuteAsync(
            "UPDATE wishlist_items w JOIN products p ON p.id = w.product_id SET w.price_at_add = p.price_from " +
            "WHERE w.user_id = @userId AND w.product_id = @productId AND w.price_at_add IS NULL", new { userId, productId });
}
