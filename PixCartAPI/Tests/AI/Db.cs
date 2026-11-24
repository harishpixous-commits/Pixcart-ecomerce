using System.Security.Cryptography;
using Dapper;
using MySqlConnector;

namespace Tests.AI;

/// <summary>Test data straight into the database (the modules that create sellers, products and orders are ported separately).</summary>
public sealed class Db
{
    public static MySqlConnection Open() => new(new MySqlConnectionStringBuilder(AiFixture.ConnectionString) { GuidFormat = MySqlGuidFormat.Char36 }.ConnectionString);

    public async Task<int> Exec(string sql, object? p = null)
    {
        await using var c = Open();
        return await c.ExecuteAsync(sql, p);
    }

    public async Task<T?> Scalar<T>(string sql, object? p = null)
    {
        await using var c = Open();
        return await c.ExecuteScalarAsync<T>(sql, p);
    }

    public async Task<List<dynamic>> Rows(string sql, object? p = null)
    {
        await using var c = Open();
        return (await c.QueryAsync(sql, p)).ToList();
    }

    private static readonly Random Rng = new();

    public static string Phone() => "9" + Rng.NextInt64(100000000, 999999999);

    public static string Code(int n) => string.Concat(Enumerable.Range(0, n).Select(_ => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[RandomNumberGenerator.GetInt32(32)]));

    public static string OrderNumber() => "PC261124" + Code(6);

    public async Task<Guid> User(string name, bool admin = false, string role = "", string? email = null, string? password = null, string? phone = null)
    {
        var id = Guid.NewGuid();
        await Exec("INSERT INTO users (id, phone, email, name, password_hash, is_admin, is_active, admin_role) VALUES (@id, @phone, @email, @name, @hash, @admin, 1, @role)",
            new { id, phone = admin ? null : phone ?? Phone(), email = admin ? email ?? $"{Code(8).ToLower()}@kadai.in" : email, name,
                  hash = password is null ? null : BCrypt.Net.BCrypt.HashPassword(password, 4), admin, role });
        return id;
    }

    public async Task<Guid> Admin(string role = "", string password = "Admin@12345") => await User("Admin", true, role, password: password);

