using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Customer reviews (reference: routers/customer.py review routes, services/product_page.py customer_media and
/// review_topics, services/review_settings.py). Reading is public; writing, voting and reporting need a signed-in
/// customer and follow the Admin → Reviews → Settings configuration.
/// </summary>
public partial class CustomerReviewsBAL(
    ReviewDAL reviews,
    IPlatformSettingsBAL platform,
    IReviewSettingsBAL reviewSettings,
    IRateLimitBAL rateLimit,
    IImageUpload images,
    AppSettings appSettings,
    IMySqlDapperHelper db) : ICustomerReviewsBAL
{
    [GeneratedRegex(@"(https?://|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d))", RegexOptions.IgnoreCase)]
    private static partial Regex Contact();

    [GeneratedRegex(@"[^\w' \-]")]
    private static partial Regex NonTopicWord();

    // ------------------------------------------------------------------ reads

    public async Task<JsonObject> ListAsync(UserModel? user, string slug, string sort, int page, int? star, bool media, bool verified, string topic)
    {
        var p = await ProductBySlugAsync(slug);
        var cfg = await platform.GetAsync();
        var rcfg = await reviewSettings.GetAsync();
        var showMedia = rcfg.Bool("media_public") || user is not null;

        var topicPattern = TopicPattern(rcfg, topic);
        var size = cfg.Int("reviews_page_size");
        var rows = (await reviews.ListAsync(p.Id, star, media, verified, topicPattern, sort, (page - 1) * size, size)).ToList();
        var total = await reviews.CountAsync(p.Id, star, media, verified, topicPattern);
        var dist = await reviews.DistributionAsync(p.Id);
        var withMedia = await reviews.WithMediaCountAsync(p.Id);
        var verifiedCount = await reviews.VerifiedCountAsync(p.Id);

        var (whyNot, _) = await ReviewGateAsync(p, user, cfg, rcfg);
        JsonNode? mine = null;
        var voted = new HashSet<Guid>();
        var reported = new HashSet<Guid>();
        if (user is not null)
        {
            var mineRow = await reviews.GetMineAsync(p.Id, user.Id);
            if (mineRow is not null)
            {
                mine = new JsonObject
                {
                    ["rating"] = mineRow.Rating, ["title"] = mineRow.Title, ["body"] = mineRow.Body,
                    ["media"] = JsonHelper.Node(mineRow.Media), ["status"] = mineRow.Status, ["media_status"] = mineRow.MediaStatus,
                };
                if (whyNot == "not_purchased") whyNot = null; // an existing review can always be edited or deleted
            }
            (voted, reported) = await reviews.MarksAsync(user.Id, rows.Select(x => x.Review.Id).ToList());
        }

        JsonArray gallery = [];
        long mediaTotal = 0;
        if (showMedia)
        {
            (gallery, mediaTotal) = await CustomerMediaInnerAsync(p.Id, Math.Max(12, cfg.Int("customer_photos_shown")), 0);
        }

        var distribution = new JsonObject();
        for (var k = 5; k >= 1; k--)
        {
            distribution[k.ToString()] = dist.GetValueOrDefault(k);
        }
        var items = new JsonArray();
        foreach (var (r, name) in rows)
        {
            items.Add(ReviewOut(r, name, showMedia, voted, reported, user?.Id));
        }
        return new JsonObject
        {
            ["rating_avg"] = (double)p.RatingAvg,
            ["rating_count"] = p.RatingCount,
            ["distribution"] = distribution,
            ["summary"] = p.ReviewSummary,
            ["topics"] = rcfg.Bool("topics_enabled") ? await ReviewTopicsAsync(rcfg, p.Id) : new JsonArray(),
            ["with_media_count"] = withMedia,
            ["verified_count"] = verifiedCount,
            ["media"] = gallery,
            ["media_total"] = mediaTotal,
            ["media_hidden"] = !showMedia && withMedia > 0,
            ["can_review"] = whyNot is null,
            ["cannot_review_reason"] = whyNot,
            ["mine"] = mine,
            ["settings"] = reviewSettings.Public(rcfg),
            ["items"] = items,
            ["total"] = total,
            ["page"] = page,
            ["has_more"] = (long)page * size < total,
        };
    }

    /// <summary>All customer photos and videos for the full-screen viewer, 30 at a time.</summary>
    public async Task<JsonObject> CustomerMediaAsync(UserModel? user, string slug, int page)
    {
        var p = await ProductBySlugAsync(slug);
        var rcfg = await reviewSettings.GetAsync();
        if (!(rcfg.Bool("media_public") || user is not null))
        {
            return new JsonObject { ["items"] = new JsonArray(), ["total"] = 0, ["page"] = page, ["has_more"] = false, ["sign_in_to_see"] = true };
        }
        var (items, total) = await CustomerMediaInnerAsync(p.Id, 30, (page - 1) * 30);
        return new JsonObject { ["items"] = items, ["total"] = total, ["page"] = page, ["has_more"] = (long)page * 30 < total };
    }

    // ------------------------------------------------------------------ write / delete

    public async Task<JsonObject> WriteAsync(UserModel user, string slug, int rating, string title, string body, JsonArray media)
    {
        var cfg = await platform.GetAsync();
        var rcfg = await reviewSettings.GetAsync();
        var p = await ProductBySlugAsync(slug);
        var existing = await reviews.GetMineAsync(p.Id, user.Id);
        var (whyNot, sub) = await ReviewGateAsync(p, user, cfg, rcfg);
        if (whyNot == "off") throw new AppException("Reviews are turned off", "reviews_off");
        if (whyNot == "own_product") throw new AppException("Sellers cannot review their own products", "own_product");
        if (whyNot == "not_purchased" && existing is null)
        {
            throw new AppException("You can review a product after it has been delivered to you", "not_purchased");
        }
        title = title.Trim();
        var text = body.Trim();
        if (rcfg.Int("min_body_chars") > 0 && text.Length < rcfg.Int("min_body_chars"))
        {
            throw new AppException($"Write at least {rcfg.Int("min_body_chars")} characters about the product", "review_too_short");
        }
        var photos = media.Count(m => m?["kind"]?.GetValue<string>() == "image");
        var videos = media.Count(m => m?["kind"]?.GetValue<string>() == "video");
        if (photos > 0 && !(rcfg.Bool("photos") && rcfg.Int("max_photos") > 0))
        {
            throw new AppException("Photos in reviews are switched off", "photos_off");
        }
        if (photos > rcfg.Int("max_photos")) throw new AppException($"Add at most {rcfg.Int("max_photos")} photos", "too_many_photos");
        if (videos > 0 && !rcfg.Bool("videos")) throw new AppException("Videos in reviews are switched off", "videos_off");
        if (videos > 1) throw new AppException("Add at most one video", "too_many_videos");
        var mediaJson = media.ToJsonString();

        await using var uow = await db.BeginAsync();
        var r = existing ?? new ReviewModel { Id = Guid.NewGuid(), ProductId = p.Id, UserId = user.Id };
        var mediaChanged = existing is not null ? existing.Media != mediaJson : media.Count > 0;
        if (sub is not null || existing is null)
        {
            r.SubOrderId = sub?.Id;
            r.Verified = sub is not null;
        }
        r.Rating = rating;
        r.Title = title;
        r.Body = text;
        r.Media = mediaJson;
        // Links, emails and phone numbers are not allowed in reviews: such reviews wait for a person to check.
        var flagged = Contact().IsMatch($"{title} {text}");
        r.Status = cfg.Bool("reviews_need_approval") || flagged ? "pending" : "published";
        if (media.Count == 0) r.MediaStatus = "published";
        else if (mediaChanged) r.MediaStatus = rcfg.Bool("media_need_approval") ? "pending" : "published";
        if (existing is null)
        {
            await uow.ExecuteAsync(
                "INSERT INTO reviews (id, product_id, user_id, sub_order_id, verified, rating, title, body, status, media, media_status, " +
                "seller_reply, helpful_count, report_count, created_at, updated_at) VALUES (@Id, @ProductId, @UserId, @SubOrderId, @Verified, " +
                "@Rating, @Title, @Body, @Status, CAST(@Media AS JSON), @MediaStatus, '', 0, 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))", r);
        }
        else
        {
            await uow.ExecuteAsync(
                "UPDATE reviews SET sub_order_id = @SubOrderId, verified = @Verified, rating = @Rating, title = @Title, body = @Body, " +
                "status = @Status, media = CAST(@Media AS JSON), media_status = @MediaStatus, updated_at = UTC_TIMESTAMP(6) WHERE id = @Id", r);
        }
        await RefreshRatingsAsync(uow, p.Id);
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true, ["status"] = r.Status, ["media_status"] = r.MediaStatus, ["held_for_check"] = flagged };
    }

    public async Task<JsonObject> DeleteAsync(UserModel user, string slug)
    {
        var p = await ProductBySlugAsync(slug);
        await using var uow = await db.BeginAsync();
        var r = await reviews.GetMineAsync(p.Id, user.Id) ?? throw new NotFoundException("Review");
        await uow.ExecuteAsync("DELETE FROM reviews WHERE id = @id", new { id = r.Id });
        await RefreshRatingsAsync(uow, p.Id);
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>A photo or video for a review (the review itself is saved with PUT .../reviews).</summary>
    public async Task<JsonObject> UploadMediaAsync(UserModel user, byte[] data)
    {
        var cfg = await platform.GetAsync();
        var rcfg = await reviewSettings.GetAsync();
        if (!cfg.Bool("feature_reviews")) throw new AppException("Reviews are turned off", "reviews_off");
        await rateLimit.RateLimitAsync($"review-media:{user.Id}", 40, 3600);
        var videoLimit = (long)rcfg.Int("max_video_mb") * 1024 * 1024;
        var isVideo = true;
        try
        {
            ImageUpload.SniffVideo(data);
        }
        catch (AppException)
        {
            isVideo = false;
        }
        string url;
        if (isVideo)
        {
            if (!rcfg.Bool("videos")) throw new AppException("Videos in reviews are switched off", "videos_off");
            url = await images.SaveVideoAsync(data, videoLimit, "review-videos");
        }
        else
        {
            if (!(rcfg.Bool("photos") && rcfg.Int("max_photos") > 0))
            {
                throw new AppException("Photos in reviews are switched off", "photos_off");
            }
            url = await images.SaveImageAsync(data, "reviews");
        }
        return new JsonObject { ["url"] = url, ["kind"] = isVideo ? "video" : "image" };
    }

    // ------------------------------------------------------------------ votes and reports

    /// <summary>Marks a review helpful; a second call takes the vote back.</summary>
    public async Task<JsonObject> HelpfulAsync(UserModel user, Guid reviewId)
    {
        var r = await reviews.GetAsync(reviewId);
        if (r is null || r.Status != "published") throw new NotFoundException("Review");
        if (r.UserId == user.Id) throw new AppException("You cannot vote on your own review", "own_review");
        var delta = 1;
        if (await reviews.GetVoteAsync(reviewId, user.Id) is not null)
        {
            await db.ExecuteAsync("DELETE FROM review_votes WHERE review_id = @reviewId AND user_id = @userId", new { reviewId, userId = user.Id });
            delta = -1;
        }
        else
        {
            await db.ExecuteAsync("INSERT INTO review_votes (review_id, user_id, created_at) VALUES (@reviewId, @userId, UTC_TIMESTAMP(6))",
                new { reviewId, userId = user.Id });
        }
        await db.ExecuteAsync("UPDATE reviews SET helpful_count = GREATEST(helpful_count + @delta, 0) WHERE id = @reviewId", new { delta, reviewId });
        var count = await db.ExecuteScalarAsync<long>("SELECT helpful_count FROM reviews WHERE id = @reviewId", new { reviewId });
        return new JsonObject { ["ok"] = true, ["voted"] = delta == 1, ["helpful_count"] = count };
    }

    public async Task<JsonObject> ReportAsync(UserModel user, Guid reviewId, string reason, string note)
    {
        var r = await reviews.GetAsync(reviewId);
        if (r is null || r.Status != "published") throw new NotFoundException("Review");
        if (r.UserId == user.Id) throw new AppException("You cannot report your own review", "own_review");
        await rateLimit.RateLimitAsync($"review-report:{user.Id}", 30, 86400);
        if (!ReviewSettingsBAL.ReportReasons.ContainsKey(reason)) throw new AppException("Choose a reason", "invalid_reason");
        if (await reviews.GetReportAsync(reviewId, user.Id) is not null)
        {
            return new JsonObject { ["ok"] = true, ["already"] = true };
        }
        var rcfg = await reviewSettings.GetAsync();
        var hidden = false;
        await using var uow = await db.BeginAsync();
        var locked = await uow.QueryFirstOrDefaultAsync<ReviewModel>("SELECT * FROM reviews WHERE id = @reviewId FOR UPDATE", new { reviewId })
            ?? throw new NotFoundException("Review");
        await uow.ExecuteAsync(
            "INSERT INTO review_reports (id, review_id, user_id, reason, note, status, created_at) VALUES (@id, @reviewId, @userId, @reason, @note, 'open', UTC_TIMESTAMP(6))",
            new { id = Guid.NewGuid(), reviewId, userId = user.Id, reason, note = note.Trim() });
        locked.ReportCount += 1;
        await uow.ExecuteAsync("UPDATE reviews SET report_count = report_count + 1 WHERE id = @reviewId", new { reviewId });
        if (rcfg.Int("report_hide_at") > 0 && locked.ReportCount >= rcfg.Int("report_hide_at") && locked.Status == "published")
        {
            locked.Status = "pending"; // out of sight until staff look at it
            await uow.ExecuteAsync("UPDATE reviews SET status = 'pending', updated_at = UTC_TIMESTAMP(6) WHERE id = @reviewId", new { reviewId });
            hidden = true;
            await RefreshRatingsAsync(uow, locked.ProductId);
        }
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true, ["already"] = false, ["hidden"] = hidden };
    }

    /// <summary>Report an issue with a product; staff see it in Admin → Product reports.</summary>
    public async Task<JsonObject> ReportProductAsync(UserModel user, string slug, string reason, string note, string url)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("pdp_report")) throw new AppException("Reporting is switched off", "reports_off");
        if (!PlatformSettingsBAL.ProductReportReasons.ContainsKey(reason)) throw new AppException("Choose what is wrong", "invalid_reason");
        if (reason is "wrong_info" or "other" or "counterfeit" or "unsafe" && note.Trim().Length < 10)
        {
            throw new AppException("Tell us a little more (at least 10 characters)", "note_required",
                fields: new Dictionary<string, string> { ["note"] = "Too short" });
        }
        var p = await reviews.PublicProductBySlugAsync(slug) ?? throw new NotFoundException("Product");
        await rateLimit.RateLimitAsync($"product-report:{user.Id}", 10, 86400);
        var rep = await reviews.GetOpenProductReportAsync(p.Id, user.Id);
        if (rep is null)
        {
            rep = new ProductReportModel { Id = Guid.NewGuid(), ProductId = p.Id, SellerId = p.SellerId, UserId = user.Id, Status = "open" };
            await db.ExecuteAsync(
                "INSERT INTO product_reports (id, product_id, seller_id, user_id, reason, note, url, status, admin_note, seller_note, created_at, updated_at) " +
                "VALUES (@Id, @ProductId, @SellerId, @UserId, @reason, @note, @url, 'open', '', '', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
                new { rep.Id, rep.ProductId, rep.SellerId, rep.UserId, reason, note = note.Trim(), url });
        }
        else
        {
            await db.ExecuteAsync(
                "UPDATE product_reports SET reason = @reason, note = @note, url = @url, updated_at = UTC_TIMESTAMP(6) WHERE id = @id",
                new { reason, note = note.Trim(), url, id = rep.Id });
        }
        return new JsonObject { ["ok"] = true, ["id"] = rep.Id.ToString() };
    }

    // ------------------------------------------------------------------ helpers

    private async Task<ProductModel> ProductBySlugAsync(string slug) =>
        await reviews.ProductBySlugAsync(slug) ?? throw new NotFoundException("Product");

    /// <summary>(reason the user cannot write a review or null, the delivered package that verifies the purchase).</summary>
    private async Task<(string? WhyNot, SubOrderModel? Sub)> ReviewGateAsync(ProductModel p, UserModel? user, JsonObject cfg, JsonObject rcfg)
    {
        if (!cfg.Bool("feature_reviews")) return ("off", null);
        if (user is null) return ("sign_in", null);
        var seller = await reviews.GetSellerAsync(p.SellerId);
        if (seller is not null && seller.UserId == user.Id) return ("own_product", null);
        var sub = await reviews.DeliveredSubAsync(user.Id, p.Id);
        if (sub is null && rcfg.Bool("buyers_only")) return ("not_purchased", null);
        return (null, sub);
    }

    /// <summary>Reference: refresh_ratings — product and seller averages/counts over published reviews.</summary>
    private static async Task RefreshRatingsAsync(IUnitOfWork uow, Guid productId)
    {
        var p = await uow.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @productId FOR UPDATE", new { productId })
            ?? throw new NotFoundException("Product");
        var (avg, count) = await uow.QueryFirstOrDefaultAsync<(decimal, long)>(
            "SELECT COALESCE(AVG(rating), 0), COUNT(*) FROM reviews WHERE product_id = @productId AND status = 'published'", new { productId });
        await uow.ExecuteAsync("UPDATE products SET rating_avg = @avg, rating_count = @count, updated_at = UTC_TIMESTAMP(6) WHERE id = @productId",
            new { avg = Math.Round(avg, 2), count = (int)count, productId });
        var (savg, scount) = await uow.QueryFirstOrDefaultAsync<(decimal, long)>(
            "SELECT COALESCE(AVG(r.rating), 0), COUNT(*) FROM reviews r JOIN products pr ON pr.id = r.product_id " +
            "WHERE pr.seller_id = @sellerId AND r.status = 'published'", new { p.SellerId });
        await uow.ExecuteAsync("UPDATE sellers SET rating_avg = @savg, rating_count = @scount, updated_at = UTC_TIMESTAMP(6) WHERE id = @sellerId",
            new { savg = Math.Round(savg, 2), scount = (int)scount, p.SellerId });
    }

    /// <summary>Reference review_out: media only when it may be shown and is published.</summary>
    private static JsonObject ReviewOut(ReviewModel r, string? name, bool showMedia, HashSet<Guid> voted, HashSet<Guid> reported, Guid? userId) => new()
    {
        ["id"] = r.Id.ToString(),
        ["rating"] = r.Rating,
        ["title"] = r.Title,
        ["body"] = r.Body,
        ["author"] = (name ?? "Customer").Split(' ')[0],
        ["verified"] = r.Verified,
        ["seller_reply"] = r.SellerReply,
        ["helpful_count"] = r.HelpfulCount,
        ["created_at"] = r.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
        ["media"] = showMedia && r.MediaStatus == "published" ? JsonHelper.Node(r.Media) : new JsonArray(),
        ["voted"] = voted.Contains(r.Id),
        ["reported"] = reported.Contains(r.Id),
        ["mine"] = userId is not null && r.UserId == userId,
    };

    /// <summary>Reference: customer_media — items newest first; the total counts every photo and video.</summary>
    private async Task<(JsonArray Items, long Total)> CustomerMediaInnerAsync(Guid productId, int limit, int offset)
    {
        var (rows, total) = await reviews.CustomerMediaAsync(productId);
        var all = new List<JsonObject>();
        foreach (var (r, name) in rows)
        {
            foreach (var m in JsonHelper.Array(r.Media))
            {
                if (m is not JsonObject media) continue;
                all.Add(new JsonObject
                {
                    ["kind"] = media["kind"]?.GetValue<string>() ?? "image",
                    ["url"] = media["url"]?.GetValue<string>() ?? "",
                    ["poster_url"] = media["poster_url"]?.GetValue<string>() ?? "",
                    ["review_id"] = r.Id.ToString(),
                    ["rating"] = r.Rating,
                    ["title"] = r.Title,
                    ["body"] = r.Body.Length > 600 ? r.Body[..600] : r.Body,
                    ["author"] = (name ?? "Customer").Split(' ')[0],
                    ["verified"] = r.Verified,
                    ["created_at"] = r.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
                });
            }
        }
        var page = new JsonArray();
        foreach (var item in all.Skip(offset).Take(limit))
        {
            page.Add(item);
        }
        return (page, total);
    }

    /// <summary>Reference: review_topics + topic_stats — topics mentioned at least twice, best-known first, top 8.</summary>
    private async Task<JsonArray> ReviewTopicsAsync(JsonObject rcfg, Guid productId)
    {
        var topics = rcfg["topics"] as JsonArray ?? [];
        var texts = (await reviews.TopicTextsAsync(productId)).Select(t => (t.Rating, $"{t.Title} {t.Body}")).ToList();
        var stats = new List<(string Name, int Count, int Pos, int Neg, int Pct, string Tone)>();
        foreach (var t in topics)
        {
            if (t is not JsonObject topic) continue;
            var words = (topic["words"] as JsonArray ?? []).Select(w => w?.GetValue<string>() ?? "").Where(w => w.Length > 0);
            var rx = ReviewSettingsBAL.TopicRegex(words);
            var hits = texts.Where(x => rx.IsMatch(x.Item2)).Select(x => x.Rating).ToList();
            if (hits.Count < 2) continue;
            var pos = hits.Count(x => x >= 4);
            var neg = hits.Count(x => x <= 2);
            var pct = (int)Math.Round(100.0 * pos / hits.Count);
            var tone = pct >= 70 ? "positive" : neg * 100 >= 60 * hits.Count ? "negative" : "mixed";
            stats.Add((topic["name"]?.GetValue<string>() ?? "", hits.Count, pos, neg, pct, tone));
        }
        var arr = new JsonArray();
        foreach (var s in stats.OrderByDescending(s => s.Count).Take(8))
        {
            arr.Add(new JsonObject { ["name"] = s.Name, ["count"] = s.Count, ["positive"] = s.Pos, ["negative"] = s.Neg, ["positive_pct"] = s.Pct, ["tone"] = s.Tone });
        }
        return arr;
    }

    /// <summary>Reference: topic_pattern — a case-insensitive whole-word match for any of the topic's words.</summary>
    private static string? TopicPattern(JsonObject rcfg, string topic)
    {
        if (topic.Length == 0) return null;
        var topics = rcfg["topics"] as JsonArray ?? [];
        foreach (var t in topics)
        {
            if (t is not JsonObject x) continue;
            if (!string.Equals(x["name"]?.GetValue<string>(), topic, StringComparison.OrdinalIgnoreCase)) continue;
            var words = (x["words"] as JsonArray ?? []).Select(w => NonTopicWord().Replace(w?.GetValue<string>() ?? "", "")).Where(w => w.Length > 0);
            return "\\b(" + string.Join("|", words) + ")\\b";
        }
        return null;
    }
}
