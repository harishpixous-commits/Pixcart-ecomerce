using Dapper;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>Which published reviews of a product a list shows.</summary>
public sealed class ReviewFilter
{
    public int? Star { get; set; }
    public bool Media { get; set; }
    public bool Verified { get; set; }
    /// <summary>A MySQL (ICU) regular expression the title and text must match, ignoring case.</summary>
    public string? TopicPattern { get; set; }
}

/// <summary>A review with its author's name.</summary>
public sealed class ReviewWithName : ReviewModel
{
    public string? AuthorName { get; set; }
}

/// <summary>Reviews, helpful votes, review reports, product reports and the rating aggregates of products and sellers.</summary>
public class ReviewDAL(IMySqlDapperHelper db)
{
    private const string WithMedia = "JSON_LENGTH(r.media) > 0";

    private static string Where(Guid productId, ReviewFilter f, DynamicParameters p)
    {
        var conds = new List<string> { "r.product_id = @productId", "r.status = 'published'" };
        p.Add("productId", productId);
        if (f.Star != null) { conds.Add("r.rating = @star"); p.Add("star", f.Star); }
        if (f.Media) conds.Add($"{WithMedia} AND r.media_status = 'published'");
        if (f.Verified) conds.Add("r.verified = 1");
        if (f.TopicPattern != null) { conds.Add("REGEXP_LIKE(CONCAT(r.title, ' ', r.body), @topic, 'i')"); p.Add("topic", f.TopicPattern); }
        return string.Join(" AND ", conds);
    }

    /// <summary>Sorts: recent, helpful, high, low (then newest).</summary>
    public Task<IEnumerable<ReviewWithName>> PageAsync(Guid productId, ReviewFilter f, string sort, int take, int skip)
    {
        var p = new DynamicParameters();
        var where = Where(productId, f, p);
        var order = sort switch
        {
            "helpful" => "r.helpful_count DESC",
            "high" => "r.rating DESC",
            "low" => "r.rating ASC",
            _ => "r.created_at DESC",
        };
        p.Add("take", take);
        p.Add("skip", skip);
        return db.QueryAsync<ReviewWithName>(
            $"SELECT r.*, u.name AS author_name FROM reviews r JOIN users u ON u.id = r.user_id WHERE {where} " +
            $"ORDER BY {order}, r.created_at DESC, r.id LIMIT @take OFFSET @skip", p);
    }