    public async Task<string> Role(string name, params string[] permissions)
    {
        var code = "r" + Code(6).ToLower();
        await Exec("INSERT INTO admin_roles (code, name, description, permissions, is_locked, created_at, updated_at) VALUES (@code, @name, '', CAST(@perms AS JSON), 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            new { code, name, perms = System.Text.Json.JsonSerializer.Serialize(permissions) });
        return code;
    }

    public async Task<(Guid SellerId, Guid UserId)> Seller(string name, string status = "approved", DateTime? approvedAt = null)
    {
        var userId = await User(name + " owner");
        var id = Guid.NewGuid();
        await Exec(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, gstin, pan_last4, contact_email, contact_phone, " +
            "pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, grievance_email, " +
            "grievance_phone, rejection_reason, razorpay_account_id, approved_at) VALUES (@id, @userId, @status, @name, @slug, '', @legal, 'proprietorship', @gstin, '1234', " +
            "'s@x.in', '9876500000', 'Line 1', '', 'Chennai', '33', '600001', 'Owner', '1234', 'HDFC0000001', 'G', 'g@x.in', '9876500001', '', '', @approvedAt)",
            new { id, userId, status, name, slug = name.ToLower().Replace(' ', '-') + "-" + Code(4).ToLower(), legal = name + " Pvt Ltd",
                  gstin = "33ABCDE" + Rng.Next(1000, 9999) + "F1Z5", approvedAt = approvedAt ?? DateTime.UtcNow.AddDays(-60) });
        return (id, userId);
    }

    public async Task<Guid> Category(string name)
    {
        var id = Guid.NewGuid();
        await Exec("INSERT INTO categories (id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active) VALUES (@id, @name, @slug, '', 1000, 500, 0, 1)",
            new { id, name, slug = name.ToLower().Replace(' ', '-') + "-" + Code(4).ToLower() });
        return id;
    }

    public sealed record ProductRef(Guid Id, Guid VariantId, string Slug, string Sku);

    public async Task<ProductRef> Product(Guid sellerId, Guid categoryId, string title, long price = 99900, long mrp = 129900, string description = "Handwoven cotton shirt, breathable and soft for Indian summers. Machine wash.",
        string status = "approved", int stock = 10, string brand = "Kovai")
    {
        var id = Guid.NewGuid();
        var vid = Guid.NewGuid();
        var slug = title.ToLower().Replace(' ', '-') + "-" + Code(4).ToLower();
        var sku = "SKU-" + Code(6);
        await Exec(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, hsn_code, gst_bps, country_of_origin, return_window_days, status, " +
            "rejection_reason, price_from, mrp_from, in_stock, rating_avg, rating_count, sold_count) VALUES (@id, @sellerId, @categoryId, @title, @slug, @brand, @description, " +
            "CAST('[\"Pure cotton\"]' AS JSON), CAST('{\"Fabric\": \"Cotton\"}' AS JSON), '6205', 500, 'India', 7, @status, '', @price, @mrp, @inStock, 4.20, 3, 5)",
            new { id, sellerId, categoryId, title, slug, brand, description, status, price, mrp, inStock = stock > 0 });
        await Exec("INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, is_active) " +
                   "VALUES (@vid, @id, @sellerId, @sku, CAST('{\"Size\": \"M\"}' AS JSON), @mrp, @price, @stock, 300, 1)", new { vid, id, sellerId, sku, mrp, price, stock });
        await Exec("INSERT INTO product_images (id, product_id, url, position) VALUES (@iid, @id, '/media/p.jpg', 0)", new { iid = Guid.NewGuid(), id });
        return new ProductRef(id, vid, slug, sku);
    }

    public sealed record OrderRef(Guid Id, string Number, Guid SubId, string SubNumber, long GrandTotal);

    /// <summary>A placed order of one package with one item (COD unless said otherwise).</summary>
    public async Task<OrderRef> Order(Guid userId, Guid sellerId, ProductRef product, int qty = 1, string status = "placed", string payment = "cod",
        DateTime? createdAt = null, string pincode = "600001", string title = "Handloom Cotton Shirt Blue")
    {
        var id = Guid.NewGuid();
        var subId = Guid.NewGuid();
        var number = OrderNumber();
        var unit = 99900L;
        var items = unit * qty;
        var shipping = 0L;
        var grand = items + shipping;
        var created = createdAt ?? DateTime.UtcNow;
        var shipTo = System.Text.Json.JsonSerializer.Serialize(new { full_name = "Meena", phone = "9876543210", line1 = "12 Gandhi Road", line2 = "", landmark = "",
            city = "Chennai", state = "Tamil Nadu", state_code = "33", pincode });
        await Exec(
            "INSERT INTO orders (id, number, user_id, status, payment_method, payment_status, ship_to, items_total, shipping_total, cod_fee, grand_total, refunded_total, " +
            "idempotency_key, placed_at, created_at) VALUES (@id, @number, @userId, 'placed', @payment, @ps, CAST(@shipTo AS JSON), @items, @shipping, 0, @grand, 0, @key, @created, @created)",
            new { id, number, userId, payment, ps = payment == "cod" ? "cod" : "paid", shipTo, items, shipping, grand, key = Code(12), created });
        var taxable = (long)Math.Round(items / 1.05);
        var gst = items - taxable;
        await Exec(
            "INSERT INTO sub_orders (id, order_id, seller_id, number, status, items_total, shipping_fee, cod_fee, total, taxable_total, shipping_gst_bps, is_interstate, " +
            "commission_paise, commission_gst_paise, tcs_paise, tds_paise, seller_payout_paise, settlement_status, courier_name, tracking_number, tracking_url, cancelled_by, " +
            "cancel_reason, created_at, expected_delivery_at) VALUES (@subId, @id, @sellerId, @subNumber, @status, @items, @shipping, 0, @grand, @taxable, 1800, 0, @comm, 0, 0, 0, " +
            "@payout, 'not_due', '', '', '', '', '', @created, @eta)",
            new { subId, id, sellerId, subNumber = number + "-1", status, items, shipping, grand, taxable, comm = items / 10, payout = items - items / 10, created,
                  eta = created.AddDays(5) });
        await Exec(
            "INSERT INTO order_items (id, sub_order_id, product_id, variant_id, title, variant_label, image_url, sku, hsn_code, qty, unit_price, unit_mrp, line_total, gst_bps, " +
            "taxable_value, cgst, sgst, igst, commission_bps, commission_paise, return_window_days) VALUES (@iid, @subId, @pid, @vid, @title, 'Size: M', '/media/p.jpg', @sku, '6205', " +
            "@qty, @unit, 129900, @items, 500, @taxable, @cgst, @sgst, 0, 1000, @comm, 7)",
            new { iid = Guid.NewGuid(), subId, pid = product.Id, vid = product.VariantId, title, sku = product.Sku, qty, unit, items, taxable, cgst = gst / 2, sgst = gst - gst / 2, comm = items / 10 });
        return new OrderRef(id, number, subId, number + "-1", grand);
    }

    public async Task<(Guid Id, string Number)> Ticket(Guid userId, string subject, string message, string category = "delivery", Guid? orderId = null)
    {
        var id = Guid.NewGuid();
        var number = "TK261124" + Convert.ToHexString(RandomNumberGenerator.GetBytes(2));
        await Exec("INSERT INTO support_tickets (id, number, user_id, order_id, category, subject, status, priority, is_grievance, ack_due_at, resolve_due_at) " +
                   "VALUES (@id, @number, @userId, @orderId, @category, @subject, 'open', 'normal', 0, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 48 HOUR), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY))",
            new { id, number, userId, orderId, category, subject });
        await Exec("INSERT INTO ticket_messages (id, ticket_id, author_id, author_role, body, is_internal, created_at) VALUES (@mid, @id, @userId, 'customer', @message, 0, UTC_TIMESTAMP(6))",
            new { mid = Guid.NewGuid(), id, userId, message });
        return (id, number);
    }

    public Task Setting(string key, string json) =>
        Exec("INSERT INTO platform_settings (`key`, `value`, updated_at) VALUES (@key, CAST(@json AS JSON), UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
            new { key, json });

    public Task DeleteSetting(string key) => Exec("DELETE FROM platform_settings WHERE `key` = @key", new { key });
}
