namespace Tests;

/// <summary>
/// The customer endpoints of this module: addresses, wishlist, notifications, support tickets, the product beacon,
/// privacy (consent, export, deletion) and the staff member's admin preferences. The reference has no single test file
/// for these; the scenarios follow the reference behaviour (and the conftest add_address helper).
/// </summary>
public class CustomerAccountTests(ApiFactory f) : ApiTest(f)
{
    /// <summary>An approved seller with one live product (inserted directly: catalogue and onboarding are other modules).</summary>
    private static async Task<string> LiveProduct(string sellerUserId, long price = 49900, long mrp = 99900)
    {
        var cat = Guid.NewGuid().ToString();
        var seller = Guid.NewGuid().ToString();
        var product = Guid.NewGuid().ToString();
        await ApiFactory.DbExecAsync(
            "INSERT INTO categories (id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active) VALUES (@cat, 'Fashion', 'fashion', '', 1000, 500, 0, 1)",
            new { cat });
        await ApiFactory.DbExecAsync(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, pan_last4, contact_email, contact_phone, " +
            "pickup_line1, pickup_line2, pickup_city, pickup_state_code, pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, " +
            "grievance_email, grievance_phone, rejection_reason, razorpay_account_id) VALUES (@seller, @sellerUserId, 'approved', 'Kovai Textiles', 'kovai', '', '', " +
            "'llp', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '')", new { seller, sellerUserId });
        await ApiFactory.DbExecAsync(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, hsn_code, gst_bps, country_of_origin, " +
            "return_window_days, status, rejection_reason, price_from, mrp_from, in_stock, rating_avg, rating_count, sold_count, details) VALUES " +
            "(@product, @seller, @cat, 'Cotton Shirt', 'cotton-shirt', 'Acme', 'A shirt', '[]', '{}', '6205', 500, 'India', 7, 'approved', '', @price, @mrp, 1, 4.5, 2, 0, '{}')",
            new { product, seller, cat, price, mrp });
        await ApiFactory.DbExecAsync(
            "INSERT INTO variants (id, product_id, seller_id, sku, options, mrp_paise, price_paise, stock, weight_grams, is_active) VALUES " +
            "(@id, @product, @seller, 'SKU1', '{}', @mrp, @price, 5, 300, 1)", new { id = Guid.NewGuid().ToString(), product, seller, price, mrp });
        await ApiFactory.DbExecAsync("INSERT INTO product_images (id, product_id, url, position) VALUES (@id, @product, '/media/p.png', 0)",
            new { id = Guid.NewGuid().ToString(), product });
        return product;
    }

