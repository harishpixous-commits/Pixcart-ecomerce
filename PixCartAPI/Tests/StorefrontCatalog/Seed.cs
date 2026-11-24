using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Dapper;
using Microsoft.Extensions.DependencyInjection;
using Model.Constants;
using MySqlConnector;
using Utils;

namespace Tests.StorefrontCatalog;

/// <summary>A version of a listing to create.</summary>
public sealed record V(string Sku, long Mrp, long Price, int Stock, object? Options = null, decimal? NetQty = null);

/// <summary>A created listing.</summary>
public sealed record P(Guid Id, string Slug, Guid SellerId, List<Guid> VariantIds, string Title);

/// <summary>A created seller (with its owner's client).</summary>
public sealed record S(Guid Id, Api Owner, string Name);

/// <summary>
/// Test data written straight to the database (sellers, listings, orders and coupons belong to other modules, so the
/// storefront tests seed them with SQL instead of calling those modules' endpoints).
/// </summary>
public sealed class Seed(CatalogFactory factory)
{
    private static int _counter;

    private static async Task<MySqlConnection> OpenAsync()
    {
        var c = new MySqlConnection(CatalogFactory.ConnectionString + "GuidFormat=Char36;");
        await c.OpenAsync();
        return c;
    }

    public async Task ExecAsync(string sql, object? args = null)
    {
        await using var c = await OpenAsync();
        await c.ExecuteAsync(sql, args);
    }

    public async Task<T?> ScalarAsync<T>(string sql, object? args = null)
    {
        await using var c = await OpenAsync();
        return await c.ExecuteScalarAsync<T>(sql, args);
    }

    public async Task<List<T>> QueryAsync<T>(string sql, object? args = null)
    {
        await using var c = await OpenAsync();
        return (await c.QueryAsync<T>(sql, args)).ToList();
    }

    private static DateTime Now => DateTimeFunctions.UtcNow();

    public async Task<Guid> UserAsync(string phone, string name, bool admin = false)
    {
        var id = Guid.NewGuid();
        await ExecAsync(
            "INSERT INTO users (id, phone, email, name, is_admin, is_active, admin_role, totp_enabled, marketing_opt_in, ui_prefs, created_at, updated_at) " +
            "VALUES (@id, @phone, @email, @name, @admin, 1, '', 0, 0, CAST('{}' AS JSON), @now, @now)",
            new { id, phone, email = admin ? $"admin{phone}@pixcart.in" : null, name, admin, now = Now });
        return id;
    }

    /// <summary>Fashion › Men's Shirts and Electronics › Mobiles, like the reference conftest.</summary>
    public async Task<Dictionary<string, Guid>> CategoriesAsync()
    {
        var ids = new Dictionary<string, Guid> { ["fashion"] = Guid.NewGuid(), ["shirts"] = Guid.NewGuid(), ["electronics"] = Guid.NewGuid(), ["mobiles"] = Guid.NewGuid() };
        async Task Add(string key, string name, string slug, Guid? parent, int commission, int gst) =>
            await ExecAsync(
                "INSERT INTO categories (id, parent_id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active, required_details, " +
                "return_window_days, min_return_window_days, created_at, updated_at) VALUES (@id, @parent, @name, @slug, '', @commission, @gst, 0, 1, CAST('[]' AS JSON), 7, 0, @now, @now)",
                new { id = ids[key], parent, name, slug, commission, gst, now = Now });
        await Add("fashion", "Fashion", "fashion", null, 1000, 500);
        await Add("shirts", "Men's Shirts", "mens-shirts", ids["fashion"], 1200, 500);
        await Add("electronics", "Electronics", "electronics", null, 800, 1800);
        await Add("mobiles", "Mobiles", "mobiles", ids["electronics"], 500, 1800);
        return ids;
    }

    private static string Gstin(string state, string pan)
    {
        var first = $"{state}{pan}1Z";
        return first + IndianStates.GstinCheckChar(first);
    }

