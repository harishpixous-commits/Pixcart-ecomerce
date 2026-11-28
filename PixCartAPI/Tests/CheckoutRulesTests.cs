using System.Net.Http.Json;
using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Model.Constants;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace Tests;

/// <summary>Checkout and order rules: a business buyer's GSTIN, save for later at the limit, a deleted address in the
/// quote, cancelling what can no longer be cancelled, and the unpaid-order expiry recording every successful attempt.</summary>
public class CheckoutRulesTests(ApiFactory f) : ApiTest(f)
{
    private static DateTime Now => DateTimeFunctions.UtcNow();

    /// <summary>An approved Tamil Nadu seller with a warehouse and one live shirt in stock.</summary>
    private static async Task<(Guid VariantId, Guid ProductId, Guid SellerId)> ShirtInStock(string ownerPhone, string slug, string gstinBase = "33KOVAI1234K1Z")
    {
        var category = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO categories (id, parent_id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active, required_details, " +
            "return_window_days, min_return_window_days, created_at, updated_at) VALUES (@category, NULL, 'Shirts', @slug, '', 1000, 500, 0, 1, CAST('[]' AS JSON), 7, 0, @now, @now)",
            new { category, slug = "cat-" + slug, now = Now });
        var ownerId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO users (id, phone, email, name, is_admin, is_active, admin_role, totp_enabled, marketing_opt_in, ui_prefs, created_at, updated_at) " +
            "VALUES (@ownerId, @ownerPhone, NULL, 'Kovai Owner', 0, 1, '', 0, 0, CAST('{}' AS JSON), @now, @now)", new { ownerId, ownerPhone, now = Now });
        var sellerId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, gstin, pan_last4, contact_email, contact_phone, " +
            "pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, grievance_email, " +
            "grievance_phone, rejection_reason, submitted_at, approved_at, razorpay_account_id, dispatch_days, dispatch_cutoff, holiday_mode, created_at, updated_at) " +
            "VALUES (@sellerId, @ownerId, 'approved', 'Kovai Weaves', @slug, 'Quality goods', 'Kovai Weaves Traders', 'proprietorship', @gstin, '234K', 'kovai@example.com', " +
            "@ownerPhone, '12 Market Road', '', 'Coimbatore', '33', '641001', 'Kovai Weaves Traders', '9012', 'HDFC0001234', 'Ravi Kumar', 'grievance@example.com', " +
            "@ownerPhone, '', @now, @now, '', 2, '', 0, @now, @now)", new { sellerId, ownerId, ownerPhone, slug = "seller-" + slug, gstin = Gstin(gstinBase), now = Now });
        var warehouseId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO warehouses (id, seller_id, code, name, line1, line2, city, state_code, pincode, contact_name, contact_phone, gstin, is_default, is_active, " +
            "shiprocket_pickup_name, created_at, updated_at) VALUES (@warehouseId, @sellerId, 'MAIN', 'Main warehouse', '12 Market Road', '', 'Coimbatore', '33', '641001', 'Ravi', " +
            "@ownerPhone, '', 1, 1, '', @now, @now)", new { warehouseId, sellerId, ownerPhone, now = Now });
        var productId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, hsn_code, gst_bps, country_of_origin, " +
            "return_window_days, status, rejection_reason, submitted_at, approved_at, price_from, mrp_from, in_stock, rating_avg, rating_count, sold_count, details, " +
            "created_at, updated_at) VALUES (@productId, @sellerId, @category, 'Handloom Cotton Shirt', @slug, 'Kovai', " +
            "'A well made handloom shirt with great materials and finish.', CAST('[\"Handloom\"]' AS JSON), CAST('{\"Material\": \"Cotton\"}' AS JSON), '6205', 500, " +
            "'India', 7, 'approved', '', @now, @now, 0, 0, 0, 0, 0, 0, CAST('{}' AS JSON), @now, @now)", new { productId, sellerId, category, slug, now = Now });
        var variantId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, net_qty, is_active, created_at, updated_at) " +
            "VALUES (@variantId, @productId, @sellerId, 'HL-1', CAST('{}' AS JSON), 200000, 100000, 10, 500, NULL, 1, @now, @now)",
            new { variantId, productId, sellerId, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO inventory_levels (variant_id, warehouse_id, quantity, updated_at) VALUES (@variantId, @warehouseId, 10, @now)",
            new { variantId, warehouseId, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO product_images (id, product_id, url, position) VALUES (@id, @productId, '/media/products/shirt.webp', 0)",
            new { id = Guid.NewGuid(), productId });
        return (variantId, productId, sellerId);
    }

    private async Task Refresh(Guid productId)
    {
        await using var scope = Factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<ICatalogBAL>().RefreshProductAggregatesAsync(productId);
    }

    private static string Gstin(string first14) => first14 + IndianStates.GstinCheckChar(first14);

    private static object Order(string addr, string gstin = "", string business = "") => new
    {
        address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), buyer_gstin = gstin, buyer_business = business,
    };

    [Fact]
    public async Task Points_become_a_single_use_coupon_and_come_back_if_unused()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000301", "points-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000301", "Points Buyer");
        var addr = await AddAddress(buyer, state: "33");
        Assert.Equal("loyalty_off", (await buyer.Post("/api/loyalty/redeem", new { points = 100 })).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, min_redeem_points = 100, max_redeem_percent = 50, point_value_paise = 100 } })).Status);
        Assert.Equal(200, (await admin.Post("/api/admin/growth/loyalty/adjust", new { user_id = buyer.Id, points = 300, note = "Goodwill" })).Status);
        Assert.Equal("below_minimum", (await buyer.Post("/api/loyalty/redeem", new { points = 50 })).ErrorCode);
        Assert.Equal("balance_too_low", (await buyer.Post("/api/loyalty/redeem", new { points = 400 })).ErrorCode);
        var red = await buyer.Post("/api/loyalty/redeem", new { points = 100 });
        Assert.True(red.Status == 200, red.ToString());
        var code = red.Json["code"]!.GetValue<string>();
        Assert.Equal(10000, red.Json["discount_paise"]!.GetValue<long>()); Assert.Equal(200, red.Json["balance"]!.GetValue<long>()); Assert.Equal(20000, red.Json["min_order_paise"]!.GetValue<long>());
        Assert.Equal(200, (await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());

        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var r = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), coupon_code = code });
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(10000, r.Json["order"]!["discount_total"]!.GetValue<long>());
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        r = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), coupon_code = code });
        Assert.Equal(400, r.Status);   // single use

        var second = (await buyer.Post("/api/loyalty/redeem", new { points = 100 })).Json["code"]!.GetValue<string>();
        Assert.Equal(100, (await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        await ApiFactory.DbExecAsync("UPDATE coupons SET ends_at = @past WHERE code = @second", new { past = Now.AddDays(-1), second });
        Assert.Equal(200, (await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());
        Assert.Equal(200, (await buyer.Get("/api/loyalty")).Json["balance"]!.GetValue<long>());   // only once
    }

    [Fact]
    public async Task Abandoned_cart_reminders_follow_the_settings_and_stop_after_an_order()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000401", "cart-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000401", "Cart Buyer");
        var addr = await AddAddress(buyer, state: "33");
        var uid = Guid.Parse(buyer.Id);
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var notify = scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        Task Age(int hours) => ApiFactory.DbExecAsync("UPDATE cart_items SET updated_at = @t WHERE user_id = @uid", new { t = Now.AddHours(-hours), uid });
        Task<int> Run() => CartReminders.SendDueAsync(db, notify);
        async Task<long> Count() => await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE user_id = @uid AND event = 'abandoned_cart'", new { uid });

        await Age(30);
        Assert.Equal(0, await Run());   // off by default
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { abandoned_cart = new { enabled = true, min_cart_paise = 100, offer_coupon = "COMEBACK" } })).Status);
        Assert.Equal(0, await Run());   // not opted in to marketing messages
        await ApiFactory.DbExecAsync("UPDATE users SET marketing_opt_in = 1 WHERE id = @uid", new { uid });
        await Age(1);
        Assert.Equal(0, await Run());   // too fresh
        await Age(5);
        Assert.Equal(1, await Run()); Assert.Equal(0, await Run());   // stage 1 once
        Assert.True(await Count() >= 1);
        var body = await db.ExecuteScalarAsync<string>("SELECT body FROM notifications WHERE user_id = @uid AND event = 'abandoned_cart' LIMIT 1", new { uid });
        Assert.Contains("COMEBACK", body);
        await Age(30);
        Assert.Equal(1, await Run()); Assert.Equal(0, await Run());   // stage 2 after 24 hours, no third (max_reminders 2)
        // an order after the last change ends it
        await Age(40);
        var r = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(r.Status == 201, r.ToString());
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        await Age(1);
        Assert.Equal(0, await Run());
        var log = (await admin.Get("/api/admin/growth/cart-reminders")).Json;
        Assert.True(log["enabled"]!.GetValue<bool>()); Assert.Equal(2, log["sent_30d"]!.GetValue<long>());
        Assert.Equal(2, log["items"]![0]!["stage"]!.GetValue<int>()); Assert.Equal(1, log["items"]![1]!["stage"]!.GetValue<int>());
        Assert.True(log["items"]![0]!["ordered_after"]!.GetValue<bool>()); Assert.Equal(2, log["ordered_after"]!.GetValue<int>());
    }

    [Fact]
    public async Task Gift_cards_are_issued_by_staff_and_redeemed_into_a_coupon()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000501", "gift-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000501", "Gift Buyer");
        var addr = await AddAddress(buyer, state: "33");
        Assert.Equal("gift_cards_off", (await admin.Post("/api/admin/growth/gift-cards", new { amount_paise = 20000 })).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { gift_cards = new { enabled = true, min_paise = 10000, max_paise = 100000 } })).Status);
        Assert.Equal("invalid_amount", (await admin.Post("/api/admin/growth/gift-cards", new { amount_paise = 500000 })).ErrorCode);
        Assert.Equal(403, (await buyer.Post("/api/admin/growth/gift-cards", new { amount_paise = 20000 })).Status);
        var made = await admin.Post("/api/admin/growth/gift-cards", new { amount_paise = 20000, note = "Diwali" });
        Assert.True(made.Status == 200, made.ToString());
        var card = made.Json["items"]![0]!; var code = card["code"]!.GetValue<string>(); var id = card["id"]!.GetValue<string>();
        Assert.Equal("invalid_code", (await buyer.Post("/api/gift-cards/balance", new { code = "GCNOPE" })).ErrorCode);
        Assert.Equal(20000, (await buyer.Post("/api/gift-cards/balance", new { code = code.ToLowerInvariant() })).Json["balance_paise"]!.GetValue<int>());
        Assert.Equal("balance_too_low", (await buyer.Post("/api/gift-cards/redeem", new { code, amount_paise = 30000 })).ErrorCode);
        var r = await buyer.Post("/api/gift-cards/redeem", new { code, amount_paise = 12000 });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal(8000, r.Json["card_balance_paise"]!.GetValue<int>());
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), coupon_code = r.Json["code"]!.GetValue<string>() });
        Assert.True(o.Status == 201, o.ToString());
        Assert.Equal(12000, o.Json["order"]!["discount_total"]!.GetValue<long>());
        var r2 = await buyer.Post("/api/gift-cards/redeem", new { code });
        Assert.Equal(8000, r2.Json["discount_paise"]!.GetValue<int>()); Assert.Equal(0, r2.Json["card_balance_paise"]!.GetValue<int>());
        await ApiFactory.DbExecAsync("UPDATE coupons SET ends_at = @past WHERE code = @c", new { past = Now.AddDays(-1), c = r2.Json["code"]!.GetValue<string>() });
        Assert.Equal(8000, (await buyer.Post("/api/gift-cards/balance", new { code })).Json["balance_paise"]!.GetValue<int>());
        Assert.Equal(8000, (await buyer.Post("/api/gift-cards/balance", new { code })).Json["balance_paise"]!.GetValue<int>());   // only once
        Assert.Equal("void", (await admin.Post($"/api/admin/growth/gift-cards/{id}/void", new { })).Json["status"]!.GetValue<string>());
        Assert.Equal("card_unavailable", (await buyer.Post("/api/gift-cards/redeem", new { code })).ErrorCode);
        Assert.Single((await admin.Get("/api/admin/growth/gift-cards")).Json["items"]!.AsArray());
    }

    [Fact]
    public async Task A_wrong_gstin_is_refused_with_its_reason_and_a_right_one_is_kept()
    {
        var admin = await Admin();
        var r = await admin.Put("/api/admin/checkout", new { fees = new { gstin_enabled = true } });
        Assert.True(r.Status == 200, r.ToString());
        var (variantId, productId, _) = await ShirtInStock("9400000201", "gstin-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000201", "Meena");
        var addr = await AddAddress(buyer, state: "33");
        r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.True(r.Status is 200 or 201, r.ToString());

        var good = Gstin("33ABCDE1234F1Z");
        var wrongDigit = good[..14] + (good[14] == 'A' ? 'B' : 'A');
        r = await buyer.Post("/api/orders", Order(addr, wrongDigit, "Meena Traders"));
        Assert.True(r.Status == 400 && r.ErrorCode == "invalid_gstin", r.ToString());
        Assert.Equal("GSTIN check digit does not match; please re-check the number", r.Json["error"]!["message"]!.GetValue<string>());
        Assert.Equal("Invalid", r.Json["error"]!["fields"]!["buyer_gstin"]!.GetValue<string>());

        r = await buyer.Post("/api/orders", Order(addr, "NOT-A-GSTIN", "Meena Traders"));
        Assert.True(r.Status == 400 && r.ErrorCode == "invalid_gstin", r.ToString());
        Assert.Equal("Enter a valid 15-character GSTIN", r.Json["error"]!["message"]!.GetValue<string>());

        r = await buyer.Post("/api/orders", Order(addr, good, "!"));  // the business name is checked the same way
        Assert.True(r.Status == 400 && r.ErrorCode == "invalid_gstin", r.ToString());

        r = await buyer.Post("/api/orders", Order(addr, good, "Meena Traders"));
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(good, r.Json["order"]!["buyer_gstin"]!.GetValue<string>());
        Assert.Equal("Meena Traders", r.Json["order"]!["buyer_business"]!.GetValue<string>());
    }

    [Fact]
    public async Task Save_for_later_at_the_limit_keeps_the_cart_line()
    {
        var (variantId, productId, sellerId) = await ShirtInStock("9400000202", "saved-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000202", "Meena");
        var r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.True(r.Status is 200 or 201, r.ToString());
        // the saved list is already full (other sizes of the same shirt)
        await ApiFactory.DbExecAsync(
            "INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, net_qty, is_active, created_at, updated_at) " +
            "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < @max) " +
            "SELECT UUID(), @productId, @sellerId, CONCAT('SV-', i), CAST('{}' AS JSON), 200000, 100000, 1, 500, NULL, 1, @now, @now FROM n",
            new { productId, sellerId, max = CartBAL.MaxSaved, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO saved_items (user_id, variant_id, created_at) SELECT @userId, id, @now FROM variants WHERE product_id = @productId AND sku LIKE 'SV-%'",
            new { userId = buyer.Id, productId, now = Now });

        r = await buyer.Post($"/api/cart/items/{variantId}/save-for-later");
        Assert.True(r.Status == 400 && r.ErrorCode == "saved_full", r.ToString());
        Assert.Equal(1, await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM cart_items WHERE user_id = @userId AND variant_id = @variantId",
            new { userId = buyer.Id, variantId }));
        Assert.Equal(CartBAL.MaxSaved, await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM saved_items WHERE user_id = @userId", new { userId = buyer.Id }));

        // with room again, the line moves from the cart to the saved list
        await ApiFactory.DbExecAsync("DELETE FROM saved_items WHERE user_id = @userId LIMIT 1", new { userId = buyer.Id });
        r = await buyer.Post($"/api/cart/items/{variantId}/save-for-later");
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal(0, await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM cart_items WHERE user_id = @userId", new { userId = buyer.Id }));
    }

    [Fact]
    public async Task The_quote_refuses_a_deleted_address_and_a_shipped_order_cannot_be_cancelled()
    {
        var (variantId, productId, _) = await ShirtInStock("9400000203", "quote-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000203", "Meena");
        var addr = await AddAddress(buyer, state: "33");
        var gone = await AddAddress(buyer, state: "33", pincode: "600017");
        var r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.True(r.Status is 200 or 201, r.ToString());

        Assert.Equal(200, (await buyer.Post("/api/checkout/quote", new { address_id = gone, payment_method = "cod" })).Status);
        Assert.Equal(200, (await buyer.Delete($"/api/addresses/{gone}")).Status);
        r = await buyer.Post("/api/checkout/quote", new { address_id = gone, payment_method = "cod" });
        Assert.True(r.Status == 404 && r.ErrorCode == "not_found", r.ToString());

        r = await buyer.Post("/api/orders", Order(addr));
        Assert.True(r.Status == 201, r.ToString());
        var orderId = r.Json["order"]!["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET status = 'shipped' WHERE order_id = @orderId", new { orderId });
        r = await buyer.Post($"/api/orders/{orderId}/cancel", new { reason = "Changed my mind" });
        Assert.True(r.Status == 400 && r.ErrorCode == "not_cancellable", r.ToString());
        Assert.Equal("This order can no longer be cancelled. You can return it after delivery.", r.Json["error"]!["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_same_order_submitted_three_times_at_once_is_placed_once()
    {
        var (variantId, productId, _) = await ShirtInStock("9400000205", "twice-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000205", "Meena");
        var addr = await AddAddress(buyer, state: "33");
        var r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.True(r.Status is 200 or 201, r.ToString());
        var body = new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") };
        var answers = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => buyer.Post("/api/orders", body)));
        Assert.All(answers, a => Assert.True(a.Status == 201, a.ToString()));
        Assert.Single(answers.Select(a => a.Json["order"]!["id"]!.GetValue<string>()).Distinct());
        Assert.Equal(1, await ApiFactory.DbScalarAsync<int>("SELECT COUNT(*) FROM orders WHERE user_id = @id", new { id = buyer.Id }));
        Assert.Equal(9, await ApiFactory.DbScalarAsync<int>("SELECT quantity FROM inventory_levels WHERE variant_id = @variantId", new { variantId }));
    }

    /// <summary>Razorpay as the expiry job sees it: two successful attempts for one order (a duplicate UPI payment).</summary>
    private sealed class TwoAttempts : IRazorpayBAL
    {
        private static JsonObject Payment(string id) =>
            new() { ["id"] = id, ["order_id"] = "order_SYNTH_EXPIRY", ["status"] = "captured", ["method"] = "upi", ["amount"] = 10000L, ["created_at"] = 1L };
        public Task<bool> OnlinePaymentsAsync() => Task.FromResult(true);
        public Task<JsonObject> CreateOrderAsync(long a, string r, IReadOnlyDictionary<string, string> n, string c = "INR") => throw new InvalidOperationException("not expected");
        public Task<JsonObject> CreateCustomerAsync(string n, string c, string e) => throw new InvalidOperationException("not expected");
        public Task<JsonObject> FetchPaymentAsync(string id) => Task.FromResult(Payment(id));
        public Task<IReadOnlyList<JsonObject>> OrderPaymentsAsync(string id) =>
            Task.FromResult<IReadOnlyList<JsonObject>>(id == "order_SYNTH_EXPIRY" ? [Payment("pay_SYNTH_FIRST"), Payment("pay_SYNTH_SECOND")] : []);
        public Task<JsonObject> CapturePaymentAsync(string id, long amount, string currency = "INR") => Task.FromResult(Payment(id));
        public Task<JsonObject> RefundPaymentAsync(string p, long a, string r, IReadOnlyDictionary<string, string> n) => throw new InvalidOperationException("the refund worker stays off");
        public Task<bool> VerifyPaymentSignatureAsync(string a, string b, string c) => throw new InvalidOperationException("not expected");
        public Task<bool> VerifyWebhookSignatureAsync(byte[] b, string s) => throw new InvalidOperationException("not expected");
    }

    private sealed class Queue : IRefundQueue { public List<Guid> Ids = []; public void Enqueue(IEnumerable<Guid> ids) => Ids.AddRange(ids); }

    [Fact]
    public async Task The_expiry_job_records_every_successful_attempt_and_refunds_the_duplicate()
    {
        var buyer = await LoginPhone("9620000204", "Meena");
        var oid = Guid.NewGuid();
        var pid = Guid.NewGuid();
        await using (var scope = Factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
            var orders = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
            await using var tx = await db.BeginAsync();
            await orders.InsertOrderAsync(new()
            {
                Id = oid, Number = "SYNTH-EXPIRY", UserId = Guid.Parse(buyer.Id), Status = "pending_payment", PaymentMethod = "online", PaymentStatus = "pending",
                ShipTo = "{}", ItemsTotal = 10000, GrandTotal = 10000, Currency = "INR", FxRate = 1, Fees = "[]", IdempotencyKey = Guid.NewGuid().ToString(),
                PaymentExpiresAt = Now.AddMinutes(-1), CreatedAt = Now, UpdatedAt = Now,
            }, tx);
            await tx.ExecuteAsync("INSERT INTO payments (id, order_id, provider, provider_order_id, amount_paise, currency, status, method, error) " +
                                  "VALUES (@pid, @oid, 'razorpay', 'order_SYNTH_EXPIRY', 10000, 'INR', 'created', '', '')", new { pid, oid });
            await tx.CommitAsync();
        }
        var queue = new Queue();
        using var isolated = Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
        {
            s.RemoveAll<IRazorpayBAL>();
            s.AddSingleton<IRazorpayBAL>(new TwoAttempts());
            foreach (var d in s.Where(d => d.ServiceType == typeof(IHostedService) && d.ImplementationType == typeof(API.Infrastructure.RefundWorker)).ToList()) s.Remove(d);
            s.RemoveAll<IRefundQueue>();
            s.AddSingleton<IRefundQueue>(queue);
        }));
        await using (var scope = isolated.Services.CreateAsyncScope())
            Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<IOrdersBAL>().ExpireUnpaidOrdersAsync());

        Assert.Equal("paid", await ApiFactory.DbScalarAsync<string>("SELECT payment_status FROM orders WHERE id = @oid", new { oid }));
        Assert.Equal("pay_SYNTH_FIRST", await ApiFactory.DbScalarAsync<string>("SELECT provider_payment_id FROM payments WHERE id = @pid", new { pid }));
        Assert.Equal("captured", await ApiFactory.DbScalarAsync<string>("SELECT status FROM payments WHERE id = @pid", new { pid }));
        var refunds = await ApiFactory.DbQueryAsync<RefundRow>(
            "SELECT provider_payment_id AS ProviderPaymentId, amount_paise AS AmountPaise, reason AS Reason FROM refunds WHERE order_id = @oid", new { oid });
        var refund = Assert.Single(refunds);
        Assert.Equal(new RefundRow { ProviderPaymentId = "pay_SYNTH_SECOND", AmountPaise = 10000, Reason = "Duplicate payment" }, refund);
    }

    private sealed class NotPaidGateway : IPaymentGatewayBAL
    {
        public List<string> Checked = [];
        public Task<JsonObject> CheckAsync(PaymentModel payment, IUnitOfWork uow, Func<PaymentModel, string, string, long, IUnitOfWork, Task<string>> markPaid)
        {
            Checked.Add(payment.ProviderOrderId);
            return Task.FromResult(new JsonObject { ["result"] = "not_paid", ["attempts"] = new JsonArray(), ["waiting"] = false, ["reason"] = "" });
        }
        public Task<PaymentModel> StartAsync(OrderModel o, UserModel u, long a, long? c, string cc, IUnitOfWork uow, string? p = null, string? af = null) => throw new InvalidOperationException();
        public Task<JsonArray> AlternativesAsync(string c, string cur) => throw new InvalidOperationException();
        public Task<List<string>> EligibleAsync(string c) => throw new InvalidOperationException();
        public Task<JsonObject> PayloadAsync(OrderModel o, PaymentModel p, UserModel u, string b) => throw new InvalidOperationException();
        public Task<GatewayRefund> RefundAsync(PaymentModel p, string pp, long c, string r, string n) => throw new InvalidOperationException();
        public Task<PaymentGateway> AdapterAsync(string code) => throw new InvalidOperationException();
        public Task<JsonObject> GatewaysAsync(UserModel a) => throw new InvalidOperationException();
        public Task<JsonObject> UpdateRoutingAsync(UserModel a, JsonObject b) => throw new InvalidOperationException();
        public Task<JsonObject> TestAsync(UserModel a, string c) => throw new InvalidOperationException();
    }

    [Fact]
    public async Task The_expiry_job_asks_the_gateway_that_took_the_payment_not_Razorpay()
    {
        var buyer = await LoginPhone("9620000205", "Ravi");
        var oid = Guid.NewGuid();
        await using (var scope = Factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
            var orders = scope.ServiceProvider.GetRequiredService<OrdersDAL>();
            await using var tx = await db.BeginAsync();
            await orders.InsertOrderAsync(new()
            {
                Id = oid, Number = "SYNTH-EXPIRY-CF", UserId = Guid.Parse(buyer.Id), Status = "pending_payment", PaymentMethod = "online", PaymentStatus = "pending",
                ShipTo = "{}", ItemsTotal = 10000, GrandTotal = 10000, Currency = "INR", FxRate = 1, Fees = "[]", IdempotencyKey = Guid.NewGuid().ToString(),
                PaymentExpiresAt = Now.AddMinutes(-1), CreatedAt = Now, UpdatedAt = Now,
            }, tx);
            await tx.ExecuteAsync("INSERT INTO payments (id, order_id, provider, provider_order_id, amount_paise, currency, status, method, error) " +
                                  "VALUES (@pid, @oid, 'cashfree', 'cf_SYNTH_EXPIRY', 10000, 'INR', 'created', '', '')", new { pid = Guid.NewGuid(), oid });
            await tx.CommitAsync();
        }
        var fake = new NotPaidGateway();
        using var isolated = Factory.WithWebHostBuilder(b => b.ConfigureTestServices(s =>
        {
            s.RemoveAll<IPaymentGatewayBAL>();
            s.AddSingleton<IPaymentGatewayBAL>(fake);
        }));
        await using (var scope = isolated.Services.CreateAsyncScope())
            Assert.True(await scope.ServiceProvider.GetRequiredService<IOrdersBAL>().ExpireUnpaidOrdersAsync() >= 1);
        Assert.Contains("cf_SYNTH_EXPIRY", fake.Checked);
    }

    [Fact]
    public async Task Razorpayx_payout_events_mark_payouts_paid_or_failed()
    {
        var admin = await Admin();
        var r = await admin.Put("/api/admin/integrations/razorpayx", new { values = new { account_number = "1234567890", webhook_secret = "xsecret" }, password = AdminPassword });
        Assert.True(r.Status == 200, r.ToString());
        var (_, _, sellerId) = await ShirtInStock("9400000206", "payout-shirt");
        var paid = Guid.NewGuid();
        var failed = Guid.NewGuid();
        foreach (var (id, number, pout) in new[] { (paid, "PO-SYNTH-1", "pout_SYNTH_1"), (failed, "PO-SYNTH-2", "pout_SYNTH_2") })
            await ApiFactory.DbExecAsync(
                "INSERT INTO payouts (number, seller_id, amount, status, mode, utr, provider_payout_id, failure_reason, bank_snapshot, paid_at, id, created_at, updated_at) " +
                "VALUES (@number, @sellerId, 150000, 'processing', 'razorpayx', '', @pout, '', CAST('{\"account_last4\": \"9012\"}' AS JSON), NULL, @id, @now, @now)",
                new { number, sellerId, pout, id, now = Now });
        async Task<int> Send(string evt, string pout, string extra, string eventId)
        {
            var raw = "{\"event\":\"" + evt + "\",\"payload\":{\"payout\":{\"entity\":{\"id\":\"" + pout + "\"" + extra + "}}}}";
            var sig = Convert.ToHexStringLower(System.Security.Cryptography.HMACSHA256.HashData(System.Text.Encoding.UTF8.GetBytes("xsecret"), System.Text.Encoding.UTF8.GetBytes(raw)));
            var res = await Factory.Browser().SendAsync(HttpMethod.Post, "/api/webhooks/razorpayx", new StringContent(raw, System.Text.Encoding.UTF8, "application/json"),
                headers: new() { ["x-razorpay-signature"] = sig, ["x-razorpay-event-id"] = eventId });
            return res.Status;
        }
        Assert.Equal(200, await Send("payout.processed", "pout_SYNTH_1", ",\"utr\":\"UTR123\"", "evt_synth_1"));
        Assert.Equal("paid", await ApiFactory.DbScalarAsync<string>("SELECT status FROM payouts WHERE id = @paid", new { paid }));
        Assert.Equal("UTR123", await ApiFactory.DbScalarAsync<string>("SELECT utr FROM payouts WHERE id = @paid", new { paid }));
        Assert.Equal(200, await Send("payout.failed", "pout_SYNTH_2", ",\"status_details\":{\"description\":\"Beneficiary bank is down\"}", "evt_synth_2"));
        Assert.Equal("failed", await ApiFactory.DbScalarAsync<string>("SELECT status FROM payouts WHERE id = @failed", new { failed }));
        Assert.Equal("Beneficiary bank is down", await ApiFactory.DbScalarAsync<string>("SELECT failure_reason FROM payouts WHERE id = @failed", new { failed }));
        Assert.Equal(200, await Send("payout.processed", "pout_SYNTH_UNKNOWN", "", "evt_synth_3"));  // an unknown payout changes nothing
    }

    [Fact]
    public async Task Courier_tracking_moves_the_package_to_shipped_then_delivered()
    {
        var admin = await Admin();
        var r = await admin.Put("/api/admin/integrations/shiprocket",
            new { values = new { email = "ship@example.com", password = "ship-pass-123", webhook_token = "ship-token-123" }, password = AdminPassword });
        Assert.True(r.Status == 200, r.ToString());
        var (variantId, productId, _) = await ShirtInStock("9400000207", "awb-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000207", "Meena");
        var addr = await AddAddress(buyer, state: "33");
        r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.True(r.Status is 200 or 201, r.ToString());
        r = await buyer.Post("/api/orders", Order(addr));
        Assert.True(r.Status == 201, r.ToString());
        var orderId = r.Json["order"]!["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET status = 'packed', tracking_number = 'AWB-SYNTH-1' WHERE order_id = @orderId", new { orderId });
        async Task<int> Track(string status, string at)
        {
            var raw = "{\"awb\":\"AWB-SYNTH-1\",\"current_status\":\"" + status + "\",\"current_timestamp\":\"" + at + "\"}";
            var res = await Factory.Browser().SendAsync(HttpMethod.Post, "/api/webhooks/shiprocket", new StringContent(raw, System.Text.Encoding.UTF8, "application/json"),
                headers: new() { ["x-api-key"] = "ship-token-123" });
            return res.Status;
        }
        Assert.Equal(200, await Track("IN TRANSIT", "2026-11-27 10:00"));
        Assert.Equal("shipped", await ApiFactory.DbScalarAsync<string>("SELECT status FROM sub_orders WHERE order_id = @orderId", new { orderId }));
        Assert.Equal(200, await Track("DELIVERED", "2026-11-27 18:00"));
        Assert.Equal("delivered", await ApiFactory.DbScalarAsync<string>("SELECT status FROM sub_orders WHERE order_id = @orderId", new { orderId }));
    }

    [Fact]
    public void Fee_gst_coupon_shares_and_shortfall_texts_follow_the_shop_rules()
    {
        Assert.Equal((1562L, 438L), BAL.FeesBAL.GstSplit(2000, 2800));  // 1562.5: an exact half rounds to even
        Assert.Equal((312L, 88L), BAL.FeesBAL.GstSplit(400, 2800));
        Assert.Equal((1695L, 305L), BAL.FeesBAL.GstSplit(2000, 1800));
        Guid a = Guid.NewGuid(), b = Guid.NewGuid(), c = Guid.NewGuid();
        var parts = BAL.Money.Allocate(12000, new Dictionary<Guid, long> { [a] = 10000, [b] = 10000, [c] = 70000 });
        Assert.Equal((1333L, 1333L, 9334L), (parts[a], parts[b], parts[c]));  // the leftover paisa goes where it always has
        Assert.Equal("2", CouponsBAL.ShortfallRupees(250));
        Assert.Equal("4", CouponsBAL.ShortfallRupees(350));
        Assert.Equal("123,457", CouponsBAL.ShortfallRupees(12345678));  // grouped in thousands on every server
    }

    [Fact]
    public void Amounts_read_the_same_whatever_the_servers_regional_settings()
    {
        var before = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            foreach (var name in new[] { "en-IN", "de-DE", "en-US" })
            {
                System.Globalization.CultureInfo.CurrentCulture = System.Globalization.CultureInfo.GetCultureInfo(name);
                Assert.Equal("₹123,456.50", BAL.Money.Rupees(12345650));
                Assert.Equal("-₹1,000.05", BAL.Money.Rupees(-100005));
                Assert.Equal("123,457", CouponsBAL.ShortfallRupees(12345678));
            }
        }
        finally
        {
            System.Globalization.CultureInfo.CurrentCulture = before;
        }
    }

    private sealed record RefundRow
    {
        public string ProviderPaymentId { get; init; } = "";
        public long AmountPaise { get; init; }
        public string Reason { get; init; } = "";
    }

    [Fact]
    public async Task Seller_bulk_edit_previews_then_applies_and_skips_bad_rows()
    {
        var admin = await Admin();
        var (vid, _, _) = await ShirtInStock("9400000401", "bulk-a");
        var otherVid = Guid.NewGuid(); // not one of this seller's versions
        var tn = await LoginPhone("9400000401", "Bulk Owner");
        async Task<long> Price() { using var scope = Factory.Services.CreateScope(); return await scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>().QueryFirstOrDefaultAsync<long>("SELECT price_paise FROM variants WHERE id=@vid", new { vid }); }
        var body = new { variant_ids = new[] { vid }, action = "price_percent", value = 10 };
        var r = await tn.Post("/api/seller/variants/bulk-edit", body);
        Assert.True(r.Status == 200, r.ToString());
        Assert.True(r.Json["dry_run"]!.GetValue<bool>()); Assert.Equal(1, r.Json["changed"]!.GetValue<int>()); Assert.Equal(110000, r.Json["rows"]![0]!["after"]!.GetValue<long>()); Assert.Equal(100000, await Price());
        r = await tn.Post("/api/seller/variants/bulk-edit", new { variant_ids = new[] { vid }, action = "price_percent", value = 10, dry_run = false });
        Assert.Equal(1, r.Json["changed"]!.GetValue<int>()); Assert.Equal(110000, await Price());
        r = await tn.Post("/api/seller/variants/bulk-edit", new { variant_ids = new[] { vid }, action = "price_percent", value = 500, dry_run = false });
        Assert.Equal(0, r.Json["changed"]!.GetValue<int>()); Assert.Equal("price_out_of_range", r.Json["rows"]![0]!["reason"]!.GetValue<string>()); Assert.Equal(110000, await Price());
        r = await tn.Post("/api/seller/variants/bulk-edit", new { variant_ids = new[] { otherVid }, action = "price_percent", value = 10, dry_run = false });
        Assert.Equal("not_yours", r.Json["rows"]![0]!["reason"]!.GetValue<string>());
        r = await tn.Post("/api/seller/variants/bulk-edit", new { variant_ids = new[] { vid }, action = "stock_add", value = 5, dry_run = false });
        Assert.Equal(1, r.Json["changed"]!.GetValue<int>()); Assert.Equal(15, r.Json["rows"]![0]!["after"]!.GetValue<long>());
        Assert.Equal("invalid_action", (await tn.Post("/api/seller/variants/bulk-edit", new { variant_ids = new[] { vid }, action = "nope" })).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { bulk_edit = new { enabled = false } })).Status);
        Assert.Equal("bulk_edit_off", (await tn.Post("/api/seller/variants/bulk-edit", body)).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { bulk_edit = new { enabled = true } })).Status);
    }

    [Fact]
    public async Task Seller_bulk_edit_csv_round_trip()
    {
        var (vid, _, _) = await ShirtInStock("9400000411", "bulk-csv");
        var tn = await LoginPhone("9400000411", "Csv Owner");
        
        async Task<long> Price() { using var scope = Factory.Services.CreateScope(); return await scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>().QueryFirstOrDefaultAsync<long>("SELECT price_paise FROM variants WHERE id=@vid", new { vid }); }
        static MultipartFormDataContent Up(string csv) { var f = new MultipartFormDataContent(); f.Add(new ByteArrayContent(System.Text.Encoding.UTF8.GetBytes(csv)), "file", "v.csv"); return f; }
        var dl = await tn.Get("/api/seller/variants/bulk-edit.csv");
        Assert.Equal(200, dl.Status);
        var line = dl.Text.Split("\n").First(l => l.StartsWith(vid.ToString()));
        Assert.Contains(",1000.00,10,yes", line);
        var r = await tn.Post("/api/seller/variants/bulk-edit.csv", Up($"id,price,stock,active\n{vid},1100,15,yes\n"));
        Assert.True(r.Json["dry_run"]!.GetValue<bool>()); Assert.Equal(1, r.Json["changed"]!.GetValue<int>()); Assert.Equal(110000, r.Json["rows"]![0]!["changes"]!["price"]!["after"]!.GetValue<long>()); Assert.Equal(100000, await Price());
        r = await tn.Post("/api/seller/variants/bulk-edit.csv?dry_run=false", Up($"id,price,stock,active\n{vid},1100,15,yes\n"));
        Assert.Equal(1, r.Json["changed"]!.GetValue<int>()); Assert.Equal(110000, await Price());
        r = await tn.Post("/api/seller/variants/bulk-edit.csv?dry_run=false", Up($"id,price\n{vid},5000\n{vid},1200\nnot-an-id,1\n"));
        Assert.Equal(["price_out_of_range", "duplicate_row", "bad_id"], r.Json["rows"]!.AsArray().Select(x => x!["reason"]!.GetValue<string>()).ToArray()); Assert.Equal(0, r.Json["changed"]!.GetValue<int>());
        r = await tn.Post("/api/seller/variants/bulk-edit.csv?dry_run=false", Up($"id,price\n{Guid.NewGuid()},900\n")); // not one of this seller's versions
        Assert.Equal("not_yours", r.Json["rows"]![0]!["reason"]!.GetValue<string>()); Assert.Equal(110000, await Price());
        Assert.Equal("bad_number", (await tn.Post("/api/seller/variants/bulk-edit.csv", Up($"id,price\n{vid},abc\n"))).Json["rows"]![0]!["reason"]!.GetValue<string>());
        Assert.Equal("invalid_file", (await tn.Post("/api/seller/variants/bulk-edit.csv", Up("name,price\nX,1\n"))).ErrorCode);
        var sku = line.Split(',')[1];
        string[] Reasons(Res res) => res.Json["rows"]!.AsArray().Select(x => x!["reason"]?.GetValue<string>() ?? "ok").ToArray();
        Assert.Equal(["no_change"], Reasons(await tn.Post("/api/seller/variants/bulk-edit.csv", Up($"sku,price\n{sku},1100\n")))); // matched on SKU
        r = await tn.Post("/api/seller/variants/bulk-edit.csv?dry_run=false", Up($"sku,price,stock\n{sku.ToLowerInvariant()},1150,9\nNOPE-1,5,1\n{vid},1,1\n"));
        Assert.Equal(["ok", "unknown_sku", "unknown_sku"], Reasons(r)); Assert.Equal(vid.ToString(), r.Json["rows"]![0]!["id"]!.GetValue<string>()); Assert.Equal(115000, await Price());
        r = await tn.Post("/api/seller/variants/bulk-edit.csv?dry_run=false", Up($"id,sku,price\n{vid},{sku},1200\n,{sku},1250\n"));
        Assert.Equal(["ok", "duplicate_row"], Reasons(r)); Assert.Equal(120000, await Price());
    }

    [Fact]
    public async Task Scorecard_auto_suspend_stops_a_critical_seller_once_and_only_when_switched_on()
    {
        var admin = await Admin();
        var (variantId, productId, sellerId) = await ShirtInStock("9400000421", "auto-susp");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000421", "Susp Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.Equal(201, (await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") })).Status);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { scorecard = new { enabled = true, min_orders = 1, ship_within_hours = 1 } })).Status);
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET created_at = @t WHERE seller_id = @sellerId", new { t = Now.AddHours(-5), sellerId });
        using var scope = Factory.Services.CreateScope();
        var growth = scope.ServiceProvider.GetRequiredService<IGrowthBAL>();
        var notify = scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        async Task<string> Status() => await db.QueryFirstOrDefaultAsync<string>("SELECT status FROM sellers WHERE id = @sellerId", new { sellerId }) ?? "";
        Assert.Equal(0, await growth.AutoSuspendAsync(notify)); Assert.Equal("approved", await Status()); // auto_suspend is off
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { scorecard = new { auto_suspend = true } })).Status);
        Assert.Equal(1, await growth.AutoSuspendAsync(notify)); Assert.Equal("suspended", await Status());
        Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM audit_logs WHERE action = 'seller.auto_suspend' AND actor_user_id IS NULL AND detail LIKE '%late shipments%'"));
        Assert.Equal(0, await growth.AutoSuspendAsync(notify)); // already suspended
        Assert.Equal(200, (await admin.Post($"/api/admin/sellers/{sellerId}/approve", new { })).Status);
        Assert.Equal(0, await growth.AutoSuspendAsync(notify)); Assert.Equal("approved", await Status()); // not suspended again for the same old orders
    }

    [Fact]
    public async Task Saved_search_notes_a_shopper_about_new_matching_products()
    {
        var (_, productId, _) = await ShirtInStock("9400000302", "kurta-search");
        var buyer = await LoginPhone("9770000051", "Search Buyer"); var other = await LoginPhone("9770000052", "Other");
        var admin = await Admin(); var uid = Guid.Parse(buyer.Id);
        Assert.Equal("saved_searches_off", (await buyer.Post("/api/saved-searches", new { query = "silk kurta" })).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { saved_searches = new { enabled = true, max_per_user = 2, min_hours_between_alerts = 1 } })).Status);
        var ra = await buyer.Post("/api/saved-searches", new { query = "  Silk   Kurta ", max_price_paise = 150000 }); Assert.True(ra.Status == 201, ra.ToString()); var a = ra.Json;
        Assert.Equal(a["id"]!.GetValue<string>(), (await buyer.Post("/api/saved-searches", new { query = "silk kurta", max_price_paise = 150000 })).Json["id"]!.GetValue<string>());
        Assert.Equal("invalid_query", (await buyer.Post("/api/saved-searches", new { query = "!!" })).ErrorCode);
        Assert.Equal(201, (await buyer.Post("/api/saved-searches", new { query = "denim jacket" })).Status);
        Assert.Equal("too_many_searches", (await buyer.Post("/api/saved-searches", new { query = "third one" })).ErrorCode);
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var notify = scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        Task<int> Run() => SavedSearches.SendMatchesAsync(db, notify);
        async Task<long> Count() => await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE user_id = @uid AND event = 'saved_search_match'", new { uid });
        Assert.Equal(0, await Run()); Assert.Equal(0, await Count());
        await ApiFactory.DbExecAsync("UPDATE products SET title = 'Silk Kurta Premium', price_from = 199900, approved_at = UTC_TIMESTAMP(6) WHERE id = @productId", new { productId });
        Assert.Equal(0, await Run());
        await ApiFactory.DbExecAsync("UPDATE products SET title = 'Festive Silk Kurta Set', price_from = 129900, approved_at = UTC_TIMESTAMP(6) WHERE id = @productId", new { productId });
        Assert.Equal(1, await Run()); Assert.Equal(1, await Count());
        var note = (await buyer.Get("/api/notifications")).Json["items"]!.AsArray().First(n => n!["title"]!.GetValue<string>().StartsWith("New for your search"))!;
        Assert.Contains("Festive Silk Kurta Set", note["body"]!.GetValue<string>());
        Assert.Equal(0, await Run());
        var mine = (await buyer.Get("/api/saved-searches")).Json;
        Assert.Equal(2, mine["items"]!.AsArray().Count);
        Assert.Equal(200, (await buyer.Delete("/api/saved-searches/" + a["id"]!.GetValue<string>())).Status);
        var left = (await buyer.Get("/api/saved-searches")).Json["items"]!.AsArray(); Assert.Single(left);
        Assert.Equal(200, (await other.Delete("/api/saved-searches/" + left[0]!["id"]!.GetValue<string>())).Status);
        Assert.Single((await buyer.Get("/api/saved-searches")).Json["items"]!.AsArray());
    }

    [Fact]
    public async Task Remote_area_surcharge_is_added_per_seller_package_and_waived_when_free()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000303", "remote-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000061", "Remote Buyer");
        var near = await AddAddress(buyer, state: "33");
        var far = await AddAddress(buyer, state: "33", pincode: "744101");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        async Task<(long Total, long Ship)> Quote(string addr)
        {
            var q = (await buyer.Post("/api/checkout/quote", new { address_id = addr, payment_method = "cod" })).Json;
            return (q["summary"]!["grand_total"]!.GetValue<long>(), q["groups"]![0]!["shipping_fee"]!.GetValue<long>());
        }
        var (baseTotal, baseShip) = await Quote(far);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { enabled = true, remote_prefixes = "744, 19", remote_surcharge_paise = 6000 } })).Status);
        Assert.Equal(baseTotal, (await Quote(near)).Total);
        Assert.Equal(baseShip == 0 ? baseTotal : baseTotal + 6000, (await Quote(far)).Total);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { waive_when_free = false } })).Status);
        var (quoted, _) = await Quote(far);
        Assert.Equal(baseTotal + 6000, quoted);
        var r = await buyer.Post("/api/orders", new { address_id = far, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), expected_total = quoted });
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(quoted, r.Json["order"]!["grand_total"]!.GetValue<long>());
        Assert.Equal(400, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { remote_surcharge_paise = 9999999 } })).Status);
    }

    [Fact]
    public async Task Return_photos_are_off_until_staff_switch_them_on()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000305", "photo-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000072", "Photo Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        var subId = o.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
        var items = new[] { new { order_item_id = Guid.NewGuid(), qty = 1 } };
        static MultipartFormDataContent Form() { var f = new MultipartFormDataContent(); f.Add(new ByteArrayContent(Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAZAAAAGQCAIAAAAP3aGbAAAFNUlEQVR4nO3UMQ0AIADAMEAI/qUgCwt8ZEmrYNfm2XsAFKzfAQCvDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwg4wJyZAQkd7kafwAAAABJRU5ErkJggg==")), "file", "p.png"); return f; }
        Assert.False((await buyer.Get("/api/returns/reasons")).Json["photos"]!["enabled"]!.GetValue<bool>());
        Assert.Equal("photos_off", (await buyer.Post("/api/returns", new { sub_order_id = subId, items, reason = "damaged", refund_upi = "r@okaxis", photos = new[] { "http://x/y.png" } })).ErrorCode);
        Assert.Equal("photos_off", (await buyer.Post("/api/returns/photos", Form())).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { return_photos = new { enabled = true, required_for_defects = true, max_photos = 2 } })).Status);
        var cfg = (await buyer.Get("/api/returns/reasons")).Json["photos"]!;
        Assert.Equal(2, cfg["max"]!.GetValue<int>()); Assert.True(cfg["required_for_defects"]!.GetValue<bool>());
        Assert.Equal("photos_required", (await buyer.Post("/api/returns", new { sub_order_id = subId, items, reason = "damaged", refund_upi = "r@okaxis" })).ErrorCode);
        Assert.Equal("invalid_photos", (await buyer.Post("/api/returns", new { sub_order_id = subId, items, reason = "damaged", refund_upi = "r@okaxis", photos = new[] { "https://elsewhere.example/a.png" } })).ErrorCode);
        var up = await buyer.Post("/api/returns/photos", Form()); Assert.True(up.Status == 201, up.ToString());
        var url = up.Json["url"]!.GetValue<string>(); Assert.Contains("/return-photos/", url);
        Assert.Equal("invalid_photos", (await buyer.Post("/api/returns", new { sub_order_id = subId, items, reason = "damaged", refund_upi = "r@okaxis", photos = new[] { url, url + "?a", url + "?b" } })).ErrorCode);
        // a valid photo passes the photo checks; the order is not delivered yet, so the item itself is refused
        Assert.Equal("not_returnable", (await buyer.Post("/api/returns", new { sub_order_id = subId, items, reason = "damaged", refund_upi = "r@okaxis", photos = new[] { url } })).ErrorCode);
    }

    [Fact]
    public async Task Staff_can_rename_and_switch_off_return_reasons()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000304", "reasons-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000071", "Reasons Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(o.Status == 201, o.ToString());
        var subId = o.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
        static string[] Codes(Res r) => r.Json["reasons"]!.AsArray().Select(x => x!["code"]!.GetValue<string>()).ToArray();
        Assert.Contains("quality", Codes(await buyer.Get("/api/returns/reasons")));
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { return_reasons = new { label_size_fit = "Does not fit me", off_quality = true } })).Status);
        var r = await buyer.Get("/api/returns/reasons");
        Assert.DoesNotContain("quality", Codes(r)); Assert.Equal(6, Codes(r).Length);
        Assert.Equal("Does not fit me", r.Json["reasons"]!.AsArray().First(x => x!["code"]!.GetValue<string>() == "size_fit")!["label"]!.GetValue<string>());
        var body = new { sub_order_id = subId, items = new[] { new { order_item_id = Guid.NewGuid(), qty = 1 } }, reason = "quality", refund_upi = "r@okaxis" };
        Assert.Equal("invalid_reason", (await buyer.Post("/api/returns", body)).ErrorCode);
        Assert.NotEqual("invalid_reason", (await buyer.Post("/api/returns", new { body.sub_order_id, body.items, reason = "size_fit", body.refund_upi })).ErrorCode);
    }

    [Fact]
    public async Task Staff_can_make_a_batch_of_single_use_codes_from_a_coupon()
    {
        var admin = await Admin();
        var made = await admin.Post("/api/admin/coupons", new { code = "SPRING10", description = "", kind = "percent", value = 1000, max_discount_paise = 50000, min_order_paise = 0, usage_limit = 500, per_user_limit = 1, is_active = true, show_on_checkout = true });
        Assert.True(made.Status == 201, made.ToString());
        var cid = made.Json["id"]!.GetValue<string>();
        var r = await admin.Post($"/api/admin/coupons/{cid}/generate", new { count = 5, prefix = "mail" });
        Assert.True(r.Status == 201, r.ToString());
        var codes = r.Json["codes"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.Equal(5, codes.Distinct().Count()); Assert.All(codes, c => { Assert.StartsWith("MAIL", c); Assert.Equal(10, c.Length); });
        var rows = await ApiFactory.DbQueryAsync<(string Code, int? Limit, int Value, bool OnList)>("SELECT code AS Code, usage_limit AS `Limit`, value AS Value, show_on_checkout AS OnList FROM coupons WHERE code LIKE 'MAIL%' OR code = 'SPRING10'");
        Assert.All(rows.Where(x => x.Code.StartsWith("MAIL")), x => { Assert.Equal(1, x.Limit); Assert.Equal(1000, x.Value); Assert.False(x.OnList); });
        Assert.Equal(500, rows.First(x => x.Code == "SPRING10").Limit);
        Assert.Equal("invalid_count", (await admin.Post($"/api/admin/coupons/{cid}/generate", new { count = 201, prefix = "mail" })).ErrorCode);
        Assert.Equal("invalid_prefix", (await admin.Post($"/api/admin/coupons/{cid}/generate", new { count = 1, prefix = "a!" })).ErrorCode);
        Assert.Equal(404, (await admin.Post($"/api/admin/coupons/{Guid.Empty}/generate", new { count = 1, prefix = "mail" })).Status);
        var nobody = await LoginPhone("9770000081", "Nobody");
        Assert.Equal(403, (await nobody.Post($"/api/admin/coupons/{cid}/generate", new { count = 1, prefix = "mail" })).Status);
    }

    [Fact]
    public async Task Staff_notes_on_an_order_are_private_to_staff()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000305", "notes-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000091", "Note Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(o.Status == 201, o.ToString());
        var oid = o.Json["order"]!["id"]!.GetValue<string>();
        var url = $"/api/admin/orders/{oid}/notes";
        Assert.Empty((await admin.Get(url)).Json["items"]!.AsArray());
        var r = await admin.Post(url, new { note = "  Customer called,   wants the   parcel before Friday " });
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal("Customer called, wants the parcel before Friday", r.Json["note"]!.GetValue<string>());
        await admin.Post(url, new { note = "Told the seller" });
        var items = (await admin.Get(url)).Json["items"]!.AsArray();
        Assert.Equal(2, items.Count); Assert.Equal("Told the seller", items[1]!["note"]!.GetValue<string>()); Assert.NotEmpty(items[0]!["author"]!.GetValue<string>());
        Assert.Equal("invalid_note", (await admin.Post(url, new { note = "   " })).ErrorCode);
        Assert.Equal(422, (await admin.Post(url, new { note = new string('x', 1001) })).Status);
        Assert.Equal(404, (await admin.Post($"/api/admin/orders/{Guid.Empty}/notes", new { note = "hi" })).Status);
        Assert.Equal(403, (await buyer.Get(url)).Status); Assert.Equal(403, (await buyer.Post(url, new { note = "sneaky" })).Status);
        Assert.DoesNotContain("Customer called", (await buyer.Get($"/api/orders/{oid}")).ToString());
        Assert.Equal(2, (await admin.Get(url)).Json["items"]!.AsArray().Count);
    }

    [Fact]
    public async Task Review_reminder_goes_once_per_delivered_package_that_is_not_reviewed()
    {
        var admin = await Admin();
        var (variantId, productId, slug) = await ShirtInStock("9400000306", "remind-shirt");
        await Refresh(productId);
        var a = await LoginPhone("9770000101", "Reminder A"); var b = await LoginPhone("9770000102", "Reminder B"); var c = await LoginPhone("9770000103", "Reminder C");
        async Task<string> Order(dynamic who, int daysAgo)
        {
            var addr = await AddAddress(who, state: "33");
            await who.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
            var o = await who.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
            Assert.True(o.Status == 201, o.ToString());
            var sid = o.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
            await ApiFactory.DbExecAsync("UPDATE sub_orders SET status = 'delivered', delivered_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL @d DAY) WHERE id = @sid", new { d = daysAgo, sid });
            return sid;
        }
        var sa = await Order(a, 6); var sb = await Order(b, 1); var sc = await Order(c, 6);
        await ApiFactory.DbExecAsync("INSERT INTO reviews (id, product_id, user_id, sub_order_id, verified, rating, title, body, status, seller_reply, helpful_count, created_at, updated_at) SELECT UUID(), @productId, @uid, @sc, 1, 5, 'Good', 'Fits well', 'published', '', 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)", new { productId, uid = Guid.Parse(c.Id), sc });
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var notify = scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        Task<int> Run() => ReviewReminders.SendDueAsync(db, notify);
        async Task<long> Count(string who) => await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE user_id = @uid AND event = 'review_reminder' AND channel = 'inapp'", new { uid = Guid.Parse(who) });
        Assert.Equal(0, await Run()); Assert.Equal(0, await Count(a.Id));
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { review_reminders = new { enabled = true, after_days = 5, max_age_days = 30 } })).Status);
        Assert.Equal(1, await Run());
        Assert.Equal(1, await Count(a.Id)); Assert.Equal(0, await Count(b.Id)); Assert.Equal(0, await Count(c.Id));
        Assert.EndsWith("#reviews", await db.ExecuteScalarAsync<string>("SELECT link FROM notifications WHERE user_id = @uid AND event = 'review_reminder'", new { uid = Guid.Parse(a.Id) }));
        Assert.Equal(0, await Run());
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET delivered_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 6 DAY) WHERE id = @sb", new { sb });
        Assert.Equal(200, (await b.Patch("/api/auth/me", new { email = "reviewer@example.in" })).Status);
        Assert.Equal(200, (await admin.Put("/api/admin/integrations/email", new { values = new { host = "smtp.example.in", from_address = "orders@example.in" }, enabled = true, password = AdminPassword })).Status);
        Assert.Equal(1, await Run()); Assert.Equal(1, await Count(b.Id));
        var mail = await db.QueryAsync<string>("SELECT body FROM notifications WHERE user_id = @uid AND event = 'review_reminder' AND channel = 'email'", new { uid = Guid.Parse(b.Id) });
        Assert.Single(mail); Assert.Contains("#reviews", mail.Single()); // email goes too, with the review link
    }

    [Fact]
    public async Task Seller_can_set_own_free_delivery_amount_within_admin_bounds()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000307", "own-free-shirt");
        await Refresh(productId);
        var seller = await LoginPhone("9400000307", "Kovai Owner");
        var buyer = await LoginPhone("9770000111", "Own Free Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        async Task<(long Ship, long Gap)> Quote()
        {
            var g = (await buyer.Post("/api/checkout/quote", new { address_id = addr, payment_method = "cod" })).Json["groups"]![0]!;
            return (g["shipping_fee"]!.GetValue<long>(), g["free_shipping_gap"]!.GetValue<long>());
        }
        Task<Res> Prefs(object value) => seller.Put("/api/seller/preferences", value);
        var (baseShip, baseGap) = await Quote();
        Assert.Equal("seller_shipping_off", (await Prefs(new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 20000 })).ErrorCode);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = true, min_paise = 0, max_paise = 5000000 } })).Status);
        Assert.Equal("threshold_out_of_range", (await Prefs(new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 6000000 })).ErrorCode);
        Assert.Equal(5000000, (await seller.Get("/api/seller/preferences")).Json["free_shipping_bounds"]!["max_paise"]!.GetValue<long>());
        var big = await Prefs(new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 5000000 });
        Assert.True(big.Status == 200, big.ToString());
        Assert.Equal(5000000, big.Json["free_shipping_threshold_paise"]!.GetValue<long>());
        async Task<long> PdpAmount() => (await buyer.Get("/api/catalog/products/own-free-shirt")).Json["seller"]!["free_shipping_threshold_paise"]!.GetValue<long>();
        Assert.Equal(5000000, await PdpAmount()); // the product page shows this seller's own amount
        var (s1, g1) = await Quote(); Assert.True(s1 > 0 && g1 > 0, $"ship {s1} gap {g1}");
        var zero = await Prefs(new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 0 });
        Assert.Equal(200, zero.Status);
        var (s2, g2) = await Quote(); Assert.Equal(0, s2); Assert.Equal(0, g2);
        var keep = await Prefs(new { dispatch_days = 2, holiday_mode = false });
        Assert.Equal(0, keep.Json["free_shipping_threshold_paise"]!.GetValue<long>());
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { min_paise = 4000000 } })).Status);
        Assert.True((await Quote()).Ship > 0);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = false } })).Status);
        Assert.Equal((baseShip, baseGap), await Quote());
        Assert.NotEqual(5000000, await PdpAmount()); // module off: the marketplace amount again
        Assert.Equal(200, (await Prefs(new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 0 })).Status); // the stored value sent back while off is fine
        Assert.Null((await seller.Get("/api/seller/preferences")).Json["free_shipping_bounds"]);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = true, min_paise = 0 } })).Status);
        var cleared = await Prefs(new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = (long?)null });
        Assert.Equal(200, cleared.Status); Assert.Null(cleared.Json["free_shipping_threshold_paise"]);
        Assert.Equal((baseShip, baseGap), await Quote());
    }

    [Fact]
    public async Task Ship_reminder_goes_once_to_the_seller_of_a_confirmed_package_that_has_not_shipped()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000311", "ship-remind-shirt");
        await Refresh(productId);
        var a = await LoginPhone("9770000141", "Ship Reminder A");
        async Task<string> Order(string status, int hoursAgo)
        {
            var addr = await AddAddress(a, state: "33");
            await a.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
            var o = await a.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
            Assert.True(o.Status == 201, o.ToString());
            var sid = o.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
            await ApiFactory.DbExecAsync("UPDATE sub_orders SET status = @status, confirmed_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL @h HOUR) WHERE id = @sid", new { status, h = hoursAgo, sid });
            return sid;
        }
        var s1 = await Order("confirmed", 30); var s2 = await Order("packed", 2); var s3 = await Order("shipped", 40);
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var notify = scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        Task<int> Run() => ShipReminders.SendDueAsync(db, notify);
        async Task<long> Count() => await db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE event = 'seller_ship_reminder' AND channel = 'inapp'", new { });
        Assert.Equal(0, await Run()); Assert.Equal(0, await Count());
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { ship_reminders = new { enabled = true, after_hours = 24, max_age_days = 14 } })).Status);
        var owner = await LoginPhone("9400000311", "Ship Owner");
        Assert.Equal(200, (await owner.Patch("/api/auth/me", new { email = "shipowner@example.in" })).Status);
        Assert.Equal(200, (await admin.Put("/api/admin/integrations/email", new { values = new { host = "smtp.example.in", from_address = "orders@example.in" }, enabled = true, password = AdminPassword })).Status);
        Assert.Equal(1, await Run()); Assert.Equal(1, await Count()); // only the confirmed package from 30 hours ago
        var mail = await db.QueryAsync<string>("SELECT body FROM notifications WHERE event = 'seller_ship_reminder' AND channel = 'email'", new { });
        Assert.Single(mail); Assert.Contains("/seller/orders/", mail.Single()); // the seller gets an email too
        Assert.Equal(0, await Run());
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET confirmed_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 25 HOUR) WHERE id = @s2", new { s2 });
        Assert.Equal(1, await Run()); Assert.Equal(2, await Count());
    }

    [Fact]
    public async Task Bought_together_lists_products_from_the_same_orders_and_is_off_by_default()
    {
        var admin = await Admin();
        var (v1, p1, _) = await ShirtInStock("9400000321", "together-shirt-a");
        var (v2, p2, _) = await ShirtInStock("9400000322", "together-shirt-b", "33KOVAI1235K1Z");
        await Refresh(p1); await Refresh(p2);
        var buyer = await LoginPhone("9770000151", "Together Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = v1, qty = 1 });
        await buyer.Post("/api/cart/items", new { variant_id = v2, qty = 1 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(o.Status == 201, o.ToString());
        async Task<List<string>> Together(string slug) =>
            (await buyer.Get($"/api/catalog/products/{slug}")).Json["bought_together"]!.AsArray().Select(c => c!["slug"]!.GetValue<string>()).ToList();
        Assert.Empty(await Together("together-shirt-a")); // switched off
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { bought_together = new { enabled = true, max_items = 4 } })).Status);
        Assert.Equal(["together-shirt-b"], await Together("together-shirt-a"));
        Assert.Equal(["together-shirt-a"], await Together("together-shirt-b"));
    }

    [Fact]
    public async Task Tier_free_delivery_waives_shipping_for_silver_and_gold_members()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000331", "tier-free-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000161", "Tier Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        async Task<(long Cart, long Quote)> Ship() => (
            (await buyer.Get("/api/cart")).Json["summary"]!["shipping_total"]!.GetValue<long>(),
            (await buyer.Post("/api/checkout/quote", new { address_id = addr, payment_method = "cod" })).Json["summary"]!["shipping_total"]!.GetValue<long>());
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = true, min_paise = 0, max_paise = 5000000 } })).Status);
        var owner = await LoginPhone("9400000331", "Tier Owner");
        Assert.Equal(200, (await owner.Put("/api/seller/preferences", new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 5000000 })).Status); // the shirt must pay delivery
        var baseline = await Ship();
        Assert.True(baseline.Cart > 0 && baseline.Cart == baseline.Quote, baseline.ToString());
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, tier_silver_points = 500, tier_gold_points = 2000, silver_free_delivery = true } })).Status);
        Assert.Equal(baseline, await Ship()); // still a plain member
        await ApiFactory.DbExecAsync("INSERT INTO loyalty_ledger (id, user_id, kind, points, note, created_at) VALUES (UUID(), @uid, 'earn', 600, 'test', UTC_TIMESTAMP(6))", new { uid = buyer.Id });
        Assert.Equal((0L, 0L), await Ship()); // silver
        Assert.True((await buyer.Get("/api/loyalty")).Json["free_delivery"]!.GetValue<bool>()); // the rewards page can say so
        var est = (await buyer.Get($"/api/catalog/delivery-estimate?variant_id={variantId}&pincode=641001")).Json;
        Assert.True(est["member_free_delivery"]!.GetValue<bool>()); Assert.Equal(0, est["delivery_fee_paise"]!.GetValue<long>()); // the product page agrees
        var visitor = (await Factory.CreateClient().GetFromJsonAsync<JsonObject>($"/api/catalog/delivery-estimate?variant_id={variantId}&pincode=641001"))!;
        Assert.True(visitor["delivery_fee_paise"]!.GetValue<long>() > 0); // a visitor still sees the fee
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, silver_free_delivery = false, gold_free_delivery = true } })).Status);
        Assert.Equal(baseline, await Ship()); // silver no longer has it, gold only
        Assert.False((await buyer.Get("/api/loyalty")).Json["free_delivery"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Review_bonus_points_once_per_delivered_package_only_for_a_real_review()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000341", "review-bonus-shirt");
        await Refresh(productId);
        var a = await LoginPhone("9770000171", "Review Bonus A");
        var addr = await AddAddress(a, state: "33");
        await a.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var o = await a.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(o.Status == 201, o.ToString());
        var sid = o.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET status = 'delivered', delivered_at = UTC_TIMESTAMP(6) WHERE id = @sid", new { sid });
        const string text = "Works well, fits true to size and the cotton feels good.";
        async Task<int> Put(string body, int rating = 5) => (await a.Put("/api/catalog/products/review-bonus-shirt/reviews", new { rating, title = "Good", body })).Status;
        async Task<long> Balance() => (await a.Get("/api/loyalty")).Json["balance"]!.GetValue<long>();
        Assert.True(await Put(text) is 200 or 201); Assert.Equal(0, await Balance()); // switched off
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, review_points = 25, review_min_chars = 30 } })).Status);
        Assert.True(await Put("Nice") is 200 or 201); Assert.Equal(0, await Balance()); // too short
        Assert.True(await Put(text) is 200 or 201); Assert.Equal(25, await Balance());
        Assert.True(await Put(text + " Edited.", 4) is 200 or 201); Assert.Equal(25, await Balance()); // once
        Assert.StartsWith("Review bonus", (await a.Get("/api/loyalty")).Json["history"]![0]!["note"]!.GetValue<string>());
        Assert.Equal(200, (await a.Delete("/api/catalog/products/review-bonus-shirt/reviews")).Status); Assert.Equal(0, await Balance()); // deleting the review takes the bonus back
        Assert.True(await Put(text) is 200 or 201); Assert.Equal(0, await Balance()); // and writing it again does not pay twice
        var rid = await ApiFactory.DbScalarAsync<string>("SELECT CAST(id AS CHAR) FROM reviews WHERE sub_order_id = @sid", new { sid });
        Assert.Equal(200, (await admin.Post($"/api/admin/reviews/{rid}/hide", new { })).Status); Assert.Equal(0, await Balance()); // hidden: bonus taken back
        Assert.Equal(200, (await admin.Post($"/api/admin/reviews/{rid}/publish", new { })).Status); Assert.Equal(0, await Balance()); // and not paid twice
    }

    [Fact]
    public async Task Pincode_check_on_the_product_page_follows_the_same_delivery_rules_as_checkout()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000312", "pin-check-shirt");
        await Refresh(productId);
        var seller = await LoginPhone("9400000312", "Pin Owner");
        async Task<(long Fee, long From)> Est(string pin)
        {
            var j = (await Factory.CreateClient().GetFromJsonAsync<JsonObject>($"/api/catalog/delivery-estimate?variant_id={variantId}&pincode={pin}"))!;
            return (j["delivery_fee_paise"]!.GetValue<long>(), j["free_delivery_from_paise"]!.GetValue<long>());
        }
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = true, min_paise = 0, max_paise = 5000000 } })).Status);
        Assert.Equal(200, (await seller.Put("/api/seller/preferences", new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 5000000 })).Status); // the shirt must pay delivery
        var (baseFee, baseFrom) = await Est("560001"); Assert.True(baseFee > 0); Assert.Equal(5000000, baseFrom); // the seller's own amount
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { enabled = true, state_fees = "29:9000", remote_prefixes = "5600", remote_surcharge_paise = 6000 } })).Status);
        Assert.Equal(15000, (await Est("560001")).Fee); // state fee plus the remote-area surcharge
        Assert.Equal(baseFee, (await Est("600002")).Fee); // unlisted state, not remote
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { state_free_above = "29:1" } })).Status);
        // the seller's own amount still wins over the by-state amount
        Assert.Equal((15000L, 5000000L), await Est("560001"));
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = false } })).Status);
        Assert.Equal((0L, 1L), await Est("560001")); // now the by-state amount applies: this shirt ships free there
    }

    [Fact]
    public async Task Seller_orders_list_counts_open_orders_older_than_the_dispatch_time()
    {
        var (variantId, productId, _) = await ShirtInStock("9400000313", "late-count-shirt");
        await Refresh(productId);
        var seller = await LoginPhone("9400000313", "Late Owner");
        var buyer = await LoginPhone("9770000150", "Late Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.Equal(201, o.Status);
        var sid = o.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
        var r = (await seller.Get("/api/seller/orders")).Json;
        Assert.Equal(0, r["late_count"]!.GetValue<int>()); var days = r["late_after_days"]!.GetValue<int>(); Assert.True(days >= 1);
        await ApiFactory.DbExecAsync("UPDATE sub_orders SET created_at = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL @d DAY) WHERE id = @sid", new { d = days + 1, sid });
        Assert.Equal(1, (await seller.Get("/api/seller/orders")).Json["late_count"]!.GetValue<int>());
        var staff = await Admin();
        Assert.Equal(1, (await staff.Get("/api/admin/dashboard")).Json["orders_late_to_ship"]!.GetValue<int>()); // staff see it too
        Assert.Equal(1, (await staff.Get("/api/admin/orders?late=1")).Json["total"]!.GetValue<int>()); // and can open the list behind that number
        Assert.Equal(200, (await seller.Post($"/api/seller/orders/{sid}/confirm")).Status);
        Assert.Equal(1, (await seller.Get("/api/seller/orders")).Json["late_count"]!.GetValue<int>());
        Assert.Equal(200, (await seller.Post($"/api/seller/orders/{sid}/pack")).Status);
        Assert.Equal(200, (await seller.Post($"/api/seller/orders/{sid}/ship", new { courier_name = "DTDC", tracking_number = "AWB9" })).Status);
        Assert.Equal(0, (await seller.Get("/api/seller/orders")).Json["late_count"]!.GetValue<int>()); // shipped: no longer waiting on the seller
        Assert.Equal(0, (await staff.Get("/api/admin/dashboard")).Json["orders_late_to_ship"]!.GetValue<int>());
        Assert.Equal(0, (await staff.Get("/api/admin/orders?late=1")).Json["total"]!.GetValue<int>());
    }

    [Fact]
    public async Task Order_again_puts_the_items_of_a_past_order_back_in_the_cart()
    {
        var (variantId, productId, _) = await ShirtInStock("9400000310", "order-again-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000130", "Again Buyer");
        var addr = await AddAddress(buyer, state: "33");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 2 });
        var o = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.Equal(201, o.Status);
        var oid = o.Json["order"]!["id"]!.GetValue<string>();
        Assert.Empty((await buyer.Get("/api/cart")).Json["groups"]!.AsArray());
        var r = await buyer.Post($"/api/cart/reorder/{oid}", new { });
        Assert.Equal(1, r.Json["added"]!.GetValue<int>()); Assert.Empty(r.Json["skipped"]!.AsArray());
        Assert.Equal(2, r.Json["groups"]![0]!["lines"]![0]!["qty"]!.GetValue<int>());
        await buyer.Put("/api/cart/items", new { variant_id = variantId, qty = 0 });
        await ApiFactory.DbExecAsync("UPDATE variants SET stock = 0 WHERE id = @variantId", new { variantId });
        r = await buyer.Post($"/api/cart/reorder/{oid}", new { });
        Assert.Equal(0, r.Json["added"]!.GetValue<int>()); Assert.Equal("This item is out of stock", r.Json["skipped"]![0]!["reason"]!.GetValue<string>());
        var other = await LoginPhone("9770000131", "Other Buyer");
        Assert.Equal(404, (await other.Post($"/api/cart/reorder/{oid}", new { })).Status);
        Assert.Equal(404, (await buyer.Post($"/api/cart/reorder/{Guid.NewGuid()}", new { })).Status);
    }

    [Fact]
    public async Task Free_delivery_amount_can_differ_by_destination_state()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000309", "state-free-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000122", "State Free Buyer");
        var home = await AddAddress(buyer, state: "33");
        var other = await AddAddress(buyer, state: "29", pincode: "560001");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        async Task<long> Ship(string addr) => (await buyer.Post("/api/checkout/quote", new { address_id = addr, payment_method = "cod" })).Json["groups"]![0]!["shipping_fee"]!.GetValue<long>();
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { enabled = true, state_free_above = "29:90000000" } })).Status);
        var high = await Ship(other); Assert.True(high > 0); // a very high amount in that state: the package pays
        Assert.Equal(0, await Ship(home)); // the other state keeps the marketplace amount (this package ships free there)
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { state_free_above = "29:1, 99 : 5, junk" } })).Status);
        Assert.Equal(0, await Ship(other)); Assert.Equal(0, await Ship(home));
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { enabled = false } })).Status);
        Assert.Equal(0, await Ship(other)); // switched off: the marketplace amount again
    }

    [Fact]
    public async Task Delivery_fee_can_differ_by_destination_state()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000308", "state-fee-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000121", "State Fee Buyer");
        var home = await AddAddress(buyer, state: "33");
        var other = await AddAddress(buyer, state: "29", pincode: "560001");
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        async Task<(long Ship, long Total)> Quote(string addr)
        {
            var q = (await buyer.Post("/api/checkout/quote", new { address_id = addr, payment_method = "cod" })).Json;
            return (q["groups"]![0]!["shipping_fee"]!.GetValue<long>(), q["summary"]!["grand_total"]!.GetValue<long>());
        }
        var (baseShip, _) = await Quote(other);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { seller_shipping = new { enabled = true, min_paise = 0, max_paise = 5000000 } })).Status);
        var seller = await LoginPhone("9400000308", "Kovai Owner");
        Assert.Equal(200, (await seller.Put("/api/seller/preferences", new { dispatch_days = 2, holiday_mode = false, free_shipping_threshold_paise = 5000000 })).Status); // the package must pay delivery
        var (paying, _) = await Quote(other); Assert.True(paying > 0);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { shipping_zones = new { enabled = true, state_fees = "29:9000, 99 : 1, junk" } })).Status);
        Assert.Equal(paying, (await Quote(home)).Ship); // state not listed: the marketplace fee
        var (ship, total) = await Quote(other); Assert.Equal(9000, ship);
        var r = await buyer.Post("/api/orders", new { address_id = other, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), expected_total = total });
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(total, r.Json["order"]!["grand_total"]!.GetValue<long>());
    }

    [Fact]
    public async Task Unused_points_expire_after_expiry_days_oldest_first()
    {
        var admin = await Admin();
        var buyer = await LoginPhone("9770000191", "Expiry Buyer");
        var uid = Guid.Parse(buyer.Id);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, expiry_days = 30 } })).Status);
        async Task Row(string kind, int points, string note, int daysAgo) => await ApiFactory.DbExecAsync(
            "INSERT INTO loyalty_ledger (id, user_id, kind, points, note, created_at) VALUES (@id, @uid, @kind, @points, @note, @at)",
            new { id = Guid.NewGuid(), uid, kind, points, note, at = DateTime.UtcNow.AddDays(-daysAgo) });
        await Row("earn", 100, "old", 60); await Row("redeem", -30, "spent", 50); await Row("earn", 40, "recent", 5);
        var me = (await buyer.Get("/api/loyalty")).Json;
        Assert.Equal(40, me["balance"]!.GetValue<long>()); // 100 - 30 spent = 70 lapse; the recent 40 stays
        Assert.StartsWith("Points expired", me["history"]![0]!["note"]!.GetValue<string>());
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { expiry_days = 90 } })).Status);
        Assert.Equal(0, (await buyer.Get("/api/loyalty")).Json["expiring_soon"]!.GetValue<long>());
        await Row("earn", 15, "aging", 70);
        me = (await buyer.Get("/api/loyalty")).Json;
        Assert.Equal(15, me["expiring_soon"]!.GetValue<long>()); Assert.Equal(30, me["expiring_days"]!.GetValue<int>()); // 70 days old of 90: lapses in 20 days, inside the window
        Assert.Equal(55, me["balance"]!.GetValue<long>()); // lapses once
    }

    [Fact]
    public async Task Cod_is_blocked_after_repeated_undelivered_cash_packages()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000351", "cod-refused-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9770000201", "Refusing Buyer");
        var addr = await AddAddress(buyer, state: "33");
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { cod_risk = new { enabled = true, max_cod_paise = 0, new_account_max_cod_paise = 0, block_after_refused = 2 } })).Status);
        async Task<Res> Order(string method)
        {
            await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
            return await buyer.Post("/api/orders", new { address_id = addr, payment_method = method, idempotency_key = Guid.NewGuid().ToString("N") });
        }
        for (var n = 0; n < 2; n++)
        {
            var r = await Order("cod");
            Assert.True(r.Status == 201, r.ToString());
            var sid = r.Json["order"]!["sub_orders"]![0]!["id"]!.GetValue<string>();
            await ApiFactory.DbExecAsync("UPDATE sub_orders SET status = 'cancelled', cancel_reason = 'Returned to the seller by the courier (RTO)' WHERE id = @sid", new { sid });
        }
        var blocked = await Order("cod");
        Assert.Equal(400, blocked.Status); Assert.Equal("cod_risk", blocked.ErrorCode);
        Assert.NotEqual("cod_risk", (await Order("online")).ErrorCode); // paying online is never blocked by this rule
    }

    [Fact]
    public async Task Deal_countdown_can_be_switched_off_in_flash_sale_settings()
    {
        var admin = await Admin();
        var (variantId, productId, sellerId) = await ShirtInStock("9400000361", "countdown-shirt");
        await Refresh(productId);
        await ApiFactory.DbExecAsync(
            "INSERT INTO deals (id, seller_id, product_id, variant_id, kind, deal_price_paise, regular_price_paise, starts_at, ends_at, sold_qty, status, note) " +
            "VALUES (@id, @sellerId, @productId, @variantId, 'lightning', 100, 200, @s, @e, 0, 'active', '')",
            new { id = Guid.NewGuid(), sellerId, productId, variantId, s = DateTime.UtcNow.AddHours(-1), e = DateTime.UtcNow.AddHours(5) });
        var visitor = Factory.CreateClient();
        async Task<bool> Shown() => (await visitor.GetFromJsonAsync<JsonObject>("/api/catalog/products/countdown-shirt"))!["deal"]!["show_countdown"]!.GetValue<bool>();
        Assert.True(await Shown()); // on by default
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { flash_sales = new { show_countdown = false } })).Status);
        Assert.False(await Shown());
    }

    [Fact]
    public async Task Points_expiry_reminder_goes_out_once_per_window()
    {
        var admin = await Admin();
        var buyer = await LoginPhone("9770000211", "Reminder Buyer");
        var uid = Guid.Parse(buyer.Id);
        await ApiFactory.DbExecAsync("INSERT INTO loyalty_ledger (id, user_id, kind, points, note, created_at) VALUES (@id, @uid, 'earn', 15, 'aging', @at)",
            new { id = Guid.NewGuid(), uid, at = DateTime.UtcNow.AddDays(-70) });
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var notify = scope.ServiceProvider.GetRequiredService<ICatalogNotifyBAL>();
        async Task<long> Mine() => await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM notifications WHERE user_id = @uid AND event = 'points_expiring' AND channel = 'inapp'", new { uid });
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, expiry_days = 90 } })).Status);
        Assert.Equal(0, await LoyaltyPoints.SendExpiryRemindersAsync(db, notify)); Assert.Equal(0, await Mine()); // reminder switched off
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { expiry_reminder = true } })).Status);
        Assert.True(await LoyaltyPoints.SendExpiryRemindersAsync(db, notify) >= 1); Assert.Equal(1, await Mine()); // 70 days old of 90: lapses in 20 days
        Assert.Equal(0, await LoyaltyPoints.SendExpiryRemindersAsync(db, notify)); Assert.Equal(1, await Mine()); // once per 30 day window
    }

    [Fact]
    public async Task Admin_loyalty_overview_shows_points_held_and_the_last_30_days()
    {
        var admin = await Admin();
        var buyer = await LoginPhone("9770000221", "Overview Buyer");
        var uid = Guid.Parse(buyer.Id);
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { loyalty = new { enabled = true, point_value_paise = 100 } })).Status);
        var b = (await admin.Get("/api/admin/growth/loyalty")).Json;
        foreach (var (kind, pts, note, days) in new[] { ("earn", 100, "a", 2), ("redeem", -30, "b", 1), ("earn", 50, "old", 90), ("reverse", -20, "Points expired (not used within 30 days)", 3) })
            await ApiFactory.DbExecAsync("INSERT INTO loyalty_ledger (id, user_id, kind, points, note, created_at) VALUES (@id, @uid, @kind, @pts, @note, @at)",
                new { id = Guid.NewGuid(), uid, kind, pts, note, at = DateTime.UtcNow.AddDays(-days) });
        var me = (await admin.Get("/api/admin/growth/loyalty")).Json;
        long D(string k) => me[k]!.GetValue<long>() - b[k]!.GetValue<long>();
        Assert.Equal(100, D("points_held")); Assert.Equal(1, D("members_with_points")); Assert.Equal(10000, D("value_held_paise")); // 100 - 30 + 50 - 20
        Assert.Equal(100, D("earned_30d")); Assert.Equal(30, D("redeemed_30d")); Assert.Equal(20, D("expired_30d"));
        var mine = (await admin.Get($"/api/admin/growth/loyalty/{uid}")).Json;
        Assert.Equal(100, mine["balance"]!.GetValue<long>()); // one member's view for the customer page
        Assert.Equal(403, (await buyer.Get($"/api/admin/growth/loyalty/{uid}")).Status);
        Assert.Equal(403, (await buyer.Get("/api/admin/growth/loyalty")).Status); // staff only
    }

    [Fact]
    public async Task Gift_message_is_off_until_admin_allows_it_then_rides_on_the_order()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000611", "giftmsg-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000611", "Gift Msg Buyer");
        var addr = await AddAddress(buyer, state: "33");
        async Task<Res> Place(string msg)
        {
            await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
            return await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), gift_message = msg });
        }
        Assert.False((await buyer.Get("/api/cart")).Json["checkout"]!["gift_message_enabled"]!.GetValue<bool>());
        var r = await Place("Happy birthday!");
        Assert.Equal(400, r.Status); Assert.Equal("gift_off", r.Json["error"]!["code"]!.GetValue<string>());
        r = await admin.Put("/api/admin/checkout", new { fees = new { gift_message_enabled = true, gift_message_max = 30 } });
        Assert.True(r.Status == 200, r.ToString());
        var chk = (await buyer.Get("/api/cart")).Json["checkout"]!;
        Assert.True(chk["gift_message_enabled"]!.GetValue<bool>()); Assert.Equal(30, chk["gift_message_max"]!.GetValue<int>());
        r = await Place(new string('x', 31));
        Assert.Equal(400, r.Status); Assert.Equal("gift_too_long", r.Json["error"]!["code"]!.GetValue<string>());
        r = await Place("  Happy   birthday, Meena!  ");
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal("Happy birthday, Meena!", r.Json["order"]!["ship_to"]!["gift_message"]!.GetValue<string>());
        Assert.Equal(400, (await admin.Put("/api/admin/checkout", new { fees = new { gift_message_max = 10 } })).Status);
    }

    [Fact]
    public async Task Category_size_guide_shows_on_the_product_page_and_is_inherited()
    {
        var admin = await Admin();
        var (_, productId, _) = await ShirtInStock("9400000612", "sizeguide-shirt");
        await Refresh(productId);
        var slug = await ApiFactory.DbScalarAsync<string>("SELECT slug FROM products WHERE id = @productId", new { productId });
        var parent = await ApiFactory.DbScalarAsync<Guid>("SELECT category_id FROM products WHERE id = @productId", new { productId });
        Assert.Null((await admin.Get($"/api/catalog/products/{slug}")).Json["size_guide"]);
        object Body(string name, string guide) => new { name, commission_bps = 1000, default_gst_bps = 500, size_guide = guide, return_window_days = 7 };

        var r = await admin.Put($"/api/admin/categories/{parent}", Body("Shirts", "Size|Chest (in)\n S |  38\nM|40\n\n"));
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal("Size | Chest (in)\nS | 38\nM | 40", r.Json["size_guide"]!.GetValue<string>());
        var guide = (await admin.Get($"/api/catalog/products/{slug}")).Json["size_guide"]!.AsArray();
        Assert.Equal(3, guide.Count); Assert.Equal("Chest (in)", guide[0]![1]!.GetValue<string>()); Assert.Equal("40", guide[2]![1]!.GetValue<string>());

        // the product moves to a sub-category without its own guide: the parent's guide still shows
        var child = Guid.NewGuid();
        await ApiFactory.DbExecAsync("INSERT INTO categories (id, parent_id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active, required_details, return_window_days, min_return_window_days, created_at, updated_at) VALUES (@child, @parent, 'Formal', 'formal-sg', '', 1000, 500, 0, 1, CAST('[]' AS JSON), 7, 0, @now, @now)", new { child, parent, now = Now });
        await ApiFactory.DbExecAsync("UPDATE products SET category_id = @child WHERE id = @productId", new { child, productId });
        Assert.Equal(3, (await admin.Get($"/api/catalog/products/{slug}")).Json["size_guide"]!.AsArray().Count);
        Assert.Equal(200, (await admin.Put($"/api/admin/categories/{child}", Body("Formal", "Size|Waist\nL|34"))).Status);
        Assert.Equal("Waist", (await admin.Get($"/api/catalog/products/{slug}")).Json["size_guide"]![0]![1]!.GetValue<string>());

        foreach (var bad in new[] { "Size|Chest", "Size|Chest\nS" })
            Assert.Equal(400, (await admin.Put($"/api/admin/categories/{child}", Body("Formal", bad))).Status);
    }

    [Fact]
    public async Task Product_size_guide_beats_the_category_guide()
    {
        var admin = await Admin();
        var (seller, productId, _) = await ShirtInStock("9400000613", "ownguide-shirt");
        await Refresh(productId);
        var slug = await ApiFactory.DbScalarAsync<string>("SELECT slug FROM products WHERE id = @productId", new { productId });
        var cat = await ApiFactory.DbScalarAsync<Guid>("SELECT category_id FROM products WHERE id = @productId", new { productId });
        Assert.Equal(200, (await admin.Put($"/api/admin/categories/{cat}", new { name = "Shirts", commission_bps = 1000, default_gst_bps = 500, size_guide = "Size|Waist\nL|34", return_window_days = 7 })).Status);
        Assert.Equal("Waist", (await admin.Get($"/api/catalog/products/{slug}")).Json["size_guide"]![0]![1]!.GetValue<string>());
        await ApiFactory.DbExecAsync("UPDATE products SET size_guide = 'Size | Chest\nM | 40' WHERE id = @productId", new { productId });
        var g = (await admin.Get($"/api/catalog/products/{slug}")).Json["size_guide"]!.AsArray();
        Assert.Equal("Chest", g[0]![1]!.GetValue<string>()); Assert.Equal("40", g[1]![1]!.GetValue<string>());
    }

    [Fact]
    public async Task Minimum_order_blocks_small_orders_and_nudges_in_the_cart()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000614", "minorder-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000614", "Min Order Buyer");
        var addr = await AddAddress(buyer, state: "33");
        var price = await ApiFactory.DbScalarAsync<long>("SELECT price_paise FROM variants WHERE id = @variantId", new { variantId });
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.Equal(0, (await buyer.Get("/api/cart")).Json["checkout"]!["min_order_paise"]!.GetValue<long>());
        var r = await admin.Put("/api/admin/checkout", new { fees = new { min_order_paise = price + 5000 } });
        Assert.True(r.Status == 200, r.ToString());
        var hints = (await buyer.Get("/api/cart")).Json["hints"]!.AsArray().Select(h => h!.GetValue<string>()).ToList();
        Assert.Contains(hints, h => h.StartsWith("Minimum order is"));
        r = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.Equal(400, r.Status); Assert.Equal("min_order", r.Json["error"]!["code"]!.GetValue<string>());
        await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        r = await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N") });
        Assert.True(r.Status == 201, r.ToString());
    }

    [Fact]
    public async Task Delivery_time_choice_is_off_until_admin_offers_it()
    {
        var admin = await Admin();
        var (variantId, productId, _) = await ShirtInStock("9400000615", "slot-shirt");
        await Refresh(productId);
        var buyer = await LoginPhone("9620000615", "Slot Buyer");
        var addr = await AddAddress(buyer, state: "33");
        async Task<Res> Place(string slot)
        {
            await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
            return await buyer.Post("/api/orders", new { address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), delivery_slot = slot });
        }
        var chk = (await buyer.Get("/api/cart")).Json["checkout"]!;
        Assert.False(chk["delivery_slots_enabled"]!.GetValue<bool>()); Assert.Empty(chk["delivery_slots"]!.AsArray());
        var r = await Place("Evening");
        Assert.Equal(400, r.Status); Assert.Equal("slot_off", r.Json["error"]!["code"]!.GetValue<string>());
        r = await admin.Put("/api/admin/checkout", new { fees = new { delivery_slots_enabled = true, delivery_slots = " Morning ;  Evening ; Morning;; " } });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal(400, (await admin.Put("/api/admin/checkout", new { fees = new { delivery_slots = "Only one" } })).Status);
        var slots = (await buyer.Get("/api/cart")).Json["checkout"]!["delivery_slots"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.Equal(new[] { "Morning", "Evening" }, slots);
        r = await Place("Night");
        Assert.Equal(400, r.Status); Assert.Equal("slot_unknown", r.Json["error"]!["code"]!.GetValue<string>());
        r = await Place("Evening");
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal("Evening", r.Json["order"]!["ship_to"]!["delivery_slot"]!.GetValue<string>());
        r = await Place("");
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal("", r.Json["order"]!["ship_to"]!["delivery_slot"]!.GetValue<string>());
    }

    [Fact]
    public void Drop_note_leads_with_the_customers_preferred_time()
    {
        Assert.Equal("Blue gate", BAL.DeliveryFleetBAL.DropNote(new System.Text.Json.Nodes.JsonObject { ["instructions"] = "Blue gate" }));
        Assert.Equal("Customer would like delivery: Evening. Blue gate", BAL.DeliveryFleetBAL.DropNote(new System.Text.Json.Nodes.JsonObject { ["instructions"] = "Blue gate", ["delivery_slot"] = "Evening" }));
        Assert.Equal("Customer would like delivery: Morning.", BAL.DeliveryFleetBAL.DropNote(new System.Text.Json.Nodes.JsonObject { ["delivery_slot"] = "Morning" }));
        Assert.Equal("", BAL.DeliveryFleetBAL.DropNote(new System.Text.Json.Nodes.JsonObject()));
    }

    [Fact]
    public async Task Newsletter_box_is_off_until_admin_opens_it_and_collects_clean_addresses_once()
    {
        var admin = await Admin();
        Assert.False((await admin.Get("/api/newsletter")).Json["enabled"]!.GetValue<bool>());
        var r = await admin.Post("/api/newsletter", new { email = "a@example.com" });
        Assert.Equal(400, r.Status); Assert.Equal("newsletter_off", r.Json["error"]!["code"]!.GetValue<string>());
        r = await admin.Put("/api/admin/growth/settings", new { newsletter = new { enabled = true, title = "Join us" } });
        Assert.True(r.Status == 200, r.ToString());
        var box = (await admin.Get("/api/newsletter")).Json;
        Assert.True(box["enabled"]!.GetValue<bool>()); Assert.Equal("Join us", box["title"]!.GetValue<string>());
        r = await admin.Post("/api/newsletter", new { email = "not-an-email" });
        Assert.Equal(400, r.Status); Assert.Equal("invalid_email", r.Json["error"]!["code"]!.GetValue<string>());
        Assert.Equal(201, (await admin.Post("/api/newsletter", new { email = "  Meena@Example.com " })).Status);
        Assert.Equal(201, (await admin.Post("/api/newsletter", new { email = "meena@example.com" })).Status);
        var list = (await admin.Get("/api/admin/growth/newsletter")).Json;
        Assert.Equal(1, list["total"]!.GetValue<long>()); Assert.Equal("meena@example.com", list["items"]![0]!["email"]!.GetValue<string>());
        var shopper = await LoginPhone("9620000613", "Not Staff");
        Assert.Equal(403, (await shopper.Get("/api/admin/growth/newsletter")).Status);
        Assert.Equal(200, (await admin.Delete($"/api/admin/growth/newsletter/{list["items"]![0]!["id"]!.GetValue<string>()}")).Status);
        Assert.Equal(0, (await admin.Get("/api/admin/growth/newsletter")).Json["total"]!.GetValue<long>());
    }

    [Fact]
    public async Task Wishlist_share_link_is_private_switchable_and_dies_when_stopped()
    {
        var admin = await Admin();
        var (_, productId, _) = await ShirtInStock("9400000614", "wishshare-shirt");
        await Refresh(productId);
        var me = await LoginPhone("9620000614", "Meena Kumar");
        Assert.Equal(200, (await me.Put($"/api/wishlist/{productId}")).Status);
        var st = (await me.Get("/api/wishlist/share")).Json;
        Assert.False(st["enabled"]!.GetValue<bool>()); Assert.Null(st["token"]);
        var off = await me.Post("/api/wishlist/share");
        Assert.Equal(400, off.Status); Assert.Equal("share_off", off.Json["error"]!["code"]!.GetValue<string>());

        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { wishlist_share = new { enabled = true } })).Status);
        var token = (await me.Post("/api/wishlist/share")).Json["token"]!.GetValue<string>();
        Assert.True(token.Length >= 16);
        Assert.Equal(token, (await me.Post("/api/wishlist/share")).Json["token"]!.GetValue<string>());
        var shared = await Anon($"/api/wishlist/shared/{token}");
        Assert.Equal(200, shared.Status);
        Assert.Equal("Meena", shared.Json["owner"]!.GetValue<string>()); Assert.Single(shared.Json["items"]!.AsArray());
        Assert.Equal(404, (await Anon("/api/wishlist/shared/" + new string('x', 24))).Status);

        var gone = await me.Delete("/api/wishlist/share");
        Assert.Equal(200, gone.Status); Assert.Null(gone.Json["token"]);
        Assert.Equal(404, (await Anon($"/api/wishlist/shared/{token}")).Status);
        var next = (await me.Post("/api/wishlist/share")).Json["token"]!.GetValue<string>();
        Assert.NotEqual(token, next);
        await admin.Put("/api/admin/growth/settings", new { wishlist_share = new { enabled = false } });
        Assert.Equal(404, (await Anon($"/api/wishlist/shared/{next}")).Status);
    }

    private Task<Res> Anon(string url) => Factory.Browser().Get(url);
}
