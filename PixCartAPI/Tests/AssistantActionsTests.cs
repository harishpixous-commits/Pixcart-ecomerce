using System.Text.Json.Nodes;
using BAL;
using Dapper;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;
using Xunit;

namespace Tests;

/// <summary>
/// Runtime verification of the five assistant action kinds whose prepare-to-execute path was previously
/// compile-only: create_coupon, set_coupon_active, moderate_review, reply_ticket, set_announcement
/// (reference: backend/app/assistant/actions.py prepare + execute).
/// create_coupon percent conversion is a HELD deviation: prepare stores the percent value unconverted,
/// exactly like the reference, and the endpoint then rejects it - asserted here so an approved fix updates the test.
/// </summary>
public class AssistantActionsTests : ApiTest
{
    public AssistantActionsTests(ApiFactory factory) : base(factory) { }

    private static readonly HashSet<string> Perms =
        ["catalog", "sellers", "orders", "refunds", "customers", "marketing", "support", "settings", "payouts"];

    private sealed class Rig : IDisposable
    {
        public required IServiceScope Scope { get; init; }
        public required AssistantActionsBAL Actions { get; init; }
        public required IMySqlDapperHelper Db { get; init; }
        public required Guid ConvId { get; init; }
        public required UserModel User { get; init; }
        public void Dispose() => Scope.Dispose();
    }

    private async Task<Rig> NewRig(Api admin)
    {
        var r = await admin.Post("/api/admin/assistant/conversations", new { title = "actions test" });
        Assert.True(r.Status is 200 or 201, r.ToString());
        var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var user = await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE email = 'admin@pixcart.in'");
        Assert.NotNull(user);
        return new Rig
        {
            Scope = scope,
            Actions = scope.ServiceProvider.GetRequiredService<AssistantActionsBAL>(),
            Db = db,
            ConvId = Guid.Parse(r.Json!["id"]!.GetValue<string>()),
            User = user!,
        };
    }

    private async Task<(AssistantActionModel act, JsonObject result)> PrepareAndConfirm(
        Rig rig, string kind, JsonObject prms)
    {
        var act = await rig.Actions.PrepareAsync(rig.User.Id, Perms, rig.ConvId, kind, prms);
        Assert.Equal("pending", act.Status);
        var result = await rig.Actions.DecideAsync(rig.User, act.Id, "confirm");
        return (act, result);
    }

    [Fact]
    public async Task Create_coupon_flat_carries_every_field()
    {
        var admin = await Admin();
        using var rig = await NewRig(admin);
        var (act, _) = await PrepareAndConfirm(rig, "create_coupon", new JsonObject
        {
            ["code"] = "diwali150", ["kind"] = "flat", ["value"] = 150,
            ["min_order_rupees"] = 499, ["max_discount_rupees"] = 200,
            ["usage_limit"] = 100, ["ends_on"] = "2027-03-31", ["description"] = "Diwali offer",
        });
        Assert.Equal("Create coupon DIWALI150", act.Summary);
        var row = await rig.Db.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE code = 'DIWALI150'");
        Assert.NotNull(row);
        Assert.Equal("flat", row!.Kind);
        Assert.Equal(15000, row.Value); // rupees -> paise
        Assert.Equal(49900, row.MinOrderPaise);
        Assert.Equal(20000, row.MaxDiscountPaise);
        Assert.Equal(100, row.UsageLimit);
        Assert.Equal("platform", row.FundedBy);
        Assert.Equal(new DateTime(2027, 3, 31, 18, 29, 59), row.EndsAt); // 23:59:59 IST, stored UTC
    }

    [Fact]
    public async Task Create_coupon_percent_is_exact_and_confirm_fails_at_endpoint()
    {
        // HELD reference defect: the reference prepare stores a percent value unconverted, and its endpoint
        // (100..9000 bps) then rejects it at confirm. We keep reference behavior until the owner approves
        // the percent -> bps conversion. This test pins the held behavior.
        var admin = await Admin();
        using var rig = await NewRig(admin);
        var act = await rig.Actions.PrepareAsync(rig.User.Id, Perms, rig.ConvId, "create_coupon", new JsonObject
        {
            ["code"] = "PCT20", ["kind"] = "percent", ["value"] = 20,
        });
        Assert.Equal("pending", act.Status);
        var p = JsonNode.Parse(act.Params)!.AsObject();
        Assert.Equal(20, p["value"]!.GetValue<int>()); // unconverted, reference-exact
        await Assert.ThrowsAsync<AppException>(() => rig.Actions.DecideAsync(rig.User, act.Id, "confirm"));
    }

