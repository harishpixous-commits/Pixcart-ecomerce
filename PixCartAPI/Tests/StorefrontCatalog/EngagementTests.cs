using BAL.Interface;
using Utils;

namespace Tests.StorefrontCatalog;

/// <summary>Reference: tests/test_engagement.py (questions and answers, reports, back-in-stock and price-drop alerts, compare, bought together).</summary>
public class EngagementTests(CatalogFactory factory) : CatalogTestBase(factory)
{
    private Task<List<string>> InboxAsync(Guid userId) =>
        Seed.QueryAsync<string>("SELECT subject FROM notifications WHERE user_id = @userId AND channel = 'inapp'", new { userId });

    [Fact]
    public async Task Questions_and_answers()
    {
        var (tn, ka, shirt, _, _) = await SetupAsync();
        var slug = shirt.Slug;
        Assert.Empty((await Visitor.Get($"/api/catalog/products/{slug}/questions"))["items"].AsArray());
        Assert.Equal(401, (await Visitor.Post($"/api/catalog/products/{slug}/questions", new { text = "Is this pure cotton?" })).Status);
        var asker = await User("9600000081", "Meena Asker");
        Assert.Equal(422, (await asker.Post($"/api/catalog/products/{slug}/questions", new { text = "Short?" })).Status);
        var r = await asker.Post($"/api/catalog/products/{slug}/questions", new { text = "Is this shirt pure cotton or a blend?" });
        Assert.Equal(201, r.Status);
        Assert.Equal("published", r["status"].GetValue<string>());
        var qid = r["id"].GetValue<string>();
        var held = await asker.Post($"/api/catalog/products/{slug}/questions", new { text = "Call me on 9876543210 about bulk price" });
        Assert.Equal("pending", held["status"].GetValue<string>());
        Assert.Contains("New customer question", await InboxAsync(tn.Owner.UserId));

        // a shopper who did not buy answers; a verified buyer answers; the seller answers
        var other = await User("9600000082", "Ravi Other");
        Assert.Equal("customer", (await other.Post($"/api/questions/{qid}/answers", new { text = "I think it is cotton" }))["role"].GetValue<string>());
        var buyer = await User("9600000083", "Kumar Buyer");
        await Seed.OrderAsync(buyer.UserId, "delivered", (shirt, 0, 1));
        Assert.Equal("buyer", (await buyer.Post($"/api/questions/{qid}/answers", new { text = "Yes, 100% cotton. Very soft." }))["role"].GetValue<string>());
        var sq = (await tn.Owner.Get("/api/seller/questions?unanswered=true")).Body!;
        Assert.Equal(1, sq["unanswered"]!.GetValue<long>());
        Assert.Equal(qid, sq["items"]![0]!["id"]!.GetValue<string>());
        Assert.Equal(1, (await tn.Owner.Get("/api/seller/badges"))["questions"].GetValue<long>());
        var sa = await tn.Owner.Post($"/api/seller/questions/{qid}/answer", new { text = "Pure handloom cotton, pre-washed." });
        Assert.Equal(201, sa.Status);
        Assert.Equal("seller", sa["role"].GetValue<string>());
        Assert.Equal(0, (await tn.Owner.Get("/api/seller/badges"))["questions"].GetValue<long>());
        Assert.Equal(404, (await ka.Owner.Post($"/api/seller/questions/{qid}/answer", new { text = "Not my product" })).Status);
        Assert.Equal("own_question", (await asker.Post($"/api/questions/{qid}/answers", new { text = "Answering myself" })).ErrorCode);
        Assert.Equal(403, (await asker.Get("/api/seller/questions")).Status);

        var data = (await Visitor.Get($"/api/catalog/products/{slug}/questions")).Body!;
        var q0 = data["items"]![0]!;
        Assert.Equal(3, q0["answer_count"]!.GetValue<int>());
        Assert.Equal("seller", q0["answers"]![0]!["role"]!.GetValue<string>());
        Assert.Equal("Kovai Textiles", q0["answers"]![0]!["author"]!.GetValue<string>());
        var labels = q0["answers"]!.AsArray().Skip(1).Select(a => a!["role_label"]!.GetValue<string>()).ToHashSet();
        Assert.Equal(new HashSet<string> { "Verified buyer", "Customer" }, labels);
        Assert.Equal(1, (await Visitor.Get($"/api/catalog/products/{slug}/questions?q=pre-washed"))["total"].GetValue<long>());
        Assert.Contains("Your question was answered", await InboxAsync(asker.UserId));

        // helpful votes toggle; not on your own answer
        var aid = q0["answers"]![1]!["id"]!.GetValue<string>();
        var voter = await User("9600000084", "Voter");
        var v1 = await voter.Post($"/api/answers/{aid}/helpful");
        Assert.True(v1["voted"].GetValue<bool>());
        Assert.Equal(1, v1["helpful_count"].GetValue<int>());
        Assert.Equal(0, (await voter.Post($"/api/answers/{aid}/helpful"))["helpful_count"].GetValue<int>());
        var sellerAnswer = q0["answers"]![0]!["id"]!.GetValue<string>();
        Assert.Equal("own_answer", (await tn.Owner.Post($"/api/answers/{sellerAnswer}/helpful")).ErrorCode);

        // moderation: the held question waits; reports hide a post; staff publish or hide
        var admin = await Admin();
        var queue = (await admin.Get("/api/admin/questions")).Body!;
        Assert.Equal(1, queue["counts"]!["pending"]!.GetValue<long>());
        Assert.Equal("question", queue["items"]![0]!["kind"]!.GetValue<string>());
        Assert.Equal(403, (await asker.Get("/api/admin/questions")).Status);
        Assert.Equal("published", (await admin.Post($"/api/admin/questions/question/{held["id"]}/publish"))["status"].GetValue<string>());
        foreach (var ph in new[] { "9600000085", "9600000086", "9600000087" })
            await (await User(ph, "Reporter")).Post("/api/qa/report", new { kind = "answer", id = aid });
        Assert.Equal(2, (await Visitor.Get($"/api/catalog/products/{slug}/questions?q=shirt pure"))["items"][0]!["answer_count"]!.GetValue<int>());
        Assert.Equal("hidden", (await admin.Post($"/api/admin/questions/answer/{aid}/hide"))["status"].GetValue<string>());
        Assert.Equal(422, (await admin.Post($"/api/admin/questions/answer/{aid}/delete")).Status);
        Assert.Equal(1, await Scalar<long>("SELECT COUNT(*) FROM audit_logs WHERE action = 'qa.answer.hide'"));

        // only the seller and buyers may answer when the store says so; switching Q&A off
        await SetSettings(new { qa_buyers_answer_only = true });
        Assert.Equal("buyers_only", (await other.Post($"/api/questions/{qid}/answers", new { text = "Another guess" })).ErrorCode);
        await SetSettings(new { feature_qa = false });
        Assert.False((await Visitor.Get($"/api/catalog/products/{slug}/questions"))["enabled"].GetValue<bool>());
        Assert.Equal("qa_off", (await asker.Post($"/api/catalog/products/{slug}/questions", new { text = "Is there a bigger size available?" })).ErrorCode);
    }