    [Fact]
    public async Task Addresses_default_limit_and_soft_delete()
    {
        var u = await LoginPhone("9500000001", "Priya");
        var first = await AddAddress(u);
        var list = (await u.Get("/api/addresses")).Json.AsArray();
        Assert.True(list[0]!["is_default"]!.GetValue<bool>()); // the first address is the default
        Assert.Equal("Tamil Nadu", list[0]!["state"]!.GetValue<string>());

        var r = await u.Post("/api/addresses", new
        {
            full_name = "  Ravi K ", phone = "+91 98765 00001", line1 = "12 Market Rd", city = "Bengaluru", state_code = "29", pincode = "560001", kind = "work",
            is_default = true, label = "  Office   desk ", lat = 12.9716123456, lng = 77.5946,
        });
        Assert.True(r.Status == 201, r.ToString());
        var second = r.Json["id"]!.GetValue<string>();
        Assert.Equal("Ravi K", r.Json["full_name"]!.GetValue<string>());
        Assert.Equal("9876500001", r.Json["phone"]!.GetValue<string>());
        Assert.Equal("Office desk", r.Json["label"]!.GetValue<string>());
        Assert.Equal(12.971612, r.Json["lat"]!.GetValue<double>());
        list = (await u.Get("/api/addresses")).Json.AsArray();
        Assert.Equal(second, list[0]!["id"]!.GetValue<string>());
        Assert.False(list[1]!["is_default"]!.GetValue<bool>());

        // validation in plain words
        r = await u.Post("/api/addresses", new { full_name = "P", phone = "9876500000", line1 = "4 Lake View St", city = "Chennai", state_code = "33", pincode = "600028" });
        Assert.True(r.Status == 422 && r.ErrorMessage == "Full name: needs at least 2 characters", r.ToString());
        r = await u.Post("/api/addresses", new { full_name = "Priya", phone = "9876500000", line1 = "4 Lake View St", city = "Chennai", state_code = "33", pincode = "000001" });
        Assert.True(r.Status == 422 && r.ErrorMessage == "PIN code: Enter a valid 6-digit PIN code", r.ToString());
        r = await u.Post("/api/addresses", new { full_name = "Priya", phone = "9876500000", line1 = "4 Lake View St", city = "Chennai", state_code = "33", pincode = "600028", lat = 50.0, lng = 80.0 });
        Assert.True(r.Status == 422 && r.ErrorMessage == "Lat: must be at most 38.0", r.ToString());

        r = await u.Patch($"/api/addresses/{first}/instructions", new { instructions = " Ring  the bell " });
        Assert.Equal("Ring the bell", r.Json["instructions"]!.GetValue<string>());
        r = await u.Patch($"/api/addresses/{first}/location", new { lat = 13.08, lng = (double?)null });
        Assert.Null(r.Json["lat"]); // both or neither
        r = await u.Put($"/api/addresses/{first}", new { full_name = "Priya S", phone = "9876500000", line1 = "5 Lake View St", city = "Chennai", state_code = "33", pincode = "600028", is_default = true });
        Assert.True(r.Json["is_default"]!.GetValue<bool>() && r.Json["line1"]!.GetValue<string>() == "5 Lake View St", r.ToString());

        // someone else's address does not exist for them
        var other = await LoginPhone("9500000002");
        Assert.Equal(404, (await other.Delete($"/api/addresses/{first}")).Status);
        // deleting the default makes the newest remaining one the default
        Assert.Equal(200, (await u.Delete($"/api/addresses/{first}")).Status);
        list = (await u.Get("/api/addresses")).Json.AsArray();
        Assert.Single(list);
        Assert.True(list[0]!["is_default"]!.GetValue<bool>());
        Assert.Equal(1, await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM addresses WHERE is_deleted = 1"));

        for (var i = 0; i < 19; i++) await AddAddress(u);
        r = await u.Post("/api/addresses", new { full_name = "Priya", phone = "9876500000", line1 = "4 Lake View St", city = "Chennai", state_code = "33", pincode = "600028" });
        Assert.True(r.Status == 400 && r.ErrorCode == "address_limit", r.ToString());
    }

    [Fact]
    public async Task Wishlist_cards_and_limits()
    {
        var owner = await LoginPhone("9500000010", "Seller");
        var product = await LiveProduct(owner.Id);
        var u = await LoginPhone("9500000011");
        Assert.Equal(404, (await u.Put($"/api/wishlist/{Guid.NewGuid()}")).Status);
        Assert.Equal(200, (await u.Put($"/api/wishlist/{product}")).Status);
        Assert.Equal(200, (await u.Put($"/api/wishlist/{product}")).Status); // twice is fine
        var w = (await u.Get("/api/wishlist")).Json;
        Assert.Equal(product, w["ids"]![0]!.GetValue<string>());
        var card = w["items"]![0]!;
        Assert.Equal("Cotton Shirt", card["title"]!.GetValue<string>());
        Assert.Equal(50, card["discount_pct"]!.GetValue<int>());
        Assert.Equal("/media/p.png", card["image"]!.GetValue<string>());
        Assert.Equal("Kovai Textiles", card["seller_name"]!.GetValue<string>());
        Assert.Equal(1, card["variant_count"]!.GetValue<int>());
        Assert.NotNull(card["variant_id"]);
        Assert.Equal(49900, await ApiFactory.DbScalarAsync<long>("SELECT price_at_add FROM wishlist_items"));
        Assert.Equal(200, (await u.Delete($"/api/wishlist/{product}")).Status);
        Assert.Empty((await u.Get("/api/wishlist")).Json["items"]!.AsArray());

        // the beacon counts a view once per visitor and product
        var b = Factory.Browser();
        Assert.Equal(204, (await b.Post("/api/events", new { type = "view", product_id = product })).Status);
        Assert.Equal(204, (await b.Post("/api/events", new { type = "view", product_id = product })).Status);
        Assert.Equal(204, (await b.Post("/api/events", new { type = "add_to_cart", product_id = product })).Status);
        Assert.Equal(1, await ApiFactory.DbScalarAsync<int>("SELECT views FROM product_daily_stats"));
        Assert.Equal(1, await ApiFactory.DbScalarAsync<int>("SELECT add_to_cart FROM product_daily_stats"));
        Assert.Equal(422, (await b.Post("/api/events", new { type = "like", product_id = product })).Status);
    }

    [Fact]
    public async Task Support_tickets_and_notifications()
    {
        var u = await LoginPhone("9500000020", "Meena");
        var cats = (await Factory.Browser().Get("/api/support/categories")).Json["categories"]!.AsArray();
        Assert.Equal(7, cats.Count);
        var r = await u.Post("/api/support/tickets", new { category = "nope", subject = "Help please", message = "Something is wrong here" });
        Assert.Equal("invalid_category", r.ErrorCode);
        r = await u.Post("/api/support/tickets", new { category = "order", subject = "Help", message = "Something is wrong here" });
        Assert.Equal(422, r.Status);
        r = await u.Post("/api/support/tickets", new { category = "order", subject = "Help please", message = "Something is wrong here", order_id = Guid.NewGuid() });
        Assert.Equal(404, r.Status);
        r = await u.Post("/api/support/tickets", new { category = "account", subject = "Help please", message = "Something is wrong here", is_grievance = true });
        Assert.True(r.Status == 201, r.ToString());
        var t = r.Json;
        Assert.StartsWith("TK", t["number"]!.GetValue<string>());
        Assert.Equal("high", t["priority"]!.GetValue<string>());
        Assert.Equal("My account", t["category_label"]!.GetValue<string>());
        Assert.Empty(t["messages"]!.AsArray());
        var id = t["id"]!.GetValue<string>();
        Assert.Single((await u.Get("/api/support/tickets")).Json["items"]!.AsArray());
        r = await u.Post($"/api/support/tickets/{id}/messages", new { body = "Any update?" });
        Assert.Equal(2, r.Json["messages"]!.AsArray().Count);
        var other = await LoginPhone("9500000021");
        Assert.Equal(404, (await other.Get($"/api/support/tickets/{id}")).Status);
        r = await u.Post($"/api/support/tickets/{id}/close");
        Assert.True(r.Json["status"]!.GetValue<string>() == "closed" && r.Json["resolved_at"] is not null, r.ToString());
        Assert.Equal("ticket_closed", (await u.Post($"/api/support/tickets/{id}/messages", new { body = "Hello" })).ErrorCode);
        for (var i = 0; i < 10; i++) await u.Post("/api/support/tickets", new { category = "other", subject = "Question " + i, message = "A question for the team" });
        Assert.Equal("too_many_tickets", (await u.Post("/api/support/tickets", new { category = "other", subject = "One more", message = "A question for the team" })).ErrorCode);

        // notifications: in-app rows, unread count, read all
        await u.B.Post("/api/auth/sessions/sign-out-others", token: u.Token, headers: Csrf);
        await Task.Delay(1100);
        var fresh = await LoginPhoneAgain("9500000020");
        var n = (await fresh.Get("/api/notifications")).Json;
        Assert.Equal(1, n["unread"]!.GetValue<int>());
        Assert.Equal("Security notice: other devices signed out", n["items"]![0]!["title"]!.GetValue<string>());
        Assert.Equal(422, (await fresh.Get("/api/notifications?page=0")).Status);
        Assert.Equal(200, (await fresh.Post("/api/notifications/read-all")).Status);
        Assert.Equal(0, (await fresh.Get("/api/notifications")).Json["unread"]!.GetValue<int>());
    }

    private async Task<Api> LoginPhoneAgain(string phone)
    {
        await AgeOtps();
        return await LoginPhone(phone);
    }

    [Fact]
    public async Task Privacy_consent_export_and_deletion()
    {
        var u = await LoginPhone("9500000030", "Anu");
        await AddAddress(u);
        var r = await u.Put("/api/account/consent", new { marketing_opt_in = true });
        Assert.True(r.Json["marketing_opt_in"]!.GetValue<bool>());
        Assert.Equal("marketing=True", await ApiFactory.DbScalarAsync<string>("SELECT detail FROM audit_logs WHERE action = 'account.consent'"));
        var e = (await u.Get("/api/account/export")).Json;
        Assert.Equal("9500000030", e["profile"]!["phone"]!.GetValue<string>());
        Assert.Single(e["addresses"]!.AsArray());
        Assert.Empty(e["orders"]!.AsArray());

        Assert.Equal(200, (await u.Delete("/api/account")).Status);
        Assert.Equal(401, (await u.Get("/api/auth/me")).Status); // the account can no longer be used
        Assert.Equal("Deleted user", await ApiFactory.DbScalarAsync<string>("SELECT name FROM users WHERE id = @id", new { id = u.Id }));
        Assert.Equal("Deleted", await ApiFactory.DbScalarAsync<string>("SELECT full_name FROM addresses"));

        var admin = await Admin();
        Assert.Equal("staff_account", (await admin.Delete("/api/account")).ErrorCode);
    }

    [Fact]
    public async Task Admin_preferences_are_personal()
    {
        var admin = await Admin();
        var r = await admin.Get("/api/admin/me/preferences");
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal("sidebar", r.Json["admin_layout"]!.GetValue<string>());
        Assert.Null(r.Json["ui_prefs"]!["admin_layout"]);
        Assert.Equal("test", r.Json["environment"]!.GetValue<string>());
        r = await admin.Put("/api/admin/me/preferences", new { admin_layout = "glass", nav_collapsed = new[] { " Money ", "Money", "Growth" }, ignored = 1 });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal("glass", r.Json["admin_layout"]!.GetValue<string>());
        Assert.Equal("[\"Money\",\"Growth\"]", r.Json["ui_prefs"]!["nav_collapsed"]!.ToJsonString());
        r = await admin.Put("/api/admin/me/preferences", new { sidebar_collapsed = true });
        Assert.Equal("glass", r.Json["admin_layout"]!.GetValue<string>()); // left out: kept
        Assert.True(r.Json["ui_prefs"]!["sidebar_collapsed"]!.GetValue<bool>());
        r = await admin.Put("/api/admin/me/preferences", new { admin_layout = "cards" });
        Assert.True(r.Status == 422 && r.ErrorMessage == "Admin layout: Choose one of: sidebar, topnav, rail, glass", r.ToString());
        r = await admin.Put("/api/admin/me/preferences", new { admin_layout = (string?)null });
        Assert.Equal("sidebar", r.Json["admin_layout"]!.GetValue<string>());
        var shopper = await LoginPhone("9500000040");
        Assert.Equal(403, (await shopper.Get("/api/admin/me/preferences")).Status);
    }
}