    /// <summary>An approved seller with a default warehouse at the pickup address, like make_seller.</summary>
    public async Task<S> SellerAsync(string phone, string name, string state = "33", string city = "Chennai", string pincode = "600001")
    {
        var userId = await UserAsync(phone, $"{name} Owner");
        var n = Interlocked.Increment(ref _counter);
        var pan = "ABCDE" + (1000 + n % 9000).ToString() + "F";
        var id = Guid.NewGuid();
        var slug = Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
        var now = Now;
        await ExecAsync(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, gstin, pan_last4, contact_email, contact_phone, " +
            "pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, grievance_email, " +
            "grievance_phone, rejection_reason, submitted_at, approved_at, razorpay_account_id, dispatch_days, dispatch_cutoff, holiday_mode, created_at, updated_at) " +
            "VALUES (@id, @userId, 'approved', @name, @slug, 'Quality goods', @legal, 'proprietorship', @gstin, '234F', @email, @phone, '12 Market Road', '', @city, @state, " +
            "@pincode, @legal, '9012', 'HDFC0001234', 'Ravi Kumar', 'grievance@example.com', @phone, '', @now, @now, '', 2, '', 0, @now, @now)",
            new { id, userId, name, slug, legal = $"{name} Traders", gstin = Gstin(state, pan), email = $"seller{n}@example.com", phone, city, state, pincode, now });
        await ExecAsync(
            "INSERT INTO warehouses (id, seller_id, code, name, line1, line2, city, state_code, pincode, contact_name, contact_phone, gstin, is_default, is_active, " +
            "shiprocket_pickup_name, created_at, updated_at) VALUES (@wid, @id, 'MAIN', 'Main warehouse', '12 Market Road', '', @city, @state, @pincode, 'Ravi', @phone, '', 1, 1, '', @now, @now)",
            new { wid = Guid.NewGuid(), id, city, state, pincode, phone, now });
        var token = factory.Services.GetRequiredService<API.Service.TokenService>().CreateAccessToken(userId, false);
        return new S(id, new Api(factory.CreateClient(), token, userId), name);
    }

    /// <summary>A listing with its versions and one photo, approved (live) unless another status is given.</summary>
    public async Task<P> ProductAsync(S seller, Guid categoryId, string title, V[] variants, string brand = "Acme", string status = "approved",
        object? specs = null, object? details = null, string[]? highlights = null, int returnWindow = 7)
    {
        var id = Guid.NewGuid();
        var slug = Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-') + "-" + Interlocked.Increment(ref _counter);
        var now = Now;
        await ExecAsync(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, hsn_code, gst_bps, country_of_origin, " +
            "return_window_days, status, rejection_reason, submitted_at, approved_at, price_from, mrp_from, in_stock, rating_avg, rating_count, sold_count, details, " +
            "created_at, updated_at) VALUES (@id, @seller, @categoryId, @title, @slug, @brand, 'A well made product with great materials and finish.', " +
            "CAST(@highlights AS JSON), CAST(@specs AS JSON), '6205', 500, 'India', @returnWindow, @status, '', @now, @approvedAt, 0, 0, 0, 0, 0, 0, CAST(@details AS JSON), @now, @now)",
            new
            {
                id, seller = seller.Id, categoryId, title, slug, brand, returnWindow, status, now, approvedAt = status == "approved" ? now : (DateTime?)null,
                highlights = JsonSerializer.Serialize(highlights ?? ["Durable", "Comfortable"]),
                specs = JsonSerializer.Serialize(specs ?? new Dictionary<string, string> { ["Material"] = "Cotton" }),
                details = JsonSerializer.Serialize(details ?? new { }),
            });
        var vids = new List<Guid>();
        var i = 0;
        foreach (var v in variants)
        {
            var vid = Guid.NewGuid();
            vids.Add(vid);
            await ExecAsync(
                "INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, net_qty, is_active, created_at, updated_at) " +
                "VALUES (@vid, @id, @seller, @sku, CAST(@options AS JSON), @mrp, @price, @stock, 500, @netQty, 1, @created, @created)",
                new { vid, id, seller = seller.Id, sku = v.Sku, options = JsonSerializer.Serialize(v.Options ?? new { }), mrp = v.Mrp, price = v.Price, stock = v.Stock, netQty = v.NetQty,
                      created = now.AddMilliseconds(i++) });
        }
        await ExecAsync("INSERT INTO product_images (id, product_id, url, position) VALUES (@iid, @id, @url, 0)",
            new { iid = Guid.NewGuid(), id, url = $"/media/products/{id:N}.webp" });
        await using (var scope = factory.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<ICatalogBAL>().RefreshProductAggregatesAsync(id);
        return new P(id, slug, seller.Id, vids, title);
    }