    [Fact]
    public async Task Qa_reports_count_each_person_once()
    {
        var (_, _, shirt, _, _) = await SetupAsync();
        var slug = shirt.Slug;
        var asker = await User("9600000091", "Meena Asker");
        var qid = (await asker.Post($"/api/catalog/products/{slug}/questions", new { text = "Does the colour fade after washing?" }))["id"].GetValue<string>();

        async Task<bool> Visible() =>
            (await Visitor.Get($"/api/catalog/products/{slug}/questions"))["items"].AsArray().Any(q => q!["id"]!.GetValue<string>() == qid);
        async Task<Res> Report(Api api) => await api.Post("/api/qa/report", new { kind = "question", id = qid });

        var rival = await User("9600000092", "Rival");
        var first = await Report(rival);
        Assert.False(first["already"].GetValue<bool>());
        Assert.False(first["hidden"].GetValue<bool>());
        for (var i = 0; i < 4; i++) Assert.True((await Report(rival))["already"].GetValue<bool>());
        Assert.True(await Visible());
        var second = await User("9600000093", "Shopper");
        var third = await User("9600000094", "Shopper");
        Assert.False((await Report(second))["hidden"].GetValue<bool>());
        Assert.True((await Report(third))["hidden"].GetValue<bool>()); // three different people by default
        Assert.False(await Visible());

        // staff put it back: earlier reporters cannot hide it again; the owner's number applies to new reporters
        var admin = await Admin();
        Assert.Equal("published", (await admin.Post($"/api/admin/questions/question/{qid}/publish"))["status"].GetValue<string>());
        var e = await Assert.ThrowsAsync<AppException>(() => SetSettings(new { qa_report_hide_at = 51 }));
        Assert.Equal("invalid_setting", e.Code);
        Assert.Equal(400, e.StatusCode);
        Assert.Equal(2, (await SetSettings(new { qa_report_hide_at = 2 })).Int("qa_report_hide_at"));
        foreach (var api in new[] { rival, second, third }) Assert.True((await Report(api))["already"].GetValue<bool>());
        Assert.True(await Visible());
        var fourth = await User("9600000095", "Shopper");
        var fifth = await User("9600000096", "Shopper");
        Assert.False((await Report(fourth))["hidden"].GetValue<bool>());
        Assert.True((await Report(fifth))["hidden"].GetValue<bool>());
        Assert.False(await Visible());

        // 0 = reports never hide a post by themselves
        await admin.Post($"/api/admin/questions/question/{qid}/publish");
        await SetSettings(new { qa_report_hide_at = 0 });
        foreach (var n in new[] { "97", "98" })
            Assert.False((await Report(await User($"96000000{n}", "Shopper")))["hidden"].GetValue<bool>());
        Assert.True(await Visible());
        var queue = (await admin.Get("/api/admin/questions?status=published"))["items"].AsArray();
        Assert.Equal(2, queue.First(i => i!["id"]!.GetValue<string>() == qid)!["report_count"]!.GetValue<int>()); // reports since staff last checked it
        Assert.Equal(404, (await asker.Post("/api/qa/report", new { kind = "question", id = Guid.NewGuid() })).Status);
        Assert.Equal(422, (await asker.Post("/api/qa/report", new { kind = "review", id = qid })).Status);
    }

