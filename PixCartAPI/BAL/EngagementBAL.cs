using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Product Q&A, back-in-stock alerts, comparison and "Frequently bought together" (reference: routers/engagement.py).
/// Posts with phone numbers, emails or links wait for staff; enough reports hide a post until staff check it.
/// </summary>
public partial class EngagementBAL(
    EngagementDAL engagement,
    ICatalogBAL catalog,
    IPlatformSettingsBAL platform,
    IRateLimitBAL rateLimit,
    ICatalogNotifyBAL notify,
    IAccessBAL access,
    IAuditBAL audit,
    IMySqlDapperHelper db) : IEngagementBAL
{
    [GeneratedRegex(@"(https?://|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d))", RegexOptions.IgnoreCase)]
    private static partial Regex Contact();

    private static readonly IReadOnlyDictionary<string, string> RoleLabel = new Dictionary<string, string>
    {
        ["seller"] = "Seller", ["buyer"] = "Verified buyer", ["customer"] = "Customer", ["staff"] = "Store team",
    };

    private static string First(string? name) => (name ?? "Customer").Split(' ')[0];

    // ------------------------------------------------------------------ questions

    public async Task<JsonObject> QuestionsAsync(UserModel? user, string slug, string q, string sort, int page)
    {
        var cfg = await platform.GetAsync();
        var p = await ProductAsync(slug);
        if (!cfg.Bool("feature_qa"))
        {
            return new JsonObject { ["enabled"] = false, ["items"] = new JsonArray(), ["total"] = 0, ["page"] = page, ["has_more"] = false };
        }
        var like = q.Trim().Length > 0 ? $"%{q.Trim()}%" : null;
        var size = cfg.Int("questions_page_size");
        var (rows, total) = await engagement.QuestionsAsync(p.Id, like, sort, (page - 1) * size, size);
        var answers = new Dictionary<Guid, List<EngagementDAL.AnswerRow>>();
        var voted = new HashSet<Guid>();
        if (rows.Count > 0)
        {
            foreach (var a in await engagement.AnswersForAsync(rows.Select(r => r.Id).ToList()))
            {
                if (!answers.TryGetValue(a.QuestionId, out var lst)) answers[a.QuestionId] = lst = [];
                lst.Add(a);
            }
            if (user is not null)
            {
                voted = await engagement.VotedAsync(user.Id, answers.Values.SelectMany(l => l.Select(a => a.Id)).ToList());
            }
        }
        var seller = await engagement.GetSellerAsync(p.SellerId);
        var items = new JsonArray();
        foreach (var qn in rows)
        {
            var arr = new JsonArray();
            foreach (var a in answers.GetValueOrDefault(qn.Id) ?? [])
            {
                arr.Add(new JsonObject
                {
                    ["id"] = a.Id.ToString(),
                    ["text"] = a.Text,
                    ["author"] = a.Role == "seller" ? seller?.DisplayName ?? "Seller" : First(a.Name),
                    ["role"] = a.Role,
                    ["role_label"] = RoleLabel[a.Role],
                    ["helpful_count"] = a.HelpfulCount,
                    ["voted"] = voted.Contains(a.Id),
                    ["created_at"] = a.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
                });
            }
            items.Add(new JsonObject
            {
                ["id"] = qn.Id.ToString(),
                ["text"] = qn.Text,
                ["author"] = First(qn.Name),
                ["created_at"] = qn.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
                ["answer_count"] = qn.AnswerCount,
                ["answers"] = arr,
            });
        }
        return new JsonObject
        {
            ["enabled"] = true, ["items"] = items, ["total"] = total, ["page"] = page,
            ["has_more"] = (long)page * size < total, ["can_ask"] = user is not null,
            ["buyers_answer_only"] = cfg.Bool("qa_buyers_answer_only"),
        };
    }

    public async Task<JsonObject> AskAsync(UserModel user, string slug, string text)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_qa")) throw new AppException("Questions are switched off", "qa_off");
        var p = await ProductAsync(slug);
        await rateLimit.RateLimitAsync($"qa-ask:{user.Id}", 10, 86400);
        text = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        var held = cfg.Bool("qa_need_approval") || Contact().IsMatch(text);
        var qn = new ProductQuestionModel
        {
            Id = Guid.NewGuid(), ProductId = p.Id, UserId = user.Id, Text = text,
            Status = held ? "pending" : "published", AnswerCount = 0, ReportCount = 0, CreatedAt = DateTime.UtcNow,
        };
        await db.ExecuteAsync(
            "INSERT INTO product_questions (id, product_id, user_id, text, status, answer_count, report_count, created_at) " +
            "VALUES (@Id, @ProductId, @UserId, @Text, @Status, 0, 0, UTC_TIMESTAMP(6))", qn);
        if (!held)
        {
            await notify.NotifySellerAsync(p.SellerId, "seller_new_question",
                new Dictionary<string, string> { ["item"] = p.Title, ["question"] = text[..Math.Min(200, text.Length)] }, "/seller/questions");
        }
        return new JsonObject { ["ok"] = true, ["id"] = qn.Id.ToString(), ["status"] = qn.Status };
    }

    public async Task<JsonObject> AnswerAsync(UserModel user, Guid questionId, string text)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_qa")) throw new AppException("Questions are switched off", "qa_off");
        var qn = await engagement.GetQuestionAsync(questionId);
        if (qn is null || qn.Status != "published") throw new NotFoundException("Question");
        var p = await engagement.GetProductAsync(qn.ProductId) ?? throw new NotFoundException("Product");
        var seller = await engagement.GetSellerAsync(p.SellerId);
        var role = seller is not null && seller.UserId == user.Id ? "seller"
            : await engagement.IsBuyerAsync(user.Id, p.Id) ? "buyer" : "customer";
        if (role == "customer" && cfg.Bool("qa_buyers_answer_only"))
        {
            throw new AppException("Only the seller and customers who bought this product can answer", "buyers_only");
        }
        if (qn.UserId == user.Id && role != "seller")
        {
            throw new AppException("You asked this question; wait for an answer from the seller or a buyer", "own_question");
        }
        await rateLimit.RateLimitAsync($"qa-answer:{user.Id}", 30, 86400);
        text = text.Trim();
        var held = cfg.Bool("qa_need_approval") || Contact().IsMatch(text);
        var a = new ProductAnswerModel
        {
            Id = Guid.NewGuid(), QuestionId = qn.Id, UserId = user.Id, Role = role, Text = text,
            Status = held ? "pending" : "published", HelpfulCount = 0, ReportCount = 0, CreatedAt = DateTime.UtcNow,
        };
        await db.ExecuteAsync(
            "INSERT INTO product_answers (id, question_id, user_id, role, text, status, helpful_count, report_count, created_at) " +
            "VALUES (@Id, @QuestionId, @UserId, @Role, @Text, @Status, 0, 0, UTC_TIMESTAMP(6))", a);
        if (!held)
        {
            await RefreshCountAsync(qn.Id);
            var asker = qn.UserId is Guid askerId ? await engagement.GetUserAsync(askerId) : null;
            if (asker is not null && asker.Id != user.Id)
            {
                await notify.NotifyUserAsync(asker.Id, "question_answered", new Dictionary<string, string>
                {
                    ["item"] = p.Title,
                    ["question"] = qn.Text[..Math.Min(200, qn.Text.Length)],
                    ["answer"] = text[..Math.Min(300, text.Length)],
                    ["answerer"] = role == "seller" ? seller?.DisplayName ?? "Seller" : RoleLabel[role],
                }, $"/p/{p.Slug}#questions");
            }
        }
        return new JsonObject { ["ok"] = true, ["id"] = a.Id.ToString(), ["status"] = a.Status, ["role"] = role };
    }

    /// <summary>Marks an answer helpful; a second call takes the vote back.</summary>
    public async Task<JsonObject> AnswerHelpfulAsync(UserModel user, Guid answerId)
    {
        var a = await engagement.GetAnswerAsync(answerId);
        if (a is null || a.Status != "published") throw new NotFoundException("Answer");
        if (a.UserId == user.Id) throw new AppException("You cannot vote on your own answer", "own_answer");
        var delta = 1;
        if (await engagement.GetVoteAsync(answerId, user.Id) is not null)
        {
            await db.ExecuteAsync("DELETE FROM answer_votes WHERE answer_id = @answerId AND user_id = @userId", new { answerId, userId = user.Id });
            delta = -1;
        }
        else
        {
            await db.ExecuteAsync("INSERT INTO answer_votes (answer_id, user_id, created_at) VALUES (@answerId, @userId, UTC_TIMESTAMP(6))",
                new { answerId, userId = user.Id });
        }
        await db.ExecuteAsync("UPDATE product_answers SET helpful_count = GREATEST(helpful_count + @delta, 0) WHERE id = @answerId", new { delta, answerId });
        var count = await db.ExecuteScalarAsync<long>("SELECT helpful_count FROM product_answers WHERE id = @answerId", new { answerId });
        return new JsonObject { ["voted"] = delta == 1, ["helpful_count"] = count };
    }

    /// <summary>Flags a question or answer; enough different reporters take it off the page until staff check it.</summary>
    public async Task<JsonObject> ReportAsync(UserModel user, bool question, Guid postId)
    {
        await rateLimit.RateLimitAsync($"qa-report:{user.Id}", 30, 86400);
        var (table, fk) = question ? ("question_reports", "question_id") : ("answer_reports", "answer_id");
        await using var uow = await db.BeginAsync();
        var obj = question
            ? await uow.QueryFirstOrDefaultAsync<ProductQuestionModel>($"SELECT * FROM product_questions WHERE id = @postId FOR UPDATE", new { postId })
            : null;
        var ans = !question
            ? await uow.QueryFirstOrDefaultAsync<ProductAnswerModel>($"SELECT * FROM product_answers WHERE id = @postId FOR UPDATE", new { postId })
            : null;
        if (obj is null && ans is null) throw new NotFoundException("Post");
        var status = obj?.Status ?? ans!.Status;
        if (status != "published") throw new NotFoundException("Post");
        var inserted = await uow.ExecuteAsync(
            $"INSERT IGNORE INTO {table} ({fk}, user_id, created_at) VALUES (@postId, @userId, UTC_TIMESTAMP(6))", new { postId, userId = user.Id });
        if (inserted == 0)
        {
            await uow.CommitAsync();
            return new JsonObject { ["ok"] = true, ["already"] = true, ["hidden"] = false };
        }
        var reportCount = (obj?.ReportCount ?? ans!.ReportCount) + 1;
        var hideAt = (await platform.GetAsync()).Int("qa_report_hide_at");
        var hidden = hideAt > 0 && reportCount >= hideAt;
        var postTable = question ? "product_questions" : "product_answers";
        await uow.ExecuteAsync(
            $"UPDATE {postTable} SET report_count = report_count + 1" + (hidden ? ", status = 'pending'" : "") + " WHERE id = @postId", new { postId });
        if (hidden && !question)
        {
            await RefreshCountAsync(ans!.QuestionId, uow);
        }
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true, ["already"] = false, ["hidden"] = hidden };
    }

    // ------------------------------------------------------------------ stock alerts

    public async Task<JsonObject> StockAlertOnAsync(UserModel user, Guid variantId)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_stock_alerts")) throw new AppException("Stock alerts are switched off", "alerts_off");
        var v = await engagement.GetVariantAsync(variantId);
        if (v is null || !v.IsActive) throw new NotFoundException("Product");
        var existing = await engagement.GetAlertAsync(user.Id, variantId);
        if (existing is null)
        {
            if (await engagement.ActiveAlertCountAsync(user.Id) >= 100)
            {
                throw new AppException("You can follow up to 100 items", "too_many_alerts");
            }
            await db.ExecuteAsync(
                "INSERT INTO stock_alerts (user_id, variant_id, created_at, notified_at, active) VALUES (@userId, @variantId, UTC_TIMESTAMP(6), NULL, 1)",
                new { userId = user.Id, variantId });
        }
        else
        {
            await db.ExecuteAsync("UPDATE stock_alerts SET active = 1, notified_at = NULL WHERE user_id = @userId AND variant_id = @variantId",
                new { userId = user.Id, variantId });
        }
        return new JsonObject { ["ok"] = true, ["subscribed"] = true };
    }

    public async Task<JsonObject> StockAlertOffAsync(UserModel user, Guid variantId)
    {
        await db.ExecuteAsync("DELETE FROM stock_alerts WHERE user_id = @userId AND variant_id = @variantId", new { userId = user.Id, variantId });
        return new JsonObject { ["ok"] = true, ["subscribed"] = false };
    }

    public async Task<JsonObject> MyAlertsAsync(UserModel user, Guid? variantId)
    {
        var rows = await engagement.MyAlertsAsync(user.Id, variantId);
        var images = await catalog.ImagesForAsync(rows.Select(r => r.ProductId).Distinct());
        var arr = new JsonArray();
        foreach (var r in rows)
        {
            arr.Add(new JsonObject
            {
                ["variant_id"] = r.VariantId.ToString(),
                ["product"] = r.Title,
                ["slug"] = r.Slug,
                ["variant"] = ProductInfo.VariantLabel(r.Options),
                ["image"] = images.GetValueOrDefault(r.ProductId)?.FirstOrDefault() ?? "",
                ["in_stock"] = r.Stock > 0,
                ["created_at"] = r.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
            });
        }
        return new JsonObject { ["stock"] = arr };
    }

    // ------------------------------------------------------------------ compare and bought together

    public async Task<JsonObject> CompareAsync(string ids)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_compare")) throw new AppException("Compare is switched off", "compare_off");
        var want = new List<Guid>();
        foreach (var x in ids.Split(',').Take(cfg.Int("compare_max")))
        {
            if (Guid.TryParse(x.Trim(), out var id)) want.Add(id);
        }
        var products = await engagement.CompareRowsAsync(want);
        var cards = await catalog.ProductCardsAsync(products);
        var specCount = new Dictionary<string, int>();
        foreach (var p in products)
        {
            foreach (var k in JsonHelper.Object(p.Specs).Select(kvp => kvp.Key).ToList())
            {
                specCount[k] = specCount.GetValueOrDefault(k) + 1;
            }
        }
        var keys = specCount.Keys.OrderBy(k => -specCount[k]).ThenBy(k => k, StringComparer.Ordinal).ToList();
        var items = new JsonArray();
        var infoKeys = new List<string>();
        for (var i = 0; i < products.Count; i++)
        {
            var p = products[i];
            var card = cards[i].DeepClone() as JsonObject ?? [];
            var info = new JsonObject();
            foreach (var r in ProductInfo.InfoRows(ProductInfo.DetailsOf(p.Details), p.Brand, p.CountryOfOrigin))
            {
                if (r is not JsonObject row) continue;
                var label = row["label"]?.GetValue<string>() ?? "";
                info[label] = row["value"]?.GetValue<string>() ?? "";
                if (!infoKeys.Contains(label)) infoKeys.Add(label);
            }
            card["specs"] = JsonHelper.Node(p.Specs);
            card["info"] = info;
            card["return_window_days"] = p.ReturnWindowDays;
            var highlights = JsonHelper.Array(p.Highlights);
            var top = new JsonArray();
            foreach (var h in highlights.Take(5))
            {
                top.Add(h?.GetValue<string>() ?? "");
            }
            card["highlights"] = top;
            items.Add(card);
        }
        return new JsonObject
        {
            ["items"] = items,
            ["spec_keys"] = new JsonArray(keys.Select(k => (JsonNode?)JsonValue.Create(k)).ToArray()),
            ["info_keys"] = new JsonArray(infoKeys.Select(k => (JsonNode?)JsonValue.Create(k)).ToArray()),
        };
    }

    public async Task<JsonObject> BoughtTogetherAsync(string slug)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_bought_together")) return new JsonObject { ["items"] = new JsonArray() };
        var p = await ProductAsync(slug);
        var others = (await engagement.BoughtTogetherAsync(p.Id, 3)).ToList();
        if (others.Count == 0) return new JsonObject { ["items"] = new JsonArray() };
        var cards = await catalog.ProductCardsAsync(new List<ProductModel> { p }.Concat(others).ToList());
        var items = new JsonArray();
        foreach (var card in cards)
        {
            items.Add(card);
        }
        return new JsonObject { ["items"] = items };
    }

    // ------------------------------------------------------------------ seller hub

    public async Task<JsonObject> SellerQuestionsAsync(UserModel user, bool unanswered, int page)
    {
        var seller = await SellerAsync(user);
        var (rows, total, waiting) = await engagement.SellerQuestionsAsync(seller.Id, unanswered, page);
        var answers = new Dictionary<Guid, List<ProductAnswerModel>>();
        if (rows.Count > 0)
        {
            foreach (var a in await engagement.SellerAnswersForAsync(rows.Select(r => r.Id).ToList()))
            {
                if (!answers.TryGetValue(a.QuestionId, out var lst)) answers[a.QuestionId] = lst = [];
                lst.Add(a);
            }
        }
        var items = new JsonArray();
        foreach (var qn in rows)
        {
            var mine = answers.GetValueOrDefault(qn.Id) ?? [];
            var arr = new JsonArray();
            foreach (var a in mine)
            {
                arr.Add(new JsonObject
                {
                    ["id"] = a.Id.ToString(), ["text"] = a.Text, ["role"] = a.Role, ["role_label"] = RoleLabel[a.Role],
                    ["status"] = a.Status, ["created_at"] = a.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"),
                });
            }
            items.Add(new JsonObject
            {
                ["id"] = qn.Id.ToString(), ["text"] = qn.Text, ["product"] = qn.ProductTitle, ["slug"] = qn.ProductSlug,
                ["created_at"] = qn.CreatedAt.ToString("yyyy-MM-ddTHH:mm:ss"), ["answers"] = arr,
                ["answered_by_you"] = mine.Any(a => a.Role == "seller"),
            });
        }
        return new JsonObject { ["items"] = items, ["total"] = total, ["page"] = page, ["unanswered"] = waiting };
    }

    /// <summary>Small counts for the seller hub menu.</summary>
    public async Task<JsonObject> SellerBadgesAsync(UserModel user)
    {
        var seller = await SellerAsync(user);
        var (orders, questions, reports, deals) = await engagement.SellerBadgesAsync(seller.Id);
        return new JsonObject { ["orders"] = orders, ["questions"] = questions, ["reports"] = reports, ["deals_running"] = deals };
    }

    public async Task<JsonObject> SellerAnswerAsync(UserModel user, Guid questionId, string text)
    {
        var seller = await SellerAsync(user);
        var qn = await engagement.GetQuestionAsync(questionId);
        var p = qn is null ? null : await engagement.GetProductAsync(qn.ProductId);
        if (qn is null || p is null || p.SellerId != seller.Id) throw new NotFoundException("Question");
        return await AnswerAsync(user, questionId, text);
    }

    // ------------------------------------------------------------------ admin

    /// <summary>Questions and answers in one queue: each row is a post with its context, most reported first.</summary>
    public async Task<JsonObject> AdminQueueAsync(UserModel admin, string status, string q, int page)
    {
        await access.RequireAsync(admin, "catalog");
        var like = q.Trim().Length > 0 ? $"%{q.Trim()}%" : null;
        var qwhere = "q.status = @status" + (like is null ? "" : " AND (q.text LIKE @like OR p.title LIKE @like)");
        var questions = await db.QueryAsync<dynamic>(
            $"SELECT q.id, q.text, q.report_count, q.created_at, p.title AS product, p.slug, u.name FROM product_questions q " +
            $"JOIN products p ON p.id = q.product_id LEFT JOIN users u ON u.id = q.user_id WHERE {qwhere} LIMIT 200",
            new { status, like });
        var awhere = "a.status = @status" + (like is null ? "" : " AND (a.text LIKE @like OR p.title LIKE @like)");
        var answers = await db.QueryAsync<dynamic>(
            $"SELECT a.id, a.text, a.role, a.report_count, a.created_at, q.text AS question, p.title AS product, p.slug, u.name FROM product_answers a " +
            $"JOIN product_questions q ON q.id = a.question_id JOIN products p ON p.id = q.product_id LEFT JOIN users u ON u.id = a.user_id WHERE {awhere} LIMIT 200",
            new { status, like });
        var rows = new List<JsonObject>();
        foreach (var x in questions)
        {
            rows.Add(new JsonObject
            {
                ["kind"] = "question", ["id"] = ((Guid)x.id).ToString(), ["text"] = (string)x.text, ["product"] = (string)x.product,
                ["slug"] = (string)x.slug, ["author"] = (string?)x.name ?? "Deleted account", ["role"] = "customer",
                ["report_count"] = (int)x.report_count, ["created_at"] = ((DateTime)x.created_at).ToString("yyyy-MM-ddTHH:mm:ss"), ["question"] = "",
            });
        }
        foreach (var a in answers)
        {
            rows.Add(new JsonObject
            {
                ["kind"] = "answer", ["id"] = ((Guid)a.id).ToString(), ["text"] = (string)a.text, ["product"] = (string)a.product,
                ["slug"] = (string)a.slug, ["author"] = (string?)a.name ?? "Deleted account", ["role"] = (string)a.role,
                ["report_count"] = (int)a.report_count, ["created_at"] = ((DateTime)a.created_at).ToString("yyyy-MM-ddTHH:mm:ss"),
                ["question"] = (string)a.question,
            });
        }
        rows = rows.OrderByDescending(r => r["report_count"]!.GetValue<int>()).ThenByDescending(r => r["created_at"]!.GetValue<string>()).ToList();
        var counts = new JsonObject();
        foreach (var st in new[] { "pending", "published", "hidden" })
        {
            counts[st] = await db.ExecuteScalarAsync<long>("SELECT (SELECT COUNT(*) FROM product_questions WHERE status = @st) + (SELECT COUNT(*) FROM product_answers WHERE status = @st)", new { st });
        }
        var start = (page - 1) * 30;
        var items = new JsonArray();
        foreach (var r in rows.Skip(start).Take(30))
        {
            items.Add(r);
        }
        return new JsonObject { ["items"] = items, ["total"] = rows.Count, ["page"] = page, ["page_size"] = 30, ["counts"] = counts };
    }

    public async Task<JsonObject> AdminActionAsync(UserModel admin, bool question, Guid postId, bool publish)
    {
        await access.RequireAsync(admin, "catalog");
        var status = publish ? "published" : "hidden";
        if (question)
        {
            var obj = await engagement.GetQuestionAsync(postId) ?? throw new NotFoundException("Post");
            await db.ExecuteAsync("UPDATE product_questions SET status = @status, report_count = 0 WHERE id = @postId", new { status, postId });
        }
        else
        {
            var obj = await engagement.GetAnswerAsync(postId) ?? throw new NotFoundException("Post");
            await db.ExecuteAsync("UPDATE product_answers SET status = @status, report_count = 0 WHERE id = @postId", new { status, postId });
            await RefreshCountAsync(obj.QuestionId);
        }
        await audit.AuditAsync(admin, $"qa.{(question ? "question" : "answer")}.{(publish ? "publish" : "hide")}", question ? "question" : "answer", postId);
        return new JsonObject { ["ok"] = true, ["status"] = status };
    }

    // ------------------------------------------------------------------ helpers

    private async Task<ProductModel> ProductAsync(string slug) =>
        await engagement.PublicProductBySlugAsync(slug) ?? throw new NotFoundException("Product");

    private async Task<SellerModel> SellerAsync(UserModel user)
    {
        var seller = await engagement.SellerByUserAsync(user.Id) ?? throw new ForbiddenException("Register as a seller first");
        if (seller.Status != "approved") throw new ForbiddenException("Your seller account is not approved yet");
        return seller;
    }

    /// <summary>Reference: _refresh_count — published answers on the question.</summary>
    private async Task RefreshCountAsync(Guid questionId, IUnitOfWork? uow = null)
    {
        const string countSql = "SELECT COUNT(*) FROM product_answers WHERE question_id = @questionId AND status = 'published'";
        const string updateSql = "UPDATE product_questions SET answer_count = @n WHERE id = @questionId";
        if (uow is not null)
        {
            var n = await uow.QueryFirstOrDefaultAsync<long>(countSql, new { questionId });
            await uow.ExecuteAsync(updateSql, new { n, questionId });
        }
        else
        {
            var n = await db.ExecuteScalarAsync<long>(countSql, new { questionId });
            await db.ExecuteAsync(updateSql, new { n, questionId });
        }
    }
}
