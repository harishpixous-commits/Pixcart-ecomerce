using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Model.Constants;
using Utils;
using Utils.Interface;

namespace Tests;

/// <summary>Checkout and order rules: a business buyer's GSTIN, save for later at the limit, a deleted address in the
/// quote, cancelling what can no longer be cancelled, and the unpaid-order expiry recording every successful attempt.</summary>
public class CheckoutRulesTests(ApiFactory f) : ApiTest(f)
{
    private static DateTime Now => DateTimeFunctions.UtcNow();

    /// <summary>An approved Tamil Nadu seller with a warehouse and one live shirt in stock.</summary>
    private static async Task<(Guid VariantId, Guid ProductId, Guid SellerId)> ShirtInStock(string ownerPhone, string slug)
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
            "@ownerPhone, '', @now, @now, '', 2, '', 0, @now, @now)", new { sellerId, ownerId, ownerPhone, slug = "seller-" + slug, gstin = Gstin("33KOVAI1234K1Z"), now = Now });
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
}
