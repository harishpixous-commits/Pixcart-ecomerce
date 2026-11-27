using BAL.Interface;
using Microsoft.Extensions.DependencyInjection;
using Model.Constants;
using Utils;

namespace Tests;

/// <summary>A business buyer's GSTIN at checkout: a wrong one is refused with its reason (400 invalid_gstin on the
/// buyer_gstin field), never a server error, and a right one is kept on the order for the tax invoices.</summary>
public class CheckoutGstinTests(ApiFactory f) : ApiTest(f)
{
    private static DateTime Now => DateTimeFunctions.UtcNow();

    /// <summary>An approved Tamil Nadu seller with a warehouse and one live shirt in stock; returns the variant.</summary>
    private static async Task<Guid> ShirtInStock()
    {
        var category = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO categories (id, parent_id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active, required_details, " +
            "return_window_days, min_return_window_days, created_at, updated_at) VALUES (@category, NULL, 'Shirts', 'gstin-shirts', '', 1000, 500, 0, 1, CAST('[]' AS JSON), 7, 0, @now, @now)",
            new { category, now = Now });
        var ownerId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO users (id, phone, email, name, is_admin, is_active, admin_role, totp_enabled, marketing_opt_in, ui_prefs, created_at, updated_at) " +
            "VALUES (@ownerId, '9400000201', NULL, 'Kovai Owner', 0, 1, '', 0, 0, CAST('{}' AS JSON), @now, @now)", new { ownerId, now = Now });
        var sellerId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, gstin, pan_last4, contact_email, contact_phone, " +
            "pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, grievance_email, " +
            "grievance_phone, rejection_reason, submitted_at, approved_at, razorpay_account_id, dispatch_days, dispatch_cutoff, holiday_mode, created_at, updated_at) " +
            "VALUES (@sellerId, @ownerId, 'approved', 'Kovai Weaves', 'kovai-weaves', 'Quality goods', 'Kovai Weaves Traders', 'proprietorship', @gstin, '234K', 'kovai@example.com', " +
            "'9400000201', '12 Market Road', '', 'Coimbatore', '33', '641001', 'Kovai Weaves Traders', '9012', 'HDFC0001234', 'Ravi Kumar', 'grievance@example.com', " +
            "'9400000201', '', @now, @now, '', 2, '', 0, @now, @now)", new { sellerId, ownerId, gstin = Gstin("33KOVAI1234K1Z"), now = Now });
        var warehouseId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO warehouses (id, seller_id, code, name, line1, line2, city, state_code, pincode, contact_name, contact_phone, gstin, is_default, is_active, " +
            "shiprocket_pickup_name, created_at, updated_at) VALUES (@warehouseId, @sellerId, 'MAIN', 'Main warehouse', '12 Market Road', '', 'Coimbatore', '33', '641001', 'Ravi', " +
            "'9400000201', '', 1, 1, '', @now, @now)", new { warehouseId, sellerId, now = Now });
        var productId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, hsn_code, gst_bps, country_of_origin, " +
            "return_window_days, status, rejection_reason, submitted_at, approved_at, price_from, mrp_from, in_stock, rating_avg, rating_count, sold_count, details, " +
            "created_at, updated_at) VALUES (@productId, @sellerId, @category, 'Handloom Cotton Shirt', 'gstin-handloom-cotton-shirt', 'Kovai', " +
            "'A well made handloom shirt with great materials and finish.', CAST('[\"Handloom\"]' AS JSON), CAST('{\"Material\": \"Cotton\"}' AS JSON), '6205', 500, " +
            "'India', 7, 'approved', '', @now, @now, 0, 0, 0, 0, 0, 0, CAST('{}' AS JSON), @now, @now)", new { productId, sellerId, category, now = Now });
        var variantId = Guid.NewGuid();
        await ApiFactory.DbExecAsync(
            "INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, net_qty, is_active, created_at, updated_at) " +
            "VALUES (@variantId, @productId, @sellerId, 'HL-GST', CAST('{}' AS JSON), 200000, 100000, 10, 500, NULL, 1, @now, @now)",
            new { variantId, productId, sellerId, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO inventory_levels (variant_id, warehouse_id, quantity, updated_at) VALUES (@variantId, @warehouseId, 10, @now)",
            new { variantId, warehouseId, now = Now });
        await ApiFactory.DbExecAsync("INSERT INTO product_images (id, product_id, url, position) VALUES (@id, @productId, '/media/products/shirt.webp', 0)",
            new { id = Guid.NewGuid(), productId });
        return variantId;
    }

    private static string Gstin(string first14) => first14 + IndianStates.GstinCheckChar(first14);

    [Fact]
    public async Task A_wrong_gstin_is_refused_with_its_reason_and_a_right_one_is_kept()
    {
        var admin = await Admin();
        var r = await admin.Put("/api/admin/checkout", new { fees = new { gstin_enabled = true } });
        Assert.True(r.Status == 200, r.ToString());
        var variantId = await ShirtInStock();
        await using (var scope = Factory.Services.CreateAsyncScope())
        {
            var productId = await ApiFactory.DbScalarAsync<Guid>("SELECT product_id FROM variants WHERE id=@variantId", new { variantId });
            await scope.ServiceProvider.GetRequiredService<ICatalogBAL>().RefreshProductAggregatesAsync(productId);
        }
        var buyer = await LoginPhone("9620000201", "Meena");
        var addr = await AddAddress(buyer, state: "33");
        r = await buyer.Post("/api/cart/items", new { variant_id = variantId, qty = 1 });
        Assert.True(r.Status is 200 or 201, r.ToString());
        object Order(string gstin, string business = "Meena Traders") => new
        {
            address_id = addr, payment_method = "cod", idempotency_key = Guid.NewGuid().ToString("N"), buyer_gstin = gstin, buyer_business = business,
        };

        var good = Gstin("33ABCDE1234F1Z");
        var wrongDigit = good[..14] + (good[14] == 'A' ? 'B' : 'A');
        r = await buyer.Post("/api/orders", Order(wrongDigit));
        Assert.True(r.Status == 400 && r.ErrorCode == "invalid_gstin", r.ToString());
        Assert.Equal("GSTIN check digit does not match; please re-check the number", r.Json["error"]!["message"]!.GetValue<string>());
        Assert.Equal("Invalid", r.Json["error"]!["fields"]!["buyer_gstin"]!.GetValue<string>());

        r = await buyer.Post("/api/orders", Order("NOT-A-GSTIN"));
        Assert.True(r.Status == 400 && r.ErrorCode == "invalid_gstin", r.ToString());
        Assert.Equal("Enter a valid 15-character GSTIN", r.Json["error"]!["message"]!.GetValue<string>());

        r = await buyer.Post("/api/orders", Order(good, "!"));  // the business name is checked the same way
        Assert.True(r.Status == 400 && r.ErrorCode == "invalid_gstin", r.ToString());

        r = await buyer.Post("/api/orders", Order(good));
        Assert.True(r.Status == 201, r.ToString());
        Assert.Equal(good, r.Json["order"]!["buyer_gstin"]!.GetValue<string>());
        Assert.Equal("Meena Traders", r.Json["order"]!["buyer_business"]!.GetValue<string>());
    }
}