    /// <summary>
    /// A cash-on-delivery order with one package per seller, every package in <paramref name="status"/> (e.g. "placed",
    /// "delivered"). Items: (product, version index, qty).
    /// </summary>
    public async Task<Guid> OrderAsync(Guid buyerId, string status, params (P Product, int Variant, int Qty)[] items)
    {
        var orderId = Guid.NewGuid();
        var now = Now;
        var n = Interlocked.Increment(ref _counter);
        var lines = new List<(P P, Guid Vid, int Qty, long Price, long Mrp)>();
        foreach (var (p, vi, qty) in items)
        {
            var (price, mrp) = (await QueryAsync<(long, long)>("SELECT price_paise, mrp_paise FROM variants WHERE id = @id", new { id = p.VariantIds[vi] }))[0];
            lines.Add((p, p.VariantIds[vi], qty, price, mrp));
        }
        var total = lines.Sum(l => l.Price * l.Qty);
        await ExecAsync(
            "INSERT INTO orders (id, number, user_id, status, payment_method, payment_status, ship_to, items_total, shipping_total, cod_fee, grand_total, refunded_total, " +
            "idempotency_key, placed_at, created_at, updated_at) VALUES (@orderId, @number, @buyerId, 'placed', 'cod', 'cod', CAST('{}' AS JSON), @total, 0, 0, @total, 0, @key, @now, @now, @now)",
            new { orderId, number = $"PC{n:D8}", buyerId, total, key = Guid.NewGuid().ToString("N"), now });
        var s = 0;
        foreach (var group in lines.GroupBy(l => l.P.SellerId))
        {
            var subId = Guid.NewGuid();
            var subTotal = group.Sum(l => l.Price * l.Qty);
            await ExecAsync(
                "INSERT INTO sub_orders (id, order_id, seller_id, number, status, items_total, shipping_fee, cod_fee, total, taxable_total, shipping_gst_bps, is_interstate, " +
                "commission_paise, commission_gst_paise, tcs_paise, tds_paise, seller_payout_paise, settlement_status, courier_name, tracking_number, tracking_url, " +
                "cancelled_by, cancel_reason, shipped_at, delivered_at, created_at, updated_at) VALUES (@subId, @orderId, @seller, @number, @status, @subTotal, 0, 0, @subTotal, " +
                "@subTotal, 1800, 0, 0, 0, 0, 0, @subTotal, 'not_due', '', '', '', '', '', @shipped, @delivered, @now, @now)",
                new
                {
                    subId, orderId, seller = group.Key, number = $"PC{n:D8}-{++s}", status, subTotal, now,
                    shipped = status is "shipped" or "delivered" ? now : (DateTime?)null, delivered = status == "delivered" ? now : (DateTime?)null,
                });
            foreach (var l in group)
            {
                var line = l.Price * l.Qty;
                await ExecAsync(
                    "INSERT INTO order_items (id, sub_order_id, product_id, variant_id, title, variant_label, image_url, sku, hsn_code, qty, unit_price, unit_mrp, line_total, " +
                    "gst_bps, taxable_value, cgst, sgst, igst, commission_bps, commission_paise) VALUES (@id, @subId, @pid, @vid, @title, '', '', 'SKU', '6205', @qty, @price, @mrp, " +
                    "@line, 0, @line, 0, 0, 0, 0, 0)",
                    new { id = Guid.NewGuid(), subId, pid = l.P.Id, vid = l.Vid, title = l.P.Title, qty = l.Qty, price = l.Price, mrp = l.Mrp, line });
            }
        }
        return orderId;
    }

    public Task CouponAsync(string code, string kind, int value, long? maxDiscount = null, long minOrder = 0, Guid? sellerId = null) =>
        ExecAsync(
            "INSERT INTO coupons (id, code, description, kind, value, max_discount_paise, min_order_paise, per_user_limit, used_count, funded_by, seller_id, " +
            "first_order_only, is_active, show_on_checkout, created_at, updated_at) VALUES (@id, @code, '', @kind, @value, @maxDiscount, @minOrder, 1, 0, @fundedBy, @sellerId, 0, 1, 1, @now, @now)",
            new { id = Guid.NewGuid(), code, kind, value, maxDiscount, minOrder, fundedBy = sellerId == null ? "platform" : "seller", sellerId, now = Now });
}
