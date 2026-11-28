using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Model.DomainModel.Catalog;
using Utils;

namespace BAL;

/// <summary>
/// Questions and answers, alerts, compare and bought together (reference: routers/engagement.py and
/// services/engagement.py). Switches live in Admin → Product page; Admin → Questions moderates.
/// </summary>
public class EngagementBAL(
    EngagementDAL qa,
    CatalogDAL catalog,
    CatalogSupportDAL support,
    IPlatformSettingsBAL platform,
    ICatalogBAL cards,
    ICatalogNotifyBAL notify) : IEngagementBAL
{
    public static readonly IReadOnlyDictionary<string, string> RoleLabel = new Dictionary<string, string>
    {
        ["seller"] = "Seller", ["buyer"] = "Verified buyer", ["customer"] = "Customer", ["staff"] = "Store team",
    };

    private static string First(string? name) => (string.IsNullOrEmpty(name) ? "Customer" : name).Split(' ')[0];

    private async Task<ProductModel> ProductAsync(string slug) => await catalog.PublicProductBySlugAsync(slug) ?? throw new NotFoundException("Product");

    private static string Iso(DateTime t) => DateTimeFunctions.Iso(t);

    // ------------------------------------------------------------------------- shoppers

    public async Task<JsonObject> QuestionsAsync(string slug, UserModel? user, string q, string sort, int page)
    {
        var cfg = await platform.GetAsync();
        var p = await ProductAsync(slug);
        if (!cfg.Bool("feature_qa"))
            return new JsonObject { ["enabled"] = false, ["items"] = new JsonArray(), ["total"] = 0, ["page"] = page, ["has_more"] = false };
        var text = q.Trim();
        var size = cfg.Int("questions_page_size");
        var total = await qa.CountQuestionsAsync(p.Id, text);
        var rows = (await qa.QuestionsPageAsync(p.Id, text, sort, size, (page - 1) * size)).ToList();
        var answers = new Dictionary<Guid, List<QaRow>>();
        var voted = new HashSet<Guid>();
        if (rows.Count > 0)
        {
            foreach (var a in await qa.PublishedAnswersAsync(rows.Select(r => r.Id)))
            {
                if (!answers.TryGetValue(a.QuestionId!.Value, out var l)) answers[a.QuestionId.Value] = l = [];
                l.Add(a);
            }
            var ids = answers.Values.SelectMany(l => l.Select(a => a.Id)).ToList();
            if (user != null && ids.Count > 0) voted = await qa.VotedAnswersAsync(user.Id, ids);
        }
        var seller = await catalog.GetSellerAsync(p.SellerId);
        var items = new JsonArray();
        foreach (var qn in rows)
        {
            var list = (answers.GetValueOrDefault(qn.Id) ?? []).OrderBy(a => a.Role != "seller").ThenBy(a => -a.HelpfulCount).ThenBy(a => a.CreatedAt);
            items.Add(new JsonObject
            {
                ["id"] = qn.Id.ToString(), ["text"] = qn.Text, ["author"] = First(qn.AuthorName), ["created_at"] = Iso(qn.CreatedAt), ["answer_count"] = qn.AnswerCount,
                ["answers"] = CatalogBAL.Arr(list.Select(a => (JsonNode)new JsonObject
                {
                    ["id"] = a.Id.ToString(), ["text"] = a.Text, ["author"] = a.Role == "seller" ? seller?.DisplayName ?? "" : First(a.AuthorName),
                    ["role"] = a.Role, ["role_label"] = RoleLabel[a.Role], ["helpful_count"] = a.HelpfulCount, ["voted"] = voted.Contains(a.Id),
                    ["created_at"] = Iso(a.CreatedAt),
                })),
            });
        }
        return new JsonObject
        {
            ["enabled"] = true, ["items"] = items, ["total"] = total, ["page"] = page, ["has_more"] = (long)page * size < total,
            ["can_ask"] = user != null, ["buyers_answer_only"] = cfg.Bool("qa_buyers_answer_only"),
        };
    }

    public async Task<JsonObject> AskAsync(string slug, UserModel user, QuestionIn body)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_qa")) throw new AppException("Questions are switched off", "qa_off");
        var p = await ProductAsync(slug);
        await support.RateLimitAsync($"qa-ask:{user.Id}", 10, 86400);
        var text = PlatformSettingsBAL.Tidy(body.Text);
        var held = cfg.Bool("qa_need_approval") || ReviewBAL.Contact().IsMatch(text);
        var qn = new ProductQuestionModel
        {
            Id = Guid.NewGuid(), ProductId = p.Id, UserId = user.Id, Text = text, Status = held ? "pending" : "published", CreatedAt = DateTimeFunctions.UtcNow(),
        };
        await qa.InsertQuestionAsync(qn);
        if (!held)
            await notify.NotifySellerAsync(p.SellerId, "seller_new_question",
                new Dictionary<string, string> { ["item"] = p.Title, ["question"] = CatalogText.Cut(text, 200) }, "/seller/questions");
        return new JsonObject { ["ok"] = true, ["id"] = qn.Id.ToString(), ["status"] = qn.Status };
    }

    public async Task<JsonObject> AnswerAsync(Guid questionId, UserModel user, AnswerIn body)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_qa")) throw new AppException("Questions are switched off", "qa_off");
        var qn = await qa.GetQuestionAsync(questionId);
        if (qn is null || qn.Status != "published") throw new NotFoundException("Question");
        var p = await catalog.GetProductAsync(qn.ProductId) ?? throw new NotFoundException("Question");
        var seller = await catalog.GetSellerAsync(p.SellerId);
        var role = seller != null && seller.UserId == user.Id ? "seller" : await qa.IsBuyerAsync(user.Id, p.Id) ? "buyer" : "customer";
        if (role == "customer" && cfg.Bool("qa_buyers_answer_only"))
            throw new AppException("Only the seller and customers who bought this product can answer", "buyers_only");
        if (qn.UserId == user.Id && role != "seller")
            throw new AppException("You asked this question; wait for an answer from the seller or a buyer", "own_question");
        await support.RateLimitAsync($"qa-answer:{user.Id}", 30, 86400);
        var text = body.Text.Trim();
        var held = cfg.Bool("qa_need_approval") || ReviewBAL.Contact().IsMatch(text);
        var a = new ProductAnswerModel
        {
            Id = Guid.NewGuid(), QuestionId = qn.Id, UserId = user.Id, Role = role, Text = text, Status = held ? "pending" : "published",
            CreatedAt = DateTimeFunctions.UtcNow(),
        };
        await qa.InsertAnswerAsync(a);
        if (!held)
        {
            await qa.RefreshAnswerCountAsync(qn.Id);
            if (qn.UserId is { } asker && asker != user.Id)
                await notify.NotifyUserAsync(asker, "question_answered", new Dictionary<string, string>
                {
                    ["item"] = p.Title, ["question"] = CatalogText.Cut(qn.Text, 200), ["answer"] = CatalogText.Cut(text, 300),
                    ["answerer"] = role != "seller" ? RoleLabel[role] : seller!.DisplayName,
                }, $"/p/{p.Slug}#questions");
        }
        return new JsonObject { ["ok"] = true, ["id"] = a.Id.ToString(), ["status"] = a.Status, ["role"] = role };
    }

    public async Task<JsonObject> AnswerHelpfulAsync(Guid answerId, UserModel user)
    {
        var a = await qa.GetAnswerAsync(answerId);
        if (a is null || a.Status != "published") throw new NotFoundException("Answer");
        if (a.UserId == user.Id) throw new AppException("You cannot vote on your own answer", "own_answer");
        var (voted, count) = await qa.ToggleAnswerVoteAsync(answerId, user.Id);
        return new JsonObject { ["voted"] = voted, ["helpful_count"] = count };
    }

    /// <summary>
    /// Flags a question or answer. Each person counts once; reports from enough different people (Admin → Product
    /// page) take it off the product page until staff check it. report_count counts reporters since that check.
    /// </summary>
    public async Task<JsonObject> ReportPostAsync(UserModel user, QaReportIn body)
    {
        await support.RateLimitAsync($"qa-report:{user.Id}", 30, 86400);
        var hideAt = (await platform.GetAsync()).Int("qa_report_hide_at");
        var r = await qa.ReportPostAsync(body.Kind == "question", body.Id!.Value, user.Id, hideAt) ?? throw new NotFoundException("Post");
        return new JsonObject { ["ok"] = true, ["already"] = r.Already, ["hidden"] = r.Hidden };
    }

    // ------------------------------------------------------------------------- alerts

    public async Task<JsonObject> SubscribeStockAlertAsync(UserModel user, Guid variantId)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_stock_alerts")) throw new AppException("Stock alerts are switched off", "alerts_off");
        var v = await catalog.GetVariantAsync(variantId);
        if (v is null || !v.IsActive) throw new NotFoundException("Product");
        var a = await qa.GetStockAlertAsync(user.Id, v.Id);
        if (a is null)
        {
            if (await qa.ActiveStockAlertCountAsync(user.Id) >= 100) throw new AppException("You can follow up to 100 items", "too_many_alerts");
            await qa.InsertStockAlertAsync(user.Id, v.Id);
        }
        else await qa.ReactivateStockAlertAsync(user.Id, v.Id);
        return new JsonObject { ["ok"] = true, ["subscribed"] = true };
    }

    public async Task<JsonObject> UnsubscribeStockAlertAsync(UserModel user, Guid variantId)
    {
        await qa.DeleteStockAlertAsync(user.Id, variantId);
        return new JsonObject { ["ok"] = true, ["subscribed"] = false };
    }

    public async Task<JsonObject> MyAlertsAsync(UserModel user, Guid? variantId)
    {
        var rows = (await qa.MyStockAlertsAsync(user.Id, variantId)).ToList();
        var imgs = await catalog.ImagesForAsync(rows.Select(r => r.ProductId));
        return new JsonObject
        {
            ["stock"] = CatalogBAL.Arr(rows.Select(r => (JsonNode)new JsonObject
            {
                ["variant_id"] = r.VariantId.ToString(), ["product"] = r.Title, ["slug"] = r.Slug, ["variant"] = ProductInfo.VariantLabel(r.Options),
                ["image"] = imgs.GetValueOrDefault(r.ProductId)?.FirstOrDefault() ?? "", ["in_stock"] = r.Stock > 0, ["created_at"] = Iso(r.CreatedAt),
            })),
        };
    }

    // ------------------------------------------------------------------------- compare and bought together

    public async Task<JsonObject> CompareAsync(string ids)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_compare")) throw new AppException("Compare is switched off", "compare_off");
        var want = new List<Guid>();
        foreach (var x in ids.Split(',').Take(cfg.Int("compare_max")))
            if (Guid.TryParse(x.Trim(), out var g)) want.Add(g);
        var products = await cards.PublicProductsAsync(want);
        var cardList = await cards.ProductCardsAsync(products);
        var specCount = new Dictionary<string, int>();
        foreach (var p in products)
            foreach (var (k, _) in JsonHelper.Node(p.Specs) as JsonObject ?? [])
                specCount[k] = specCount.GetValueOrDefault(k) + 1;
        var keys = specCount.Keys.OrderBy(k => -specCount[k]).ThenBy(k => k, StringComparer.Ordinal).ToList();
        var items = new JsonArray();
        var infoKeys = new List<string>();
        for (var i = 0; i < products.Count; i++)
        {
            var p = products[i];
            var info = new JsonObject();
            foreach (var row in ProductInfo.InfoRows(ProductInfo.DetailsOf(p.Details), p.Brand, p.CountryOfOrigin).OfType<JsonObject>())
                info[CatalogText.Str(row["label"])] = row["value"]?.DeepClone();
            foreach (var (k, _) in info)
                if (!infoKeys.Contains(k)) infoKeys.Add(k);
            var card = cardList[i];
            card["specs"] = JsonHelper.Node(p.Specs);
            card["info"] = info;
            card["return_window_days"] = p.ReturnWindowDays;
            card["highlights"] = new JsonArray((JsonHelper.Node(p.Highlights) as JsonArray ?? []).Take(5).Select(h => h?.DeepClone()).ToArray());
            items.Add(card);
        }
        return new JsonObject
        {
            ["items"] = items,
            ["spec_keys"] = new JsonArray(keys.Select(k => (JsonNode)k).ToArray()),
            ["info_keys"] = new JsonArray(infoKeys.Select(k => (JsonNode)k).ToArray()),
        };
    }

    public async Task<JsonObject> BoughtTogetherAsync(string slug)
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_bought_together")) return new JsonObject { ["items"] = new JsonArray() };
        var p = await ProductAsync(slug);
        var others = (await catalog.BoughtTogetherAsync(p.Id, DateTimeFunctions.UtcNow().AddDays(-180), 3)).ToList();
        if (others.Count == 0) return new JsonObject { ["items"] = new JsonArray() };
        return new JsonObject { ["items"] = CatalogBAL.Arr(await cards.ProductCardsAsync([p, .. others])) }; // the product itself first
    }

    /// <summary>Bundle offers that include this product, for the "Buy the set" block: the set, its price and the saving.</summary>
    public async Task<JsonObject> BundlesAsync(string slug)
    {
        var p = await ProductAsync(slug);
        var outp = new JsonArray();
        foreach (var c in await catalog.BundleCouponsForProductAsync(p.Id, DateTimeFunctions.UtcNow()))
        {
            var ids = JsonHelper.Array(c.ProductIds).Select(x => Guid.Parse(x!.GetValue<string>())).ToList();
            var found = (await catalog.PublicProductsByIdsAsync(ids, inStockOnly: true)).ToDictionary(x => x.Id);
            if (found.Count != ids.Count) continue;   // a member is gone or sold out: the set cannot be bought
            var items = await cards.ProductCardsAsync(ids.Select(i => found[i]).ToList());
            var total = items.Sum(i => (long)i["price"]!.GetValue<long>());
            var saving = Money.ApplyBps(total, c.Value * 100);
            if (c.MaxDiscountPaise is > 0) saving = Math.Min(saving, c.MaxDiscountPaise.Value);
            outp.Add(new JsonObject
            {
                ["code"] = c.Code, ["automatic"] = c.IsAutomatic, ["percent"] = c.Value, ["items"] = CatalogBAL.Arr(items),
                ["total"] = total, ["saving"] = saving, ["set_price"] = total - saving,
            });
        }
        return new JsonObject { ["bundles"] = outp };
    }

    // ------------------------------------------------------------------------- seller

    public async Task<JsonObject> SellerQuestionsAsync(SellerModel seller, bool unanswered, int page)
    {
        var total = await qa.SellerQuestionCountAsync(seller.Id, unanswered);
        var rows = (await qa.SellerQuestionsAsync(seller.Id, unanswered, 20, (page - 1) * 20)).ToList();
        var answers = new Dictionary<Guid, JsonArray>();
        if (rows.Count > 0)
        {
            foreach (var a in await qa.VisibleAnswersAsync(rows.Select(r => r.Id)))
            {
                if (!answers.TryGetValue(a.QuestionId, out var l)) answers[a.QuestionId] = l = [];
                l.Add(new JsonObject
                {
                    ["id"] = a.Id.ToString(), ["text"] = a.Text, ["role"] = a.Role, ["role_label"] = RoleLabel[a.Role], ["status"] = a.Status,
                    ["created_at"] = Iso(a.CreatedAt),
                });
            }
        }
        var waiting = await qa.SellerQuestionCountAsync(seller.Id, unanswered: true);
        return new JsonObject
        {
            ["items"] = CatalogBAL.Arr(rows.Select(q =>
            {
                var list = answers.GetValueOrDefault(q.Id) ?? [];
                var byYou = list.Any(a => CatalogText.Str(a!["role"]) == "seller");
                return (JsonNode)new JsonObject
                {
                    ["id"] = q.Id.ToString(), ["text"] = q.Text, ["product"] = q.ProductTitle, ["slug"] = q.ProductSlug, ["created_at"] = Iso(q.CreatedAt),
                    ["answers"] = list, ["answered_by_you"] = byYou,
                };
            })),
            ["total"] = total, ["page"] = page, ["unanswered"] = waiting,
        };
    }

    public async Task<JsonObject> SellerBadgesAsync(SellerModel seller)
    {
        var (orders, reports, deals) = await qa.SellerBadgeCountsAsync(seller.Id);
        var questions = await qa.SellerQuestionCountAsync(seller.Id, unanswered: true);
        return new JsonObject { ["orders"] = orders, ["questions"] = questions, ["reports"] = reports, ["deals_running"] = deals };
    }

    public async Task<JsonObject> SellerAnswerAsync(Guid questionId, SellerModel seller, UserModel user, AnswerIn body)
    {
        var qn = await qa.GetQuestionAsync(questionId);
        var p = qn != null ? await catalog.GetProductAsync(qn.ProductId) : null;
        if (qn is null || p is null || p.SellerId != seller.Id) throw new NotFoundException("Question");
        return await AnswerAsync(questionId, user, body);
    }

    // ------------------------------------------------------------------------- staff

    /// <summary>Questions and answers in one queue, most reported first, then newest; 30 per page.</summary>
    public async Task<JsonObject> AdminQuestionsAsync(string status, string q, int page)
    {
        var text = q.Trim();
        var rows = new List<(int Reports, DateTime At, JsonObject Row)>();
        foreach (var x in await qa.AdminQuestionsAsync(status, text))
            rows.Add((x.ReportCount, x.CreatedAt, new JsonObject
            {
                ["kind"] = "question", ["id"] = x.Id.ToString(), ["text"] = x.Text, ["product"] = x.ProductTitle, ["slug"] = x.ProductSlug,
                ["author"] = x.AuthorName ?? "Deleted account", ["role"] = "customer", ["report_count"] = x.ReportCount, ["created_at"] = Iso(x.CreatedAt), ["question"] = "",
            }));
        foreach (var a in await qa.AdminAnswersAsync(status, text))
            rows.Add((a.ReportCount, a.CreatedAt, new JsonObject
            {
                ["kind"] = "answer", ["id"] = a.Id.ToString(), ["text"] = a.Text, ["product"] = a.ProductTitle, ["slug"] = a.ProductSlug,
                ["author"] = a.AuthorName ?? "Deleted account", ["role"] = a.Role, ["report_count"] = a.ReportCount, ["created_at"] = Iso(a.CreatedAt),
                ["question"] = a.QuestionText,
            }));
        var sorted = rows.OrderByDescending(r => r.Reports).ThenByDescending(r => r.At).Select(r => r.Row).ToList();
        var counts = new JsonObject();
        foreach (var st in new[] { "pending", "published", "hidden" }) counts[st] = await qa.CountPostsAsync(st);
        var start = (page - 1) * 30;
        return new JsonObject
        {
            ["items"] = CatalogBAL.Arr(sorted.Skip(start).Take(30)), ["total"] = sorted.Count, ["page"] = page, ["page_size"] = 30, ["counts"] = counts,
        };
    }

    public async Task<JsonObject> AdminQuestionActionAsync(UserModel admin, string kind, Guid postId, string action)
    {
        var question = kind == "question";
        Guid? parent = null;
        if (question)
        {
            if (await qa.GetQuestionAsync(postId) is null) throw new NotFoundException("Post");
        }
        else
        {
            var a = await qa.GetAnswerAsync(postId) ?? throw new NotFoundException("Post");
            parent = a.QuestionId;
        }
        var status = action == "publish" ? "published" : "hidden";
        await qa.SetPostStatusAsync(question, postId, status);
        if (parent is { } qid) await qa.RefreshAnswerCountAsync(qid);
        await support.AuditAsync(admin.Id, $"qa.{kind}.{action}", kind, postId.ToString());
        return new JsonObject { ["ok"] = true, ["status"] = status };
    }

    // ------------------------------------------------------------------------- jobs

    public async Task<int> SendStockAlertsAsync()
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_stock_alerts")) return 0;
        var rows = (await qa.DueStockAlertsAsync()).ToList();
        var now = DateTimeFunctions.UtcNow();
        foreach (var r in rows)
        {
            var label = ProductInfo.VariantLabel(r.Options);
            await notify.NotifyUserAsync(r.UserId, "back_in_stock", new Dictionary<string, string>
            {
                ["item"] = r.Title + (label.Length > 0 ? $" ({label})" : ""), ["price"] = CatalogBAL.Rupees(r.PricePaise),
            }, $"/p/{r.Slug}");
            await qa.MarkStockAlertSentAsync(r.UserId, r.VariantId, now);
        }
        return rows.Count;
    }

    public async Task<int> SendPriceDropsAsync()
    {
        var cfg = await platform.GetAsync();
        if (!cfg.Bool("feature_price_alerts")) return 0;
        var rows = (await qa.DuePriceDropsAsync(cfg.Int("price_alert_min_drop_pct"))).ToList();
        foreach (var r in rows)
        {
            await notify.NotifyUserAsync(r.UserId, "price_drop", new Dictionary<string, string>
            {
                ["item"] = r.Title, ["price"] = CatalogBAL.Rupees(r.PriceFrom), ["old_price"] = CatalogBAL.Rupees(r.PriceAtAdd),
            }, $"/p/{r.Slug}");
            await qa.MarkPriceAlertedAsync(r.UserId, r.ProductId, r.PriceFrom);
        }
        return rows.Count;
    }

    public Task WishlistPriceOnAddAsync(Guid userId, Guid productId) => qa.RememberWishlistPriceAsync(userId, productId);
}