    [Fact]
    public async Task Back_in_stock_and_price_drop_alerts()
    {
        var (_, _, shirt, _, _) = await SetupAsync();
        var vid = shirt.VariantIds[0];
        var shopper = await User("9600000091", "Alert Shopper");
        // price drop: saved at ₹1,000 (the wishlist module adds the row, then remembers the price through IEngagementBAL)
        await Sql("INSERT INTO wishlist_items (user_id, product_id, created_at) VALUES (@u, @p, UTC_TIMESTAMP(6))", new { u = shopper.UserId, p = shirt.Id });
        await With<IEngagementBAL, bool>(async e => { await e.WishlistPriceOnAddAsync(shopper.UserId, shirt.Id); return true; });
        Assert.Equal(100000, await Scalar<long>("SELECT price_at_add FROM wishlist_items"));
        // back in stock: the seller sells out, the shopper asks to be told
        await Sql("UPDATE variants SET stock = 0 WHERE id = @vid", new { vid });
        var sub = await shopper.Post("/api/alerts/stock", new { variant_id = vid });
        Assert.Equal(201, sub.Status);
        Assert.True(sub["subscribed"].GetValue<bool>());
        Assert.False((await shopper.Get($"/api/alerts?variant_id={vid}"))["stock"][0]!["in_stock"]!.GetValue<bool>());
        Assert.Equal(0, await With<IEngagementBAL, int>(e => e.SendStockAlertsAsync())); // still out of stock
        await Sql("UPDATE variants SET stock = 5, price_paise = 85000 WHERE id = @vid", new { vid });
        await With<ICatalogBAL, bool>(async c => { await c.RefreshProductAggregatesAsync(shirt.Id); return true; });
        Assert.Equal(1, await With<IEngagementBAL, int>(e => e.SendStockAlertsAsync()));
        Assert.Equal(0, await With<IEngagementBAL, int>(e => e.SendStockAlertsAsync())); // once
        Assert.Equal(1, await With<IEngagementBAL, int>(e => e.SendPriceDropsAsync()));
        Assert.Equal(0, await With<IEngagementBAL, int>(e => e.SendPriceDropsAsync())); // not again at the same price
        Assert.False(await Scalar<bool>("SELECT active FROM stock_alerts"));
        Assert.NotNull(await Scalar<DateTime?>("SELECT notified_at FROM stock_alerts"));
        var events = await Seed.QueryAsync<string>("SELECT event FROM notifications WHERE channel = 'inapp'");
        Assert.Contains("back_in_stock", events);
        Assert.Contains("price_drop", events);
        Assert.Contains("Price dropped", await Seed.QueryAsync<string>("SELECT subject FROM notifications"));
        Assert.Empty((await shopper.Get("/api/alerts"))["stock"].AsArray());
        Assert.Equal(201, (await shopper.Post("/api/alerts/stock", new { variant_id = vid })).Status);
        Assert.False((await shopper.Delete($"/api/alerts/stock/{vid}"))["subscribed"].GetValue<bool>());
        Assert.Equal(401, (await Visitor.Post("/api/alerts/stock", new { variant_id = vid })).Status);
        await SetSettings(new { feature_stock_alerts = false });
        Assert.Equal("alerts_off", (await shopper.Post("/api/alerts/stock", new { variant_id = vid })).ErrorCode);
    }

    [Fact]
    public async Task Compare_and_bought_together()
    {
        var (_, _, shirt, phone, _) = await SetupAsync();
        var c = (await Visitor.Get($"/api/catalog/compare?ids={shirt.Id},{phone.Id},not-an-id")).Body!;
        Assert.Equal([shirt.Slug, phone.Slug], c["items"]!.AsArray().Select(x => x!["slug"]!.GetValue<string>()));
        Assert.Contains("Brand", c["info_keys"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal("Material", c["spec_keys"]![0]!.GetValue<string>());
        Assert.Empty((await Visitor.Get($"/api/catalog/products/{shirt.Slug}/bought-together"))["items"].AsArray());
        var buyer = await User("9600000095", "Basket Buyer");
        await Seed.OrderAsync(buyer.UserId, "placed", (shirt, 0, 1), (phone, 0, 1));
        var fbt = (await Visitor.Get($"/api/catalog/products/{shirt.Slug}/bought-together"))["items"].AsArray();
        Assert.Equal([shirt.Slug, phone.Slug], fbt.Select(x => x!["slug"]!.GetValue<string>()));
        await SetSettings(new { feature_bought_together = false, feature_compare = false });
        Assert.Empty((await Visitor.Get($"/api/catalog/products/{shirt.Slug}/bought-together"))["items"].AsArray());
        Assert.Equal("compare_off", (await Visitor.Get($"/api/catalog/compare?ids={shirt.Id}")).ErrorCode);
    }
}
