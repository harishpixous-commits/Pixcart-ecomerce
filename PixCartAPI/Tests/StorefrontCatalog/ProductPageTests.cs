using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using Model.DomainModel.Catalog;
using SkiaSharp;
using Utils;

namespace Tests.StorefrontCatalog;

/// <summary>
/// Reference: tests/test_product_page.py — product information and unit price, social proof, offers, seller snapshot,
/// delivery cut-off, reviews with photos, helpful votes, reports and "report an issue with this product".
/// </summary>
public class ProductPageTests(CatalogFactory factory) : CatalogTestBase(factory)
{
    public static byte[] Png(int w = 400, int h = 400)
    {
        using var bmp = new SKBitmap(w, h);
        bmp.Erase(new SKColor(200, 30, 30));
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    [Fact]
    public void Unit_price_and_counts()
    {
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"paise": 42000, "per": "100 g"}"""), ProductInfo.UnitPrice(21000, 50, "g")));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"paise": 25000, "per": "kg"}"""), ProductInfo.UnitPrice(50000, 2000, "g")));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"paise": 1900, "per": "piece"}"""), ProductInfo.UnitPrice(171000, 90, "pcs")));
        Assert.Null(ProductInfo.UnitPrice(10000, 0, "g"));
        Assert.Null(ProductInfo.UnitPrice(10000, 5, ""));
        Assert.Equal(["7", "40+", "300+", "2K+"], new long[] { 7, 42, 340, 2400 }.Select(CatalogBAL.Bucket));
        var texts = new List<(int, string)> { (5, "Great quality, worth the money"), (4, "Good quality"), (1, "Poor quality and leaked"), (5, "fast delivery") };
        var q = ReviewBAL.TopicStats(texts, ReviewSettingsBAL.DefaultTopics()).First(t => t!["name"]!.GetValue<string>() == "Quality")!;
        Assert.Equal(3, q["count"]!.GetValue<int>());
        Assert.Equal(2, q["positive"]!.GetValue<int>());
        Assert.Equal(1, q["negative"]!.GetValue<int>());
        Assert.Equal("250 g", ProductInfo.FmtQty(250.000m, "g"));
        Assert.Equal("10% off up to ₹150", CatalogBAL.OfferText(new Model.DomainModel.CouponModel { Kind = "percent", Value = 1000, MaxDiscountPaise = 15000 }).Title);
    }

    [Fact]
    public void Dispatch_cutoff_countdown()
    {
        var morning = new DateTime(2026, 11, 18, 10, 0, 0); // a Wednesday, India time
        var cfg = new JsonObject { ["transit_days_same_city"] = 1, ["transit_days_same_state"] = 3, ["transit_days_national"] = 6 };
        var before = DeliveryEstimate.Estimate(cfg, 1, "600001", "33", "600028", morning, "14:00");
        var after = DeliveryEstimate.Estimate(cfg, 1, "600001", "33", "600028", morning.AddHours(5), "14:00");
        var none = DeliveryEstimate.Estimate(cfg, 1, "600001", "33", "600028", morning);
        Assert.Equal(240, before.Int("order_within_min"));
        Assert.Null(after["order_within_min"]);
        Assert.True(string.CompareOrdinal(after.Str("min_date"), before.Str("min_date")) > 0);
        Assert.Equal(none.Str("min_date"), before.Str("min_date"));
        Assert.Equal("33", DeliveryEstimate.StateForPin("641001"));
        Assert.Equal("state", DeliveryEstimate.Zone("600001", "641001", "33"));
        Assert.Equal("national", DeliveryEstimate.Zone("600001", "560001", "33"));
    }

    [Fact]
    public async Task Product_information_unit_price_and_category_requirements()
    {
        var cats = await Seed.CategoriesAsync();
        var tn = await Seed.SellerAsync("9400000001", "Kovai Textiles");
        await Sql("UPDATE categories SET required_details = CAST('[\"net_quantity\", \"manufacturer\", \"customer_care\"]' AS JSON) WHERE id = @id", new { id = cats["shirts"] });
        await Sql("UPDATE categories SET required_details = CAST('[\"generic_name\"]' AS JSON) WHERE id = @id", new { id = cats["fashion"] });
        var tree = (await Visitor.Get("/api/catalog/categories")).Body!.AsArray();
        var shirts = tree.First(c => c!["slug"]!.GetValue<string>() == "fashion")!["children"]![0]!;
        Assert.Equal(["generic_name", "net_quantity", "manufacturer", "customer_care"], shirts["required_details"]!.AsArray().Select(x => x!.GetValue<string>()));

        var details = new
        {
            net_unit = "g", generic_name = "Shirt", manufacturer = "Kovai Textiles, 12 Mill Road, Coimbatore 641001",
            customer_care = "care@kovai.example, 0422 1234567", in_the_box = new[] { "1 shirt" }, key_specs = new[] { "Fabric" }, ingredients = "", warranty = "No warranty",
        };
        var p = await Seed.ProductAsync(tn, cats["shirts"], "Handloom Cotton Shirt Blue", [new("HL-1", 200000, 90000, 10, NetQty: 250)],
            specs: new Dictionary<string, string> { ["Fabric"] = "Cotton", ["Fit"] = "Slim" }, details: details);
        var page = (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Body!;
        var v = page["variants"]![0]!;
        Assert.Equal("250 g", v["net_quantity"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"paise": 36000, "per": "100 g"}"""), v["unit_price"]));
        var labels = page["info"]!.AsArray().ToDictionary(r => r!["label"]!.GetValue<string>(), r => r!["value"]!.GetValue<string>());
        Assert.StartsWith("Kovai Textiles", labels["Manufacturer"]);
        Assert.Equal("1 shirt", labels["In the box"]);
        Assert.Equal("No warranty", labels["Warranty"]);
        Assert.Equal(["Brand", "Fabric"], page["key_specs"]!.AsArray().Select(k => k!["label"]!.GetValue<string>()));
        Assert.Empty(page["important"]!.AsArray());
        // the card shows the unit price of the cheapest version too
        Assert.Equal(36000, (await Visitor.Get("/api/catalog/products?q=handloom"))["items"][0]!["unit_price"]!["paise"]!.GetValue<long>());
        // a bad stored value never breaks the page (it reads as no details)
        await Sql("UPDATE products SET details = CAST('{\"fssai_license\": \"123\"}' AS JSON) WHERE id = @id", new { id = p.Id });
        Assert.Equal("", (await Visitor.Get($"/api/catalog/products/{p.Slug}"))["variants"][0]!["net_quantity"]!.GetValue<string>());
        // switches
        await SetSettings(new { pdp_unit_price = false, pdp_key_specs = false });
        page = (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Body!;
        Assert.Null(page["variants"]![0]!["unit_price"]);
        Assert.Empty(page["key_specs"]!.AsArray());
        var site = (await Visitor.Get("/api/site")).Body!;
        Assert.False(site["pdp"]!["unit_price"]!.GetValue<bool>());
        Assert.True(site["pdp"]!["share"]!.GetValue<bool>());
        Assert.True(site["reviews"]!["photos"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Social_proof_offers_snapshot_and_delivery()
    {
        var (tn, ka, shirt, _, _) = await SetupAsync();
        await Seed.CouponAsync("WELCOME10", "percent", 1000, maxDiscount: 15000);
        await Seed.CouponAsync("KOVAI100", "flat", 10000, minOrder: 50000, sellerId: tn.Id);
        await Seed.CouponAsync("MYSURU50", "flat", 5000, sellerId: ka.Id);
        await SetSettings(new { pdp_bought_min = 1 });
        var buyer = await User("9600000011", "Buyer 11");
        await Seed.OrderAsync(buyer.UserId, "placed", (shirt, 0, 1));
        var page = (await Visitor.Get($"/api/catalog/products/{shirt.Slug}")).Body!;
        Assert.Equal("1 bought in the past month", page["bought_last_month"]!.GetValue<string>());
        var codes = page["offers"]!.AsArray().ToDictionary(o => o!["code"]!.GetValue<string>(), o => o!);
        Assert.Equal(new HashSet<string> { "WELCOME10", "KOVAI100" }, codes.Keys.ToHashSet()); // another seller's coupon is not offered here
        Assert.Equal("10% off up to ₹150", codes["WELCOME10"]["title"]!.GetValue<string>());
        Assert.Equal("on orders of ₹500 or more", codes["KOVAI100"]["terms"]!.GetValue<string>());
        Assert.Equal("seller", codes["KOVAI100"]["source"]!.GetValue<string>());
        Assert.Equal("1 bought in past month", (await Visitor.Get("/api/catalog/products?q=handloom"))["items"][0]!["bought"]!.GetValue<string>());
        var snap = page["seller_snapshot"]!;
        Assert.False(snap["top_seller"]!.GetValue<bool>());
        Assert.False(string.IsNullOrEmpty(snap["since"]!.GetValue<string>()));
        Assert.Null(snap["orders_90d"]); // fewer than 5 orders: not shown
        Assert.Null(page["bestseller"]);
        await SetSettings(new { pdp_offers = false, pdp_bought_count = false, pdp_seller_snapshot = false });
        page = (await Visitor.Get($"/api/catalog/products/{shirt.Slug}")).Body!;
        Assert.Empty(page["offers"]!.AsArray());
        Assert.Null(page["bought_last_month"]);
        Assert.Null(page["seller_snapshot"]);

        // seller dispatch cut-off feeds the delivery estimate
        await Sql("UPDATE sellers SET dispatch_days = 1, dispatch_cutoff = '23:59' WHERE id = @id", new { id = tn.Id });
        var est = (await Visitor.Get($"/api/catalog/delivery-estimate?variant_id={shirt.VariantIds[0]}&pincode=641001")).Body!;
        Assert.True(est["serviceable"]!.GetValue<bool>());
        Assert.Equal("Tamil Nadu", est["state"]!.GetValue<string>());
        Assert.Equal(0, est["delivery_fee_paise"]!.GetValue<long>());
        Assert.True(est.AsObject().ContainsKey("order_within_min"));
        Assert.True(est["cod_available"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Reviews_photos_votes_reports_and_moderation()
    {
        var (tn, _, shirt, _, _) = await SetupAsync();
        var slug = shirt.Slug;
        var buyer = await User("9600000021", "Buyer 21");
        var orderId = await Seed.OrderAsync(buyer.UserId, "placed", (shirt, 0, 1));
        var guest = (await Visitor.Get($"/api/catalog/products/{slug}/reviews")).Body!;
        Assert.False(guest["can_review"]!.GetValue<bool>());
        Assert.Equal("sign_in", guest["cannot_review_reason"]!.GetValue<string>());
        Assert.Equal("not_purchased", (await buyer.Get($"/api/catalog/products/{slug}/reviews"))["cannot_review_reason"].GetValue<string>());
        Assert.Equal("own_product", (await tn.Owner.Get($"/api/catalog/products/{slug}/reviews"))["cannot_review_reason"].GetValue<string>());
        await Sql("UPDATE sub_orders SET status = 'delivered', delivered_at = UTC_TIMESTAMP(6) WHERE order_id = @orderId", new { orderId });
        Assert.True((await buyer.Get($"/api/catalog/products/{slug}/reviews"))["can_review"].GetValue<bool>());

        // guests cannot upload; customers upload a photo, other sites' links are refused
        Assert.Equal(401, (await Visitor.Upload("/api/reviews/media", Png(), "a.png", "image/png")).Status);
        var up = await buyer.Upload("/api/reviews/media", Png(), "a.png", "image/png");
        Assert.Equal(201, up.Status);
        Assert.Equal("image", up["kind"].GetValue<string>());
        var photo = up["url"].GetValue<string>();
        Assert.Contains("/reviews/", photo);
        Assert.Equal("invalid_image", (await buyer.Upload("/api/reviews/media", "not an image"u8.ToArray(), "a.png", "image/png")).ErrorCode);
        var bad = new { rating = 5, media = new[] { new { kind = "image", url = "https://evil.example/x.png" } } };
        var badR = await buyer.Put($"/api/catalog/products/{slug}/reviews", bad);
        Assert.Equal(422, badR.Status);
        Assert.Equal("Media: Upload photos and videos here; links to other sites are not allowed", badR["error"]["message"]!.GetValue<string>());
        var r = await buyer.Put($"/api/catalog/products/{slug}/reviews",
            new { rating = 5, title = "Great quality", body = "Soft cotton, great quality", media = new[] { new { kind = "image", url = photo } } });
        Assert.Equal(200, r.Status);
        Assert.Equal("published", r["status"].GetValue<string>());
        var data = (await Visitor.Get($"/api/catalog/products/{slug}/reviews")).Body!;
        var item = data["items"]![0]!;
        Assert.True(item["verified"]!.GetValue<bool>());
        Assert.Equal(photo, item["media"]![0]!["url"]!.GetValue<string>());
        Assert.Equal(1, data["with_media_count"]!.GetValue<long>());
        Assert.Equal(1, data["media_total"]!.GetValue<long>());
        Assert.Equal(item["id"]!.GetValue<string>(), data["media"]![0]!["review_id"]!.GetValue<string>());
        Assert.Equal(5.0, data["rating_avg"]!.GetValue<double>());
        Assert.Equal(1, data["distribution"]!["5"]!.GetValue<long>());
        Assert.Equal(0, (await Visitor.Get($"/api/catalog/products/{slug}/reviews?star=3"))["total"].GetValue<long>());
        Assert.Equal(1, (await Visitor.Get($"/api/catalog/products/{slug}/reviews?media=true"))["total"].GetValue<long>());
        Assert.Equal(1, (await Visitor.Get($"/api/catalog/products/{slug}/reviews?topic=quality"))["total"].GetValue<long>());
        Assert.Equal(0, (await Visitor.Get($"/api/catalog/products/{slug}/reviews?topic=taste"))["total"].GetValue<long>());

        // helpful: signed-in only, one vote that toggles, not on your own review
        var rid = item["id"]!.GetValue<string>();
        Assert.Equal(401, (await Visitor.Post($"/api/reviews/{rid}/helpful")).Status);
        Assert.Equal("own_review", (await buyer.Post($"/api/reviews/{rid}/helpful")).ErrorCode);
        var other = await User("9600000022", "Other Shopper");
        var vote = (await other.Post($"/api/reviews/{rid}/helpful")).Body!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"ok": true, "voted": true, "helpful_count": 1}"""), vote));
        Assert.Equal(0, (await other.Post($"/api/reviews/{rid}/helpful"))["helpful_count"].GetValue<int>());

        // customer photos can be limited to signed-in shoppers
        await SetReviewSettings(new { media_public = false });
        Assert.Empty((await Visitor.Get($"/api/catalog/products/{slug}/reviews"))["items"][0]!["media"]!.AsArray());
        Assert.True((await Visitor.Get($"/api/catalog/products/{slug}/media"))["sign_in_to_see"].GetValue<bool>());
        Assert.Equal(photo, (await other.Get($"/api/catalog/products/{slug}/reviews"))["items"][0]!["media"]![0]!["url"]!.GetValue<string>());
        Assert.Equal(1, (await other.Get($"/api/catalog/products/{slug}/media"))["total"].GetValue<long>());

        // reports: two reports hide the review until staff look
        Assert.Equal(2, (await SetReviewSettings(new { report_hide_at = 2 })).Int("report_hide_at"));
        Assert.Equal("invalid_reason", (await other.Post($"/api/reviews/{rid}/report", new { reason = "bogus" })).ErrorCode);
        Assert.False((await other.Post($"/api/reviews/{rid}/report", new { reason = "fake" }))["hidden"].GetValue<bool>());
        Assert.True((await other.Post($"/api/reviews/{rid}/report", new { reason = "fake" }))["already"].GetValue<bool>());
        Assert.True((await other.Get($"/api/catalog/products/{slug}/reviews"))["items"][0]!["reported"]!.GetValue<bool>());
        // the seller hub's "report a review" (seller module) files through IReviewBAL
        var hidden = await With<IReviewBAL, JsonObject>(async rv => await rv.FileReviewReportAsync(
            (await Seed.QueryAsync<Model.DomainModel.ReviewModel>("SELECT * FROM reviews WHERE id = @rid", new { rid }))[0], tn.Owner.UserId,
            new ReviewReportIn { Reason = "not_product", Note = "Wrong item shown" }));
        Assert.True(hidden.Bool("hidden"));
        Assert.Equal(0, (await Visitor.Get($"/api/catalog/products/{slug}/reviews"))["rating_count"].GetValue<int>());
        // staff publish it again (admin module), which refreshes the ratings through IReviewBAL
        await Sql("UPDATE reviews SET status = 'published', report_count = 0 WHERE id = @rid", new { rid });
        await With<IReviewBAL, bool>(async rv => { await rv.RefreshRatingsAsync(shirt.Id); return true; });
        Assert.Equal(1, (await Visitor.Get($"/api/catalog/products/{slug}/reviews"))["rating_count"].GetValue<int>());
        Assert.Equal(5.0m, await Scalar<decimal>("SELECT rating_avg FROM sellers WHERE id = @id", new { id = tn.Id }));

        // contact details in a review hold it for a person to check
        r = await buyer.Put($"/api/catalog/products/{slug}/reviews", new { rating = 4, body = "Call me on 9876543210 for a discount" });
        Assert.Equal("pending", r["status"].GetValue<string>());
        Assert.True(r["held_for_check"].GetValue<bool>());

        // when anyone signed in may review, a non-buyer's review carries no "verified" badge
        Assert.Equal("not_purchased", (await other.Put($"/api/catalog/products/{slug}/reviews", new { rating = 3, body = "Saw it in a shop" })).ErrorCode);
        await SetReviewSettings(new { buyers_only = false, min_body_chars = 5 });
        Assert.Equal("review_too_short", (await other.Put($"/api/catalog/products/{slug}/reviews", new { rating = 3, body = "ok" })).ErrorCode);
        Assert.Equal(200, (await other.Put($"/api/catalog/products/{slug}/reviews", new { rating = 3, body = "Saw it in a shop, decent" })).Status);
        Assert.Equal(0, (await Visitor.Get($"/api/catalog/products/{slug}/reviews?verified=true"))["total"].GetValue<long>());
        Assert.False((await Visitor.Get($"/api/catalog/products/{slug}/reviews"))["items"][0]!["verified"]!.GetValue<bool>());
        Assert.Equal(200, (await other.Delete($"/api/catalog/products/{slug}/reviews")).Status);
        Assert.Equal(404, (await other.Delete($"/api/catalog/products/{slug}/reviews")).Status);
        Assert.Equal(422, (await other.Put($"/api/catalog/products/{slug}/reviews", new { rating = 6 })).Status);

        // settings validation
        Assert.Equal("invalid_setting", (await Assert.ThrowsAsync<AppException>(() => SetReviewSettings(new { max_photos = 99 }))).Code);
        Assert.Equal("invalid_setting", (await Assert.ThrowsAsync<AppException>(() =>
            SetReviewSettings(new { topics = new[] { new { name = "X", words = new[] { "a" } } } }))).Code);
        await SetSettings(new { feature_reviews = false });
        Assert.Equal("reviews_off", (await buyer.Upload("/api/reviews/media", Png(), "a.png", "image/png")).ErrorCode);
    }

    [Fact]
    public async Task Report_a_product()
    {
        var (_, _, shirt, phone, _) = await SetupAsync();
        var slug = shirt.Slug;
        Assert.Equal(401, (await Visitor.Post($"/api/catalog/products/{slug}/report", new { reason = "counterfeit" })).Status);
        var shopper = await User("9600000031", "Careful Shopper");
        var r = await shopper.Post($"/api/catalog/products/{slug}/report", new { reason = "counterfeit", note = "short" });
        Assert.Equal("note_required", r.ErrorCode);
        Assert.Equal("Too short", r["error"]["fields"]!["note"]!.GetValue<string>());
        Assert.Equal(422, (await shopper.Post($"/api/catalog/products/{slug}/report", new { reason = "price", url = "javascript:alert(1)" })).Status);
        Assert.Equal("invalid_reason", (await shopper.Post($"/api/catalog/products/{slug}/report", new { reason = "boring" })).ErrorCode);
        r = await shopper.Post($"/api/catalog/products/{slug}/report", new { reason = "counterfeit", note = "The logo is different from the brand's" });
        Assert.Equal(201, r.Status);
        // reporting again updates the same open report
        var again = await shopper.Post($"/api/catalog/products/{slug}/report", new { reason = "price", url = "https://example.com/cheaper" });
        Assert.Equal(r["id"].GetValue<string>(), again["id"].GetValue<string>());
        Assert.Equal(1, await Scalar<long>("SELECT COUNT(*) FROM product_reports WHERE status = 'open' AND reason = 'price'"));
        await SetSettings(new { pdp_report = false });
        Assert.Equal("reports_off", (await shopper.Post($"/api/catalog/products/{phone.Slug}/report", new { reason = "price" })).ErrorCode);
    }
}
