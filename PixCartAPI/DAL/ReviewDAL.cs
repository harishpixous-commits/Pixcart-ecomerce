using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Customer-side review reads and writes (reference: routers/customer.py, services/product_page.py).</summary>
public class ReviewDAL(IMySqlDapperHelper db)
{
    public Task<ProductModel?> ProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE slug = @slug", new { slug });

    /// <summary>A product customers may see and buy (reference: public_product_filter).</summary>
    public Task<ProductModel?> PublicProductBySlugAsync(string slug) =>
        db.QueryFirstOrDefaultAsync<ProductModel>(
            "SELECT * FROM products WHERE slug = @slug AND status = 'approved' AND price_from > 0 " +
            "AND seller_id IN (SELECT id FROM sellers WHERE status = 'approved' AND holiday_mode = 0)", new { slug });

    public Task<SellerModel?> GetSellerAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @id", new { id });

    public Task<ReviewModel?> GetAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @id", new { id });

    public Task<ReviewModel?> GetMineAsync(Guid productId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<ReviewModel>(
            "SELECT * FROM reviews WHERE product_id = @productId AND user_id = @userId", new { productId, userId });

    /// <summary>One delivered package containing the product, if any (reference: _delivered_sub).</summary>
    public Task<SubOrderModel?> DeliveredSubAsync(Guid userId, Guid productId) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>(
            "SELECT s.* FROM sub_orders s JOIN orders o ON o.id = s.order_id JOIN order_items i ON i.sub_order_id = s.id " +
            "WHERE o.user_id = @userId AND i.product_id = @productId AND s.status = 'delivered' LIMIT 1", new { userId, productId });

    /// <summary>A review row joined to its author's name.</summary>
    public class ReviewRow : ReviewModel
    {
        public string? Name { get; set; }
    }

    /// <summary>Published reviews with author names, filtered and ordered for the listing (reference: product_reviews).</summary>
    public async Task<IEnumerable<(ReviewModel Review, string? Author)>> ListAsync(
        Guid productId, int? star, bool mediaOnly, bool verifiedOnly, string? topicPattern, string sort, int offset, int size)
    {
        var where = Where(productId, star, mediaOnly, verifiedOnly, topicPattern, out var p);
        var rows = await db.QueryAsync<ReviewRow>(
            $"SELECT r.*, u.name FROM reviews r JOIN users u ON u.id = r.user_id WHERE {where} " +
            $"ORDER BY {Order(sort)}, r.created_at, r.id LIMIT {size} OFFSET {offset}", p);
        return rows.Select(r => ((ReviewModel)r, r.Name));
    }

    public async Task<long> CountAsync(Guid productId, int? star, bool mediaOnly, bool verifiedOnly, string? topicPattern) =>
        await db.ExecuteScalarAsync<long>(
            $"SELECT COUNT(*) FROM reviews WHERE {Where(productId, star, mediaOnly, verifiedOnly, topicPattern, out var p)}", p);

    /// <summary>Star histogram over published reviews (reference: dist).</summary>
    public async Task<Dictionary<int, long>> DistributionAsync(Guid productId)
    {
        var rows = await db.QueryAsync<(int Rating, long N)>(
            "SELECT rating, COUNT(*) FROM reviews WHERE product_id = @productId AND status = 'published' GROUP BY rating", new { productId });
        return rows.ToDictionary(x => x.Rating, x => x.N);
    }

    public async Task<long> WithMediaCountAsync(Guid productId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM reviews WHERE product_id = @productId AND status = 'published' AND media_status = 'published' AND JSON_LENGTH(media) > 0",
            new { productId });

    public async Task<long> VerifiedCountAsync(Guid productId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM reviews WHERE product_id = @productId AND status = 'published' AND verified = 1", new { productId });

    /// <summary>The votes and reports this user filed on the given reviews.</summary>
    public async Task<(HashSet<Guid> Voted, HashSet<Guid> Reported)> MarksAsync(Guid userId, IReadOnlyList<Guid> reviewIds)
    {
        if (reviewIds.Count == 0) return ([], []);
        var voted = await db.QueryAsync<Guid>(
            "SELECT CAST(review_id AS CHAR) FROM review_votes WHERE user_id = @userId AND review_id IN @reviewIds", new { userId, reviewIds });
        var reported = await db.QueryAsync<Guid>(
            "SELECT CAST(review_id AS CHAR) FROM review_reports WHERE user_id = @userId AND review_id IN @reviewIds", new { userId, reviewIds });
        return (voted.ToHashSet(), reported.ToHashSet());
    }

    /// <summary>Photos and videos from published reviews, newest first (reference: customer_media). Rows capped at 200 like the reference.</summary>
    public async Task<(List<(ReviewModel Review, string? Author)> Rows, long Total)> CustomerMediaAsync(Guid productId)
    {
        const string where = "product_id = @productId AND status = 'published' AND media_status = 'published' AND JSON_LENGTH(media) > 0";
        var total = await db.ExecuteScalarAsync<long>(
            $"SELECT COALESCE(SUM(JSON_LENGTH(media)), 0) FROM reviews WHERE {where}", new { productId });
        var rows = await db.QueryAsync<ReviewRow>(
            "SELECT r.*, u.name FROM reviews r JOIN users u ON u.id = r.user_id " +
            "WHERE r.product_id = @productId AND r.status = 'published' AND r.media_status = 'published' AND JSON_LENGTH(r.media) > 0 " +
            "ORDER BY r.created_at DESC, r.id LIMIT 200", new { productId });
        return (rows.Select(r => ((ReviewModel)r, r.Name)).ToList(), total);
    }

    /// <summary>(rating, text) pairs for topic stats, newest first, capped at 2000 (reference: review_topics).</summary>
    public Task<IEnumerable<(int Rating, string Title, string Body)>> TopicTextsAsync(Guid productId) =>
        db.QueryAsync<(int, string, string)>(
            "SELECT rating, title, body FROM reviews WHERE product_id = @productId AND status = 'published' ORDER BY created_at DESC LIMIT 2000",
            new { productId });

    public Task<ReviewVoteModel?> GetVoteAsync(Guid reviewId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<ReviewVoteModel>(
            "SELECT * FROM review_votes WHERE review_id = @reviewId AND user_id = @userId", new { reviewId, userId });

    public Task<ReviewReportModel?> GetReportAsync(Guid reviewId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<ReviewReportModel>(
            "SELECT * FROM review_reports WHERE review_id = @reviewId AND user_id = @userId", new { reviewId, userId });

    public Task<ProductReportModel?> GetOpenProductReportAsync(Guid productId, Guid userId) =>
        db.QueryFirstOrDefaultAsync<ProductReportModel>(
            "SELECT * FROM product_reports WHERE product_id = @productId AND user_id = @userId AND status = 'open'", new { productId, userId });

    private static string Where(Guid productId, int? star, bool mediaOnly, bool verifiedOnly, string? topicPattern, out object p)
    {
        var where = "product_id = @productId AND status = 'published'";
        if (star is not null) where += " AND rating = @star";
        if (mediaOnly) where += " AND JSON_LENGTH(media) > 0 AND media_status = 'published'";
        if (verifiedOnly) where += " AND verified = 1";
        if (topicPattern is not null) where += " AND CONCAT(title, ' ', body) REGEXP @topicPattern";
        p = new { productId, star, topicPattern };
        return where;
    }

    private static string Order(string sort) => sort switch
    {
        "helpful" => "r.helpful_count DESC",
        "high" => "r.rating DESC",
        "low" => "r.rating",
        _ => "r.created_at DESC",
    };
}