    [Fact]
    public async Task Create_coupon_percent_out_of_range_also_fails_only_at_confirm()
    {
        // Reference prepare has NO percent range check either (95% passes prepare there too); the failure
        // surfaces only when the confirmed action reaches the endpoint. Pinned so the gap stays visible.
        var admin = await Admin();
        using var rig = await NewRig(admin);
        var act = await rig.Actions.PrepareAsync(rig.User.Id, Perms, rig.ConvId, "create_coupon",
            new JsonObject { ["code"] = "PCT95", ["kind"] = "percent", ["value"] = 95 });
        Assert.Equal("pending", act.Status);
        await Assert.ThrowsAsync<AppException>(() => rig.Actions.DecideAsync(rig.User, act.Id, "confirm"));
    }

    [Fact]
    public async Task Set_coupon_active_by_code_toggles()
    {
        var admin = await Admin();
        var c = await admin.Post("/api/admin/coupons", new { code = "FLAT100", kind = "flat", value = 10000, description = "t" });
        Assert.True(c.Status == 201, c.ToString());
        using var rig = await NewRig(admin);
        var (act, _) = await PrepareAndConfirm(rig, "set_coupon_active", new JsonObject
        {
            ["code"] = "flat100", ["active"] = "false",
        });
        Assert.Equal("Switch coupon FLAT100 off", act.Summary);
        var row = await rig.Db.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE code = 'FLAT100'");
        Assert.False(row!.IsActive);
        // And back on with a JSON boolean.
        await PrepareAndConfirm(rig, "set_coupon_active", new JsonObject { ["code"] = "FLAT100", ["active"] = true });
        row = await rig.Db.QueryFirstOrDefaultAsync<CouponModel>("SELECT * FROM coupons WHERE code = 'FLAT100'");
        Assert.True(row!.IsActive);
    }

