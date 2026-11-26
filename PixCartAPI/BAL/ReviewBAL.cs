using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Model.DomainModel.Catalog;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Reviews on the storefront (reference: the reviews part of routers/customer.py, plus product_page.customer_media
/// and review_topics). Anyone can read reviews. Writing, voting "helpful" and reporting need a signed-in customer;
/// by default only customers whose order was delivered can write (Admin → Reviews → Settings).
/// </summary>
public partial class ReviewBAL(
    ReviewDAL reviews,
    CatalogDAL catalog,
    CatalogSupportDAL support,
    IPlatformSettingsBAL platform,
    IReviewSettingsBAL reviewSettings,
    IImageUpload uploads,
    AppSettings app) : IReviewBAL
{
    /// <summary>Phone numbers, emails and links: such posts wait for a person to check them.</summary>
    [GeneratedRegex(@"(https?://|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d))", RegexOptions.IgnoreCase)]
    public static partial Regex Contact();

    [GeneratedRegex(@"[^\w' -]")]
    private static partial Regex NotWordChar();

    private bool MediaOk(string url, string folder) =>
        url.StartsWith($"{app.MediaBaseUrl.TrimEnd('/')}/{folder}/", StringComparison.Ordinal) && !url.Contains("..") && url.Length <= 400;

    private static AppException Invalid(string field, string label, string message) =>
        new($"{label}: {message}", "validation_error", 422, new Dictionary<string, string> { [field] = message });

    private async Task<ProductModel> ProductBySlugAsync(string slug) =>
        await catalog.ProductBySlugAsync(slug) ?? throw new NotFoundException("Product");

    /// <summary>(reason the user cannot write a review or null, the delivered package that verifies the purchase).</summary>
    private async Task<(string? WhyNot, Guid? SubOrderId)> ReviewGateAsync(ProductModel p, UserModel? user, JsonObject cfg, JsonObject rcfg)
    {
        if (!cfg.Bool("feature_reviews")) return ("off", null);
        if (user is null) return ("sign_in", null);
        var seller = await catalog.GetSellerAsync(p.SellerId);
        if (seller != null && seller.UserId == user.Id) return ("own_product", null);
        var sub = await reviews.DeliveredSubOrderAsync(user.Id, p.Id);
        if (sub is null && rcfg.Bool("buyers_only")) return ("not_purchased", null);
        return (null, sub);
    }

    private static string FirstName(string? name) => (string.IsNullOrEmpty(name) ? "Customer" : name).Split(' ')[0];

    private static JsonObject ReviewOut(ReviewWithName r, bool showMedia, HashSet<Guid> voted, HashSet<Guid> reported, Guid? userId) => new()
    {
        ["id"] = r.Id.ToString(), ["rating"] = r.Rating, ["title"] = r.Title, ["body"] = r.Body, ["author"] = FirstName(r.AuthorName),
        ["verified"] = r.Verified, ["seller_reply"] = r.SellerReply, ["helpful_count"] = r.HelpfulCount, ["created_at"] = DateTimeFunctions.Iso(r.CreatedAt),
        ["media"] = showMedia && r.MediaStatus == "published" ? JsonHelper.Node(r.Media) ?? new JsonArray() : new JsonArray(),
        ["voted"] = voted.Contains(r.Id), ["reported"] = reported.Contains(r.Id), ["mine"] = userId != null && r.UserId == userId,
    };

    /// <summary>A topic pattern for the database: any of the words, as whole words.</summary>
    public static string TopicPattern(IEnumerable<string> words) =>
        @"\b(" + string.Join("|", words.Select(w => NotWordChar().Replace(w, ""))) + @")\b";

    public async Task<JsonObject> ProductReviewsAsync(string slug, UserModel? user, ReviewQuery q)
    {
        var p = await ProductBySlugAsync(slug);
        var cfg = await platform.GetAsync();
        var rcfg = await reviewSettings.GetAsync();
        var showMedia = rcfg.Bool("media_public") || user != null;
        var f = new ReviewFilter { Star = q.Star, Media = q.Media, Verified = q.Verified };
        if (q.Topic.Length > 0)
        {
            var t = (rcfg["topics"] as JsonArray ?? []).OfType<JsonObject>()
                .FirstOrDefault(x => CatalogText.Str(x["name"]).Equals(q.Topic, StringComparison.OrdinalIgnoreCase));
            if (t != null) f.TopicPattern = TopicPattern((t["words"] as JsonArray ?? []).Select(CatalogText.Str));
        }
        var size = cfg.Int("reviews_page_size");
        var rows = (await reviews.PageAsync(p.Id, f, q.Sort, size, (q.Page - 1) * size)).ToList();
        var total = await reviews.CountAsync(p.Id, f);
        var dist = await reviews.DistributionAsync(p.Id);
        var withMedia = await reviews.WithMediaCountAsync(p.Id);
        var verifiedCount = await reviews.CountAsync(p.Id, new ReviewFilter { Verified = true });
        var (whyNot, _) = await ReviewGateAsync(p, user, cfg, rcfg);
        JsonObject? mine = null;
        var voted = new HashSet<Guid>();
        var reported = new HashSet<Guid>();
        if (user != null)
        {
            var m = await reviews.MineAsync(p.Id, user.Id);
            if (m != null)
            {
                mine = new JsonObject
                {
                    ["rating"] = m.Rating, ["title"] = m.Title, ["body"] = m.Body, ["media"] = JsonHelper.Node(m.Media),
                    ["status"] = m.Status, ["media_status"] = m.MediaStatus,
                };
                if (whyNot == "not_purchased") whyNot = null; // an existing review can always be edited or deleted
            }
            var ids = rows.Select(r => r.Id).ToList();
            if (ids.Count > 0)
            {
                voted = await reviews.VotedAsync(user.Id, ids);
                reported = await reviews.ReportedAsync(user.Id, ids);
            }
        }
        var (gallery, mediaTotal) = showMedia ? await CustomerMediaAsync(p.Id, Math.Max(12, cfg.Int("customer_photos_shown"))) : ([], 0);
        var distribution = new JsonObject();
        for (var k = 5; k >= 1; k--) distribution[k.ToString()] = dist.GetValueOrDefault(k);
        return new JsonObject
        {
            ["rating_avg"] = (double)p.RatingAvg,
            ["rating_count"] = p.RatingCount,
            ["distribution"] = distribution,
            ["summary"] = p.ReviewSummary,
            ["topics"] = rcfg.Bool("topics_enabled") ? await ReviewTopicsAsync(rcfg["topics"] as JsonArray ?? [], productId: p.Id) : new JsonArray(),
            ["with_media_count"] = withMedia,
            ["verified_count"] = verifiedCount,
            ["media"] = gallery,
            ["media_total"] = mediaTotal,
            ["media_hidden"] = !showMedia && withMedia > 0,
            ["can_review"] = whyNot == null,
            ["cannot_review_reason"] = whyNot,
            ["mine"] = mine,
            ["settings"] = reviewSettings.Public(rcfg),
            ["items"] = CatalogBAL.Arr(rows.Select(r => (JsonNode)ReviewOut(r, showMedia, voted, reported, user?.Id))),
            ["total"] = total,
            ["page"] = q.Page,
            ["has_more"] = (long)q.Page * size < total,
        };
    }

    public async Task<JsonObject> ProductMediaAsync(string slug, UserModel? user, int page)
    {
        var p = await ProductBySlugAsync(slug);
        var rcfg = await reviewSettings.GetAsync();
        if (!(rcfg.Bool("media_public") || user != null))
            return new JsonObject { ["items"] = new JsonArray(), ["total"] = 0, ["page"] = page, ["has_more"] = false, ["sign_in_to_see"] = true };
        var (items, total) = await CustomerMediaAsync(p.Id, 30, (page - 1) * 30);
        return new JsonObject { ["items"] = items, ["total"] = total, ["page"] = page, ["has_more"] = page * 30L < total };
    }

    public async Task<JsonObject> WriteReviewAsync(string slug, UserModel user, ReviewIn body)
    {
        for (var i = 0; i < body.Media.Count; i++)
        {
            var m = body.Media[i];
            const string msg = "Upload photos and videos here; links to other sites are not allowed";
            if (!MediaOk(m.Url, m.Kind == "image" ? "reviews" : "review-videos") || (m.PosterUrl.Length > 0 && !MediaOk(m.PosterUrl, "reviews")))
                throw Invalid($"media.{i}", "Media", msg);
        }
        var cfg = await platform.GetAsync();
        var rcfg = await reviewSettings.GetAsync();
        var p = await ProductBySlugAsync(slug);
        var existing = await reviews.MineAsync(p.Id, user.Id);
        var (whyNot, sub) = await ReviewGateAsync(p, user, cfg, rcfg);
        if (whyNot == "off") throw new AppException("Reviews are turned off", "reviews_off");
        if (whyNot == "own_product") throw new AppException("Sellers cannot review their own products", "own_product");
        if (whyNot == "not_purchased" && existing is null) throw new AppException("You can review a product after it has been delivered to you", "not_purchased");
        var title = body.Title.Trim();
        var text = body.Body.Trim();
        var minChars = rcfg.Int("min_body_chars");
        if (minChars > 0 && text.Length < minChars) throw new AppException($"Write at least {minChars} characters about the product", "review_too_short");
        var photos = body.Media.Count(m => m.Kind == "image");
        var videos = body.Media.Count(m => m.Kind == "video");
        if (photos > 0 && !(rcfg.Bool("photos") && rcfg.Int("max_photos") > 0)) throw new AppException("Photos in reviews are switched off", "photos_off");
        if (photos > rcfg.Int("max_photos")) throw new AppException($"Add at most {rcfg.Int("max_photos")} photos", "too_many_photos");
        if (videos > 0 && !rcfg.Bool("videos")) throw new AppException("Videos in reviews are switched off", "videos_off");
        if (videos > 1) throw new AppException("Add at most one video", "too_many_videos");
        var media = new JsonArray(body.Media.Select(m => (JsonNode)new JsonObject { ["kind"] = m.Kind, ["url"] = m.Url, ["poster_url"] = m.PosterUrl }).ToArray());
        var now = DateTimeFunctions.UtcNow();
        var r = existing ?? new ReviewModel
        {
            Id = Guid.NewGuid(), ProductId = p.Id, UserId = user.Id, Media = "[]", MediaStatus = "published", SellerReply = "", CreatedAt = now,
        };
        var mediaChanged = existing != null ? !JsonNode.DeepEquals(JsonHelper.Node(existing.Media), media) : media.Count > 0;
        if (sub != null || existing is null)
        {
            r.SubOrderId = sub;
            r.Verified = sub != null;
        }
        r.Rating = body.Rating!.Value;
        r.Title = title;
        r.Body = text;
        r.Media = media.ToJsonString();
        // Links, emails and phone numbers are not allowed in reviews: such reviews wait for a person to check.
        var flagged = Contact().IsMatch($"{title} {text}");
        r.Status = cfg.Bool("reviews_need_approval") || flagged ? "pending" : "published";
        if (media.Count == 0) r.MediaStatus = "published";
        else if (mediaChanged) r.MediaStatus = rcfg.Bool("media_need_approval") ? "pending" : "published";
        r.UpdatedAt = now;
        if (existing is null) await reviews.InsertAsync(r);
        else await reviews.UpdateAsync(r);
        await reviews.RefreshRatingsAsync(p.Id);
        return new JsonObject { ["ok"] = true, ["status"] = r.Status, ["media_status"] = r.MediaStatus, ["held_for_check"] = flagged };
    }

    public async Task<JsonObject> DeleteReviewAsync(string slug, UserModel user)
    {
        var p = await ProductBySlugAsync(slug);
        var r = await reviews.MineAsync(p.Id, user.Id) ?? throw new NotFoundException("Review");
        await reviews.DeleteAsync(r.Id);
        await reviews.RefreshRatingsAsync(p.Id);
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> UploadMediaAsync(UserModel user, byte[] data)
    {
        var cfg = await platform.GetAsync();
        var rcfg = await reviewSettings.GetAsync();
        if (!cfg.Bool("feature_reviews")) throw new AppException("Reviews are turned off", "reviews_off");
        await support.RateLimitAsync($"review-media:{user.Id}", 40, 3600);
        var videoLimit = rcfg.Long("max_video_mb") * 1024 * 1024;
        bool isVideo;
        try
        {
            ImageUpload.SniffVideo(data);
            isVideo = true;
        }
        catch (AppException)
        {
            isVideo = false;
        }
        string url;
        if (isVideo)
        {
            if (!rcfg.Bool("videos")) throw new AppException("Videos in reviews are switched off", "videos_off");
            url = await uploads.SaveVideoAsync(data, videoLimit, "review-videos");
        }
        else
        {
            if (!(rcfg.Bool("photos") && rcfg.Int("max_photos") > 0)) throw new AppException("Photos in reviews are switched off", "photos_off");
            url = await uploads.SaveImageAsync(data, "reviews");
        }
        return new JsonObject { ["url"] = url, ["kind"] = isVideo ? "video" : "image" };
    }

    public async Task<JsonObject> HelpfulAsync(Guid reviewId, UserModel user)
    {
        var r = await reviews.GetAsync(reviewId);
        if (r is null || r.Status != "published") throw new NotFoundException("Review");
        if (r.UserId == user.Id) throw new AppException("You cannot vote on your own review", "own_review");
        var (voted, count) = await reviews.ToggleVoteAsync(reviewId, user.Id);
        return new JsonObject { ["ok"] = true, ["voted"] = voted, ["helpful_count"] = count };
    }

    public async Task<JsonObject> FileReviewReportAsync(ReviewModel review, Guid userId, ReviewReportIn body)
    {
        if (!ReviewSettingsBAL.ReportReasons.ContainsKey(body.Reason)) throw new AppException("Choose a reason", "invalid_reason");
        var rcfg = await reviewSettings.GetAsync();
        var (already, hidden) = await reviews.FileReportAsync(review.Id, userId, body.Reason, body.Note.Trim(), rcfg.Int("report_hide_at"));
        if (already) return new JsonObject { ["ok"] = true, ["already"] = true };
        if (hidden) await reviews.RefreshRatingsAsync(review.ProductId); // out of sight until staff look at it
        return new JsonObject { ["ok"] = true, ["already"] = false, ["hidden"] = hidden };
    }

    public async Task<JsonObject> ReportReviewAsync(Guid reviewId, UserModel user, ReviewReportIn body)
    {
        var r = await reviews.GetAsync(reviewId);
        if (r is null || r.Status != "published") throw new NotFoundException("Review");
        if (r.UserId == user.Id) throw new AppException("You cannot report your own review", "own_review");
        await support.RateLimitAsync($"review-report:{user.Id}", 30, 86400);
        return await FileReviewReportAsync(r, user.Id, body);
    }

    [GeneratedRegex(@"^https?://[^\s]+$")]
    private static partial Regex WebAddress();

    public async Task<JsonObject> ReportProductAsync(string slug, UserModel user, ProductReportIn body)
    {
        var url = body.Url.Trim();
        if (url.Length > 0 && !WebAddress().IsMatch(url)) throw Invalid("url", "Url", "Enter a web address starting with https://");
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("pdp_report")) throw new AppException("Reporting is switched off", "reports_off");
        if (!PlatformSettingsBAL.ProductReportReasons.ContainsKey(body.Reason)) throw new AppException("Choose what is wrong", "invalid_reason");
        if (body.Reason is "wrong_info" or "other" or "counterfeit" or "unsafe" && body.Note.Trim().Length < 10)
            throw new AppException("Tell us a little more (at least 10 characters)", "note_required", fields: new Dictionary<string, string> { ["note"] = "Too short" });
        var p = await catalog.PublicProductBySlugAsync(slug) ?? throw new NotFoundException("Product");
        await support.RateLimitAsync($"product-report:{user.Id}", 10, 86400);
        var now = DateTimeFunctions.UtcNow();
        var rep = await reviews.OpenProductReportAsync(p.Id, user.Id);
        if (rep is null)
        {
            rep = new ProductReportModel
            {
                Id = Guid.NewGuid(), ProductId = p.Id, SellerId = p.SellerId, UserId = user.Id, Status = "open", Reason = body.Reason,
                Note = body.Note.Trim(), Url = url, AdminNote = "", SellerNote = "", CreatedAt = now, UpdatedAt = now,
            };
            await reviews.InsertProductReportAsync(rep);
        }
        else
        {
            rep.Reason = body.Reason;
            rep.Note = body.Note.Trim();
            rep.Url = url;
            rep.UpdatedAt = now;
            await reviews.UpdateProductReportAsync(rep);
        }
        return new JsonObject { ["ok"] = true, ["id"] = rep.Id.ToString() };
    }

    public Task RefreshRatingsAsync(Guid productId) => reviews.RefreshRatingsAsync(productId);

    public async Task<(JsonArray Items, long Total)> CustomerMediaAsync(Guid productId, int limit = 30, int offset = 0)
    {
        var (rows, total) = await reviews.WithMediaAsync(productId);
        var items = new List<JsonNode>();
        foreach (var r in rows)
        {
            foreach (var m in (JsonHelper.Node(r.Media) as JsonArray ?? []).OfType<JsonObject>())
            {
                items.Add(new JsonObject
                {
                    ["kind"] = m.TryGetPropertyValue("kind", out var k) ? k?.DeepClone() : "image",
                    ["url"] = m.TryGetPropertyValue("url", out var u) ? u?.DeepClone() : "",
                    ["poster_url"] = m.TryGetPropertyValue("poster_url", out var pu) ? pu?.DeepClone() : "",
                    ["review_id"] = r.Id.ToString(), ["rating"] = r.Rating, ["title"] = r.Title, ["body"] = CatalogText.Cut(r.Body, 600),
                    ["author"] = FirstName(r.AuthorName), ["verified"] = r.Verified, ["created_at"] = DateTimeFunctions.Iso(r.CreatedAt),
                });
            }
        }
        return (new JsonArray(items.Skip(offset).Take(limit).ToArray()), total);
    }

    /// <summary>
    /// For each topic: how many reviews mention it and how many of those are positive (4-5 stars) or negative (1-2
    /// stars). Topics mentioned fewer than <paramref name="minMentions"/> times are left out; at most 8, most mentioned first.
    /// </summary>
    public static JsonArray TopicStats(IEnumerable<(int Rating, string Text)> texts, JsonArray topics, int minMentions = 2)
    {
        var list = texts.ToList();
        var outp = new List<(int Count, JsonObject Row)>();
        foreach (var t in topics.OfType<JsonObject>())
        {
            var rx = ReviewSettingsBAL.TopicRegex((t["words"] as JsonArray ?? []).Select(CatalogText.Str));
            var hits = list.Where(x => rx.IsMatch(x.Text)).Select(x => x.Rating).ToList();
            if (hits.Count < minMentions) continue;
            var pos = hits.Count(x => x >= 4);
            var neg = hits.Count(x => x <= 2);
            var pct = (int)Math.Round(100.0 * pos / hits.Count, MidpointRounding.ToEven);
            var tone = pct >= 70 ? "positive" : neg * 100 >= 60 * hits.Count ? "negative" : "mixed";
            outp.Add((hits.Count, new JsonObject
            {
                ["name"] = t["name"]?.DeepClone(), ["count"] = hits.Count, ["positive"] = pos, ["negative"] = neg, ["positive_pct"] = pct, ["tone"] = tone,
            }));
        }
        return new JsonArray(outp.OrderBy(x => -x.Count).Take(8).Select(x => (JsonNode)x.Row).ToArray());
    }

    public async Task<JsonArray> ReviewTopicsAsync(JsonArray topics, Guid? productId = null, Guid? sellerId = null) =>
        TopicStats(await reviews.TextsAsync(productId, sellerId), topics);
}
