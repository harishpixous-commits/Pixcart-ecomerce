using System.Text.Json.Nodes;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>Admin review moderation (reference: routers/admin_extras.py moderate_review,
/// services review reports close-out, routers/customer.py refresh_ratings).</summary>
public class ReviewModerationBAL(IAccessBAL access, IMySqlDapperHelper db) : IReviewModerationBAL
{
    /// <summary>Reference: _close_reports — open reports for a review get an outcome and a resolved time.</summary>
    private static async Task CloseReportsAsync(IUnitOfWork uow, Guid reviewId, string outcome) =>
        await uow.ExecuteAsync(
            "UPDATE review_reports SET status = @outcome, resolved_at = UTC_TIMESTAMP(6) WHERE review_id = @reviewId AND status = 'open'",
            new { outcome, reviewId });

    /// <summary>Reference: refresh_ratings — product and seller averages/counts over published reviews.</summary>
    private async Task RefreshRatingsAsync(IUnitOfWork uow, Guid productId)
    {
        var p = await uow.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @productId FOR UPDATE", new { productId })
            ?? throw new NotFoundException("Product");
        var (avg, count) = await uow.QueryFirstOrDefaultAsync<(decimal, long)>(
            "SELECT COALESCE(AVG(rating), 0), COUNT(*) FROM reviews WHERE product_id = @productId AND status = 'published'",
            new { productId });
        await uow.ExecuteAsync("UPDATE products SET rating_avg = @avg, rating_count = @count, updated_at = UTC_TIMESTAMP(6) WHERE id = @productId",
            new { avg = Math.Round(avg, 2), count = (int)count, productId });
        var (savg, scount) = await uow.QueryFirstOrDefaultAsync<(decimal, long)>(
            "SELECT COALESCE(AVG(r.rating), 0), COUNT(*) FROM reviews r JOIN products pr ON pr.id = r.product_id " +
            "WHERE pr.seller_id = @sellerId AND r.status = 'published'", new { p.SellerId });
        await uow.ExecuteAsync("UPDATE sellers SET rating_avg = @savg, rating_count = @scount, updated_at = UTC_TIMESTAMP(6) WHERE id = @sellerId",
            new { savg = Math.Round(savg, 2), scount = (int)scount, p.SellerId });
    }

    /// <summary>publish / hide / publish-media / hide-media / dismiss-reports (reference: moderate_review).</summary>
    public async Task<JsonObject> ModerateAsync(UserModel admin, Guid reviewId, string action)
    {
        await access.RequireAsync(admin, "catalog");
        await using var uow = await db.BeginAsync();
        var r = await uow.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @reviewId FOR UPDATE", new { reviewId })
            ?? throw new NotFoundException("Review");
        if (action == "publish")
        {
            await uow.ExecuteAsync("UPDATE reviews SET status = 'published', updated_at = UTC_TIMESTAMP(6) WHERE id = @reviewId", new { reviewId });
            r.Status = "published";
            if (r.ReportCount > 0)
            {
                await CloseReportsAsync(uow, r.Id, "dismissed");
                await uow.ExecuteAsync("UPDATE reviews SET report_count = 0 WHERE id = @reviewId", new { reviewId });
            }
        }
        else if (action == "hide")
        {
            await uow.ExecuteAsync("UPDATE reviews SET status = 'hidden', updated_at = UTC_TIMESTAMP(6) WHERE id = @reviewId", new { reviewId });
            r.Status = "hidden";
            if (r.ReportCount > 0)
            {
                await CloseReportsAsync(uow, r.Id, "upheld");
                await uow.ExecuteAsync("UPDATE reviews SET report_count = 0 WHERE id = @reviewId", new { reviewId });
            }
        }
        else if (action == "publish-media")
        {
            await uow.ExecuteAsync("UPDATE reviews SET media_status = 'published', updated_at = UTC_TIMESTAMP(6) WHERE id = @reviewId", new { reviewId });
            r.MediaStatus = "published";
        }
        else if (action == "hide-media")
        {
            await uow.ExecuteAsync("UPDATE reviews SET media_status = 'hidden', updated_at = UTC_TIMESTAMP(6) WHERE id = @reviewId", new { reviewId });
            r.MediaStatus = "hidden";
        }
        else
        {
            await CloseReportsAsync(uow, r.Id, "dismissed");
            await uow.ExecuteAsync("UPDATE reviews SET report_count = 0, updated_at = UTC_TIMESTAMP(6) WHERE id = @reviewId", new { reviewId });
        }
        await RefreshRatingsAsync(uow, r.ProductId);
        if (action == "publish") await LoyaltyPoints.AwardReviewAsync(uow, r.Id);
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'review', @eid, '', UTC_TIMESTAMP(6), @id)",
            new { actor = admin.Id, action = $"review.{action}", eid = r.Id.ToString(), id = Guid.NewGuid() });
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true, ["status"] = r.Status, ["media_status"] = r.MediaStatus };
    }
}