    [Fact]
    public async Task Reply_ticket_sends_the_reply_and_moves_status()
    {
        var admin = await Admin();
        var customer = await LoginPhone("9876501234");
        var uid = customer.User["id"]!.GetValue<string>();
        var ticketId = Guid.NewGuid().ToString();
        await ApiFactory.DbExecAsync(
            "INSERT INTO support_tickets (id, number, user_id, category, subject, status, priority, is_grievance, " +
            "ack_due_at, resolve_due_at, created_at, updated_at) VALUES (@id, 'T-1001', @uid, 'order', " +
            "'Where is my order', 'open', 'normal', 0, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY), " +
            "DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 3 DAY), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            new { id = ticketId, uid });
        using var rig = await NewRig(admin);
        var (act, _) = await PrepareAndConfirm(rig, "reply_ticket", new JsonObject
        {
            ["ticket"] = "t-1001", ["message"] = "We are on it", ["status"] = "resolved",
        });
        Assert.Equal("Reply to ticket T-1001", act.Summary);
        var t = await rig.Db.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE id = @ticketId", new { ticketId });
        Assert.Equal("resolved", t!.Status);
        var msg = await rig.Db.QueryFirstOrDefaultAsync<string>(
            "SELECT body FROM ticket_messages WHERE ticket_id = @ticketId AND author_role = 'staff' ORDER BY created_at DESC LIMIT 1", new { ticketId });
        Assert.Equal("We are on it", msg);
    }

    [Fact]
    public async Task Reply_ticket_rejects_a_bad_status_at_prepare()
    {
        var admin = await Admin();
        using var rig = await NewRig(admin);
        await Assert.ThrowsAsync<AssistantActionException>(() => rig.Actions.PrepareAsync(
            rig.User.Id, Perms, rig.ConvId, "reply_ticket",
            new JsonObject { ["ticket"] = "T-1", ["message"] = "x", ["status"] = "banana" }));
    }

    [Fact]
    public async Task Moderate_review_hides()
    {
        var admin = await Admin();
        var customer = await LoginPhone("9876501234");
        var uid = customer.User["id"]!.GetValue<string>();
        var (sellerId, productId) = (Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
        var catId = Guid.NewGuid().ToString();
        await ApiFactory.DbExecAsync(
            "INSERT INTO categories (id, name, slug, image_url, commission_bps, default_gst_bps, position, is_active) " +
            "VALUES (@catId, 'Tees', 'tees', '', 0, 0, 0, 1)", new { catId });
        await ApiFactory.DbExecAsync(
            "INSERT INTO sellers (id, user_id, status, display_name, slug, description, legal_name, business_type, " +
            "pan_last4, contact_email, contact_phone, pickup_line1, pickup_line2, pickup_city, pickup_state_code, " +
            "pickup_pincode, bank_holder_name, bank_account_last4, bank_ifsc, grievance_name, grievance_email, " +
            "grievance_phone, rejection_reason, razorpay_account_id, created_at, updated_at) VALUES (@sellerId, @uid, " +
            "'approved', 'Test Store', 'test-store', '', 'Test Store', 'individual', '1234', 's@t.in', '9600099000', " +
            "'1 Main St', '', 'Chennai', '33', '600001', 'T', '4242', 'HDFC0000001', 'G', 'g@t.in', '9600099001', '', '', " +
            "UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            new { sellerId, uid });
        await ApiFactory.DbExecAsync(
            "INSERT INTO products (id, seller_id, category_id, title, slug, brand, description, highlights, specs, " +
            "hsn_code, gst_bps, country_of_origin, return_window_days, status, rejection_reason, price_from, mrp_from, " +
            "in_stock, rating_avg, rating_count, sold_count, created_at, updated_at) VALUES (@productId, @sellerId, " +
            "@catId, 'Smoke Tee', 'smoke-tee', '', '', '[]', '{}', '', 0, 'IN', 0, 'approved', '', 100, 100, 1, 0, 0, 0, " +
            "UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            new { productId, sellerId, catId });
        var reviewId = Guid.NewGuid().ToString();
        await ApiFactory.DbExecAsync(
            "INSERT INTO reviews (id, product_id, user_id, rating, title, body, status, seller_reply, helpful_count, " +
            "created_at, updated_at) VALUES (@reviewId, @productId, @uid, 4, 'Good', 'Nice tee', 'pending', '', 0, " +
            "UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))",
            new { reviewId, productId, uid });
        using var rig = await NewRig(admin);
        await PrepareAndConfirm(rig, "moderate_review", new JsonObject
        {
            ["review_id"] = reviewId, ["decision"] = "hide",
        });
        var status = await rig.Db.QueryFirstOrDefaultAsync<string>("SELECT status FROM reviews WHERE id = @reviewId", new { reviewId });
        Assert.Equal("hidden", status);
    }

    [Fact]
    public async Task Set_announcement_updates_the_storefront_bar()
    {
        var admin = await Admin();
        using var rig = await NewRig(admin);
        await PrepareAndConfirm(rig, "set_announcement", new JsonObject
        {
            ["text"] = "Big sale this week", ["link"] = "/search?q=sale",
        });
        var b = Factory.Browser();
        var site = await b.Get("/api/site");
        Assert.True(site.Status == 200, site.ToString());
        Assert.True(site.Json!["announcement"]!["enabled"]!.GetValue<bool>());
        Assert.Equal("Big sale this week", site.Json["announcement"]!["text"]!.GetValue<string>());
        Assert.Equal("/search?q=sale", site.Json["announcement"]!["link"]!.GetValue<string>());
    }

    [Fact]
    public async Task Set_announcement_rejects_an_offsite_link_at_prepare()
    {
        var admin = await Admin();
        using var rig = await NewRig(admin);
        await Assert.ThrowsAsync<AssistantActionException>(() => rig.Actions.PrepareAsync(
            rig.User.Id, Perms, rig.ConvId, "set_announcement",
            new JsonObject { ["text"] = "x", ["link"] = "https://evil.example" }));
    }
}