    public async Task<long> CountAsync(Guid productId, ReviewFilter f)
    {
        var p = new DynamicParameters();
        var where = Where(productId, f, p);
        return await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) FROM reviews r WHERE {where}", p);
    }

    public async Task<Dictionary<int, long>> DistributionAsync(Guid productId) =>
        (await db.QueryAsync<(int, long)>("SELECT rating, COUNT(*) FROM reviews WHERE product_id = @productId AND status = 'published' GROUP BY rating",
            new { productId })).ToDictionary(r => r.Item1, r => r.Item2);

    public Task<ReviewModel?> GetAsync(Guid id) => db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @id", new { id });

    public Task<ReviewModel?> MineAsync(Guid productId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE product_id = @productId AND user_id = @userId", new { productId, userId });

    public Task InsertAsync(ReviewModel r) =>
        db.ExecuteAsync(
            "INSERT INTO reviews (id, product_id, user_id, sub_order_id, verified, rating, title, body, status, media, media_status, seller_reply, " +
            "helpful_count, report_count, created_at, updated_at) VALUES (@Id, @ProductId, @UserId, @SubOrderId, @Verified, @Rating, @Title, @Body, " +
            "@Status, CAST(@Media AS JSON), @MediaStatus, @SellerReply, @HelpfulCount, @ReportCount, @CreatedAt, @UpdatedAt)", r);

    public Task UpdateAsync(ReviewModel r) =>
        db.ExecuteAsync(
            "UPDATE reviews SET sub_order_id = @SubOrderId, verified = @Verified, rating = @Rating, title = @Title, body = @Body, status = @Status, " +
            "media = CAST(@Media AS JSON), media_status = @MediaStatus, report_count = @ReportCount, updated_at = @UpdatedAt WHERE id = @Id", r);

    public Task DeleteAsync(Guid id) => db.ExecuteAsync("DELETE FROM reviews WHERE id = @id", new { id });

    /// <summary>The user's delivered package containing the product (a verified purchase), or null.</summary>
    public Task<Guid?> DeliveredSubOrderAsync(Guid userId, Guid productId) =>
        db.QueryFirstOrDefaultAsync<Guid?>(
            "SELECT so.id FROM sub_orders so JOIN orders o ON o.id = so.order_id JOIN order_items oi ON oi.sub_order_id = so.id " +
            "WHERE o.user_id = @userId AND oi.product_id = @productId AND so.status = 'delivered' LIMIT 1", new { userId, productId });

    // ------------------------------------------------------------------------- votes and reports

    public async Task<HashSet<Guid>> VotedAsync(Guid userId, IEnumerable<Guid> reviewIds) =>
        (await db.QueryAsync<Guid>("SELECT review_id FROM review_votes WHERE user_id = @userId AND review_id IN @ids", new { userId, ids = reviewIds.ToList() })).ToHashSet();

    public async Task<HashSet<Guid>> ReportedAsync(Guid userId, IEnumerable<Guid> reviewIds) =>
        (await db.QueryAsync<Guid>("SELECT review_id FROM review_reports WHERE user_id = @userId AND review_id IN @ids", new { userId, ids = reviewIds.ToList() })).ToHashSet();

    /// <summary>Adds the vote or takes it back; returns (voted now, helpful count).</summary>
    public async Task<(bool Voted, int HelpfulCount)> ToggleVoteAsync(Guid reviewId, Guid userId)
    {
        await using var uow = await db.BeginAsync();
        var removed = await uow.ExecuteAsync("DELETE FROM review_votes WHERE review_id = @reviewId AND user_id = @userId", new { reviewId, userId });
        var delta = removed > 0 ? -1 : 1;
        if (delta == 1)
            await uow.ExecuteAsync("INSERT INTO review_votes (review_id, user_id, created_at) VALUES (@reviewId, @userId, @now)",
                new { reviewId, userId, now = DateTimeFunctions.UtcNow() });
        await uow.ExecuteAsync("UPDATE reviews SET helpful_count = GREATEST(helpful_count + @delta, 0) WHERE id = @reviewId", new { reviewId, delta });
        var count = await uow.ExecuteScalarAsync<int>("SELECT helpful_count FROM reviews WHERE id = @reviewId", new { reviewId });
        await uow.CommitAsync();
        return (delta == 1, count);
    }

    /// <summary>
    /// Records a person's report once (locked, so reports arriving together count one by one); returns the review's
    /// report count afterwards, or null when this person had already reported it. Hides the review (pending) when the
    /// count reaches <paramref name="hideAt"/> (0 = never) and it was published; <c>Hidden</c> says whether that happened.
    /// </summary>
    public async Task<(bool Already, bool Hidden)> FileReportAsync(Guid reviewId, Guid userId, string reason, string note, int hideAt)
    {
        await using var uow = await db.BeginAsync();
        var r = await uow.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @reviewId FOR UPDATE", new { reviewId });
        if (r == null) return (true, false);
        var exists = await uow.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM review_reports WHERE review_id = @reviewId AND user_id = @userId", new { reviewId, userId });
        if (exists > 0) return (true, false);
        await uow.ExecuteAsync(
            "INSERT INTO review_reports (id, review_id, user_id, reason, note, status, created_at) VALUES (@id, @reviewId, @userId, @reason, @note, 'open', @now)",
            new { id = Guid.NewGuid(), reviewId, userId, reason, note, now = DateTimeFunctions.UtcNow() });
        var count = r.ReportCount + 1;
        var hidden = hideAt > 0 && count >= hideAt && r.Status == "published";
        await uow.ExecuteAsync("UPDATE reviews SET report_count = @count, status = @status WHERE id = @reviewId",
            new { reviewId, count, status = hidden ? "pending" : r.Status });
        await uow.CommitAsync();
        return (false, hidden);
    }

    // ------------------------------------------------------------------------- aggregates

    /// <summary>Recomputes the product's and its seller's average rating and count from published reviews.</summary>
    public async Task RefreshRatingsAsync(Guid productId)
    {
        var sellerId = await db.QueryFirstOrDefaultAsync<Guid?>("SELECT seller_id FROM products WHERE id = @productId", new { productId });
        if (sellerId == null) return;
        await db.ExecuteAsync(
            "UPDATE products p, (SELECT COALESCE(ROUND(AVG(rating), 2), 0) AS a, COUNT(*) AS n FROM reviews WHERE product_id = @productId AND status = 'published') x " +
            "SET p.rating_avg = x.a, p.rating_count = x.n WHERE p.id = @productId", new { productId });
        await db.ExecuteAsync(
            "UPDATE sellers s, (SELECT COALESCE(ROUND(AVG(r.rating), 2), 0) AS a, COUNT(*) AS n FROM reviews r JOIN products p ON p.id = r.product_id " +
            "WHERE p.seller_id = @sellerId AND r.status = 'published') x SET s.rating_avg = x.a, s.rating_count = x.n WHERE s.id = @sellerId", new { sellerId });
    }

    // ------------------------------------------------------------------------- customer photos and topics

    /// <summary>Published reviews with published photos or videos, newest first (at most 200), and the number of media items.</summary>
    public async Task<(List<ReviewWithName> Rows, long Total)> WithMediaAsync(Guid productId)
    {
        const string where = "r.product_id = @productId AND r.status = 'published' AND r.media_status = 'published' AND " + WithMedia;
        var total = await db.ExecuteScalarAsync<decimal?>($"SELECT COALESCE(SUM(JSON_LENGTH(r.media)), 0) FROM reviews r WHERE {where}", new { productId }) ?? 0;
        var rows = await db.QueryAsync<ReviewWithName>(
            $"SELECT r.*, u.name AS author_name FROM reviews r JOIN users u ON u.id = r.user_id WHERE {where} ORDER BY r.created_at DESC, r.id LIMIT 200",
            new { productId });
        return (rows.ToList(), (long)total);
    }

    public async Task<long> WithMediaCountAsync(Guid productId) =>
        await db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM reviews r WHERE r.product_id = @productId AND r.status = 'published' AND r.media_status = 'published' AND {WithMedia}",
            new { productId });

    /// <summary>(rating, "title body") of the latest 2000 published reviews of a product or of a seller's products.</summary>
    public async Task<List<(int Rating, string Text)>> TextsAsync(Guid? productId, Guid? sellerId)
    {
        var sql = "SELECT r.rating, CONCAT(r.title, ' ', r.body) FROM reviews r " + (sellerId != null ? "JOIN products p ON p.id = r.product_id " : "") +
                  "WHERE r.status = 'published'" + (productId != null ? " AND r.product_id = @productId" : "") + (sellerId != null ? " AND p.seller_id = @sellerId" : "") +
                  " ORDER BY r.created_at DESC LIMIT 2000";
        return (await db.QueryAsync<(int, string)>(sql, new { productId, sellerId })).ToList();
    }

    // ------------------------------------------------------------------------- product reports

    public Task<ProductReportModel?> OpenProductReportAsync(Guid productId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<ProductReportModel>(
            "SELECT * FROM product_reports WHERE product_id = @productId AND user_id = @userId AND status = 'open' LIMIT 1", new { productId, userId });

    public Task InsertProductReportAsync(ProductReportModel r) =>
        db.ExecuteAsync(
            "INSERT INTO product_reports (id, product_id, seller_id, user_id, reason, note, url, status, admin_note, seller_note, created_at, updated_at) " +
            "VALUES (@Id, @ProductId, @SellerId, @UserId, @Reason, @Note, @Url, @Status, @AdminNote, @SellerNote, @CreatedAt, @UpdatedAt)", r);

    public Task UpdateProductReportAsync(ProductReportModel r) =>
        db.ExecuteAsync("UPDATE product_reports SET reason = @Reason, note = @Note, url = @Url, updated_at = @UpdatedAt WHERE id = @Id", r);
}
