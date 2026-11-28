using Utils;

namespace Tests;

/// <summary>
/// Ported from tests/test_accounts.py: separate sign-in and create-account flows, the on-screen dev OTP and its switch,
/// sign-up switches, and admin account management (customer detail, edit, create, sign out; sellers created by staff).
/// Steps that need other modules (orders, seller onboarding, block/unblock) are replaced by database set-up.
/// </summary>
public class AccountsTests(ApiFactory f) : ApiTest(f)
{
    private Task<Res> RequestOtp(Browser c, string phone, string purpose, bool forSeller = false) =>
        c.Post("/api/auth/otp/request", new { phone, purpose, for_seller = forSeller }, headers: Csrf);

    private static async Task<Res> Verify(Browser c, object body)
    {
        var r = await c.Post("/api/auth/otp/verify", body, headers: Csrf);
        c.Cookies.Clear();
        return r;
    }

    [Fact]
    public async Task Sign_in_and_create_account_are_separate()
    {
        var c = Factory.Browser();
        // sign in with a number that has no account: no code is sent, the screen offers "Create account"
        var r = await RequestOtp(c, "9630000001", "signin");
        Assert.True(r.Status == 404 && r.ErrorCode == "no_account", r.ToString());
        Assert.False(SMSHelper.DevOutbox.ContainsKey("9630000001"));

        // create account: the code is shown on screen in test mode, name and terms are required
        r = await RequestOtp(c, "9630000001", "signup");
        Assert.True(r.Status == 200 && r.Json["dev_otp"]!.GetValue<string>() == Otp("9630000001"), r.ToString());
        var code = r.Json["dev_otp"]!.GetValue<string>();
        Assert.Equal("terms_required", (await Verify(c, new { phone = "9630000001", code, purpose = "signup", name = "Anu" })).ErrorCode);
        Assert.Equal("name_required", (await Verify(c, new { phone = "9630000001", code, purpose = "signup", name = "", accept_terms = true })).ErrorCode);
        r = await Verify(c, new { phone = "9630000001", code, purpose = "signup", name = "Anu  Kumar", email = "Anu@Example.in", accept_terms = true, marketing_opt_in = true });
        Assert.True(r.Status == 200 && r.Json["is_new"]!.GetValue<bool>(), r.ToString());
        var me = r.Json["user"]!;
        Assert.Equal("Anu Kumar", me["name"]!.GetValue<string>());
        Assert.Equal("anu@example.in", me["email"]!.GetValue<string>());
        Assert.True(me["marketing_opt_in"]!.GetValue<bool>());

        // creating it again is refused; signing in works
        r = await RequestOtp(c, "9630000001", "signup");
        Assert.True(r.Status == 409 && r.ErrorCode == "account_exists", r.ToString());
        await ApiFactory.DbExecAsync("UPDATE otp_challenges SET created_at = '2020-01-01'");
        r = await RequestOtp(c, "9630000001", "signin");
        Assert.Equal(200, r.Status);
        r = await Verify(c, new { phone = "9630000001", code = r.Json["dev_otp"]!.GetValue<string>(), purpose = "signin" });
        Assert.True(r.Status == 200 && !r.Json["is_new"]!.GetValue<bool>(), r.ToString());

        // older clients (no purpose) keep working: sign in or create in one step
        r = await RequestOtp(c, "9630000002", "any");
        Assert.Equal(200, r.Status);
        r = await Verify(c, new { phone = "9630000002", code = r.Json["dev_otp"]!.GetValue<string>(), purpose = "any", name = "Old App" });
        Assert.True(r.Json["is_new"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Admin_switches_dev_otp_and_signups()
    {
        var admin = await Admin();
        var c = Factory.Browser();
        var opts = (await c.Get("/api/auth/options")).Json;
        Assert.True(opts["dev_otp"]!.GetValue<bool>() && opts["customer_signup"]!.GetValue<bool>() && opts["seller_signup"]!.GetValue<bool>());
        var s = (await admin.Get("/api/admin/auth-settings")).Json;
        Assert.True(s["dev_otp"]!["active"]!.GetValue<bool>());
        Assert.Equal("console", s["sms_provider"]!.GetValue<string>());
        Assert.Equal(6, s["settings"]!["otp_length"]!.GetValue<int>());

        var r = await admin.Put("/api/admin/auth-settings", new { show_dev_otp = false });
        Assert.True(r.Status == 200 && !r.Json["dev_otp"]!["active"]!.GetValue<bool>(), r.ToString());
        r = await RequestOtp(c, "9630000003", "signup");
        Assert.True(r.Status == 200 && r.Json["dev_otp"] is null, r.ToString()); // still sent (server log), not shown
        Assert.False((await c.Get("/api/auth/options")).Json["dev_otp"]!.GetValue<bool>());

        await admin.Put("/api/admin/auth-settings", new { customer_signup = false, signup_email = "required" });
        r = await RequestOtp(c, "9630000004", "signup");
        Assert.True(r.Status == 403 && r.ErrorCode == "signup_closed", r.ToString());
        // sellers can still register while customer sign-up is paused
        Assert.Equal(200, (await RequestOtp(c, "9630000004", "signup", forSeller: true)).Status);
        r = await Verify(c, new { phone = "9630000004", code = Otp("9630000004"), purpose = "signup", name = "Shop Owner", accept_terms = true, for_seller = true });
        Assert.Equal("email_required", r.ErrorCode);

        Assert.Equal(400, (await admin.Put("/api/admin/auth-settings", new { signup_email = "maybe" })).Status);
        Assert.Equal(400, (await admin.Put("/api/admin/auth-settings", new { show_dev_otp = "yes" })).Status);
        Assert.Contains("auth.settings", await ApiFactory.DbQueryAsync<string>("SELECT action FROM audit_logs"));

        // only staff with the settings permission
        var sup = await Staff(admin, "sup1@kadai.in", "support", "Support@2026xx");
        Assert.Equal(403, (await sup.Put("/api/admin/auth-settings", new { show_dev_otp = true })).Status);
    }

    [Fact]
    public async Task Blocked_account_cannot_sign_in()
    {
        var u = await LoginPhone("9630000006", "Blocked");
        // the reference blocks through /api/admin/customers/{id}/block (another module); the effect is the same flag
        await ApiFactory.DbExecAsync("UPDATE users SET is_active = 0 WHERE id = @id", new { id = u.Id });
        await AgeOtps();
        var r = await RequestOtp(Factory.Browser(), "9630000006", "signin");
        Assert.Equal(403, r.Status);
        Assert.Equal(401, (await u.Get("/api/auth/me")).Status);
    }

    [Fact]
    public async Task Staff_note_and_tags_are_saved_and_stay_private()
    {
        var admin = await Admin();
        var buyer = await LoginPhone("9630000091", "Noted Buyer");
        var url = $"/api/admin/customers/{buyer.Id}";
        var r = await admin.Patch(url, new { staff_note = "  Calls before delivery  ", staff_tags = new[] { "VIP", " vip ", "Wholesale", "VIP", "" } });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal("Calls before delivery", r.Json["staff_note"]!.GetValue<string>());
        Assert.Equal(new[] { "VIP", "vip", "Wholesale" }, r.Json["staff_tags"]!.AsArray().Select(x => x!.GetValue<string>()).ToArray());
        Assert.Equal("Calls before delivery", (await admin.Get(url)).Json["staff_note"]!.GetValue<string>());
        r = await admin.Patch(url, new { name = "Noted Buyer" });
        Assert.Equal(3, r.Json["staff_tags"]!.AsArray().Count);
        r = await admin.Patch(url, new { staff_tags = Array.Empty<string>() });
        Assert.Empty(r.Json["staff_tags"]!.AsArray());
        var me = (await buyer.Get("/api/auth/me")).ToString();
        Assert.DoesNotContain("staff_note", me); Assert.DoesNotContain("Calls before", me);
        Assert.Equal(422, (await admin.Patch(url, new { staff_note = new string('x', 1001) })).Status);
    }

    [Fact]
    public async Task Customer_list_filters_and_searches_by_staff_tag()
    {
        var admin = await Admin();
        var a = await LoginPhone("9630000092", "Tag Alpha");
        var b = await LoginPhone("9630000093", "Tag Beta");
        await admin.Patch($"/api/admin/customers/{a.Id}", new { staff_tags = new[] { "VIP" } });
        await admin.Patch($"/api/admin/customers/{b.Id}", new { staff_tags = new[] { "Wholesale" } });
        string[] Names(Res r) => r.Json["items"]!.AsArray().Select(x => x!["name"]!.GetValue<string>()).ToArray();
        Assert.Equal(new[] { "Tag Alpha" }, Names(await admin.Get("/api/admin/customers?tag=vip")));
        Assert.Equal(new[] { "Tag Beta" }, Names(await admin.Get("/api/admin/customers?q=wholesal")));
        Assert.Equal(0, (await admin.Get("/api/admin/customers?tag=nothing")).Json["total"]!.GetValue<int>());
    }

    [Fact]
    public async Task Admin_manages_customer_accounts()
    {
        var admin = await Admin();
        // create a customer for a phone order
        var r = await admin.Post("/api/admin/customers", new { name = "Lakshmi", phone = "+91 96300 00007", email = "lakshmi@example.in" });
        Assert.True(r.Status == 201, r.ToString());
        var cid = r.Json["id"]!.GetValue<string>();
        Assert.Equal("phone_taken", (await admin.Post("/api/admin/customers", new { name = "Dup", phone = "9630000007" })).ErrorCode);
        Assert.Equal(400, (await admin.Post("/api/admin/customers", new { name = "Bad", phone = "12345" })).Status);

        // the customer signs in on their own mobile, saves an address and asks for help (orders are another module)
        var buyer = await LoginPhone("9630000007");
        Assert.Equal(cid, buyer.Id);
        await AddAddress(buyer);
        Assert.Equal(201, (await buyer.Post("/api/support/tickets", new { category = "order", subject = "Need invoice", message = "Please send the GST invoice" })).Status);
        // a session to see (login_phone forgets its cookie, but the session row stays)
        var d = (await admin.Get($"/api/admin/customers/{cid}")).Json;
        Assert.Equal("Lakshmi", d["name"]!.GetValue<string>());
        Assert.Equal("9630000007", d["phone"]!.GetValue<string>());
        Assert.Equal("lakshmi@example.in", d["email"]!.GetValue<string>());
        Assert.Equal(1, d["stats"]!["tickets"]!.GetValue<int>());
        Assert.Equal(0, d["stats"]!["orders"]!.GetValue<int>());
        Assert.StartsWith("4 Lake View St", d["addresses"]![0]!["text"]!.GetValue<string>());
        Assert.NotEmpty(d["sessions"]!.AsArray());
        Assert.Equal("user.create", d["history"]![0]!["action"]!.GetValue<string>());

        // edit: a new mobile number signs the customer out everywhere
        var b = Factory.Browser();
        await AgeOtps();
        await b.Post("/api/auth/otp/request", new { phone = "9630000007" });
        Assert.Equal(200, (await b.Post("/api/auth/otp/verify", new { phone = "9630000007", code = Otp("9630000007") })).Status);
        r = await admin.Patch($"/api/admin/customers/{cid}", new { name = "Lakshmi R", phone = "9630000008", marketing_opt_in = true });
        Assert.True(r.Status == 200 && r.Json["phone"]!.GetValue<string>() == "9630000008" && r.Json["sessions"]!.AsArray().Count == 0, r.ToString());
        Assert.Equal(200, (await buyer.Get("/api/auth/me")).Status); // access token still valid until it expires...
        Assert.Equal(401, (await b.Post("/api/auth/refresh", headers: Csrf)).Status); // ...but the session cannot be renewed
        Assert.Equal("email_taken", (await admin.Patch($"/api/admin/customers/{cid}", new { email = "admin@pixcart.in" })).ErrorCode);
        Assert.Null((await admin.Patch($"/api/admin/customers/{cid}", new { clear_email = true })).Json["email"]);

        await AgeOtps();
        var buyer2 = await LoginPhone("9630000008");
        Assert.Equal(cid, buyer2.Id);
        r = await admin.Post($"/api/admin/customers/{cid}/sign-out");
        Assert.Equal(1, r.Json["sessions"]!.GetValue<int>());
        var hist = (await admin.Get($"/api/admin/customers/{cid}")).Json["history"]!.AsArray().Select(h => h!["action"]!.GetValue<string>()).ToHashSet();
        Assert.Superset(new HashSet<string> { "user.edit", "user.sign_out", "user.create" }, hist);

        // support staff can read customers; a catalogue manager cannot
        var cat = await Staff(admin, "cat1@kadai.in", "catalog", "Catalog@2026xx");
        Assert.Equal(403, (await cat.Get($"/api/admin/customers/{cid}")).Status);
        var sup = await Staff(admin, "sup9@kadai.in", "support", "Support@2026xx");
        Assert.Equal(200, (await sup.Get($"/api/admin/customers/{cid}")).Status);
    }

    [Fact]
    public async Task Staff_create_a_seller_who_completes_onboarding()
    {
        var admin = await Admin();
        var r = await admin.Post("/api/admin/sellers", new { phone = "9630000009", name = "Ravi", store_name = "Ravi  Electricals" });
        Assert.True(r.Status == 201, r.ToString());
        var sid = r.Json["id"]!.GetValue<string>();
        Assert.Equal(409, (await admin.Post("/api/admin/sellers", new { phone = "9630000009", name = "Ravi", store_name = "Again" })).Status);
        var seller = await LoginPhone("9630000009");
        // the reference reads /api/seller/me (seller module); the sign-in answer carries the same summary
        var s = seller.User["seller"]!;
        Assert.Equal(sid, s["id"]!.GetValue<string>());
        Assert.Equal("draft", s["status"]!.GetValue<string>());
        Assert.Equal("Ravi Electricals", s["display_name"]!.GetValue<string>());
        Assert.Equal("ravi-electricals", await ApiFactory.DbScalarAsync<string>("SELECT slug FROM sellers WHERE id = @sid", new { sid }));
    }

    [Fact]
    public async Task Admin_edits_seller_kyc_and_sellers_are_told()
    {
        var admin = await Admin();
        var sid = (await admin.Post("/api/admin/sellers", new { phone = "9400000001", name = "Kovai", store_name = "Kovai Textiles" })).Json["id"]!.GetValue<string>();
        var tn = await LoginPhone("9400000001");
        var bank = new { holder_name = "Kovai Textiles Pvt Ltd", account_number = "998877665544", confirm_account_number = "998877665544", ifsc = "HDFC0001234" };
        // where money goes is sensitive: staff confirm with their password
        Assert.Equal("wrong_password", (await admin.Put($"/api/admin/sellers/{sid}/bank", bank)).ErrorCode);
        var r = await admin.Put($"/api/admin/sellers/{sid}/bank", new
        {
            bank.holder_name, bank.account_number, bank.confirm_account_number, bank.ifsc, password = AdminPassword,
        });
        Assert.True(r.Status == 200 && r.Json["bank"]!["account_number"]!.GetValue<string>() == "998877665544", r.ToString());
        r = await admin.Put($"/api/admin/sellers/{sid}/bank", new
        {
            holder_name = "X Y Z", account_number = "1234567890", confirm_account_number = "1234567899", ifsc = "HDFC0001234", password = AdminPassword,
        });
        Assert.Equal("account_mismatch", r.ErrorCode);
        var notes = (await tn.Get("/api/notifications")).Json["items"]!.AsArray();
        Assert.Contains(notes, n => n!["title"]!.GetValue<string>().Contains("bank account changed"));
        Assert.Equal("", await ApiFactory.DbScalarAsync<string>("SELECT payout_fund_account_id FROM sellers WHERE id = @sid", new { sid }));

        r = await admin.Put($"/api/admin/sellers/{sid}/pickup-address", new { line1 = "5 New Mill Road", city = "Coimbatore", state_code = "33", pincode = "641001" });
        Assert.True(r.Status == 200 && r.Json["pickup"]!["city"]!.GetValue<string>() == "Coimbatore", r.ToString());
        Assert.Equal("Coimbatore", await ApiFactory.DbScalarAsync<string>("SELECT city FROM warehouses WHERE seller_id = @sid AND is_default = 1", new { sid }));
        r = await admin.Put($"/api/admin/sellers/{sid}/grievance-officer", new { name = "Kumar S", email = "kumar@kovai.in", phone = "9400000011" });
        Assert.Equal("Kumar S", r.Json["grievance"]!["name"]!.GetValue<string>());
        var gstin = ValidGstin("33", "KOVAI1234K");
        r = await admin.Put($"/api/admin/sellers/{sid}/business", new
        {
            display_name = "Kovai Textiles", legal_name = "Kovai Textiles LLP", business_type = "llp", gstin, pan = "KOVAI1234K", contact_email = "a@kovai.in",
            contact_phone = "9400000001",
        });
        Assert.True(r.Status == 200 && r.Json["legal_name"]!.GetValue<string>() == "Kovai Textiles LLP", r.ToString());
        Assert.Equal("KOVAI1234K", r.Json["pan"]!.GetValue<string>());
        r = await admin.Put($"/api/admin/sellers/{sid}/business", new
        {
            display_name = "Kovai Textiles", legal_name = "Kovai", business_type = "llp", gstin, pan = "ABCDE1234F", contact_email = "a@kovai.in", contact_phone = "9400000001",
        });
        Assert.Equal("pan_gstin_mismatch", r.ErrorCode);
        Assert.Equal(422, (await admin.Put($"/api/admin/sellers/{sid}/business", new
        {
            display_name = "Kovai Textiles", legal_name = "Kovai", business_type = "llp", gstin = "33ABCDE1234F1Z0", pan = "ABCDE1234F", contact_email = "a@kovai.in",
            contact_phone = "9400000001",
        })).Status); // bad check digit

        var actions = (await ApiFactory.DbQueryAsync<string>("SELECT action FROM audit_logs WHERE entity_id = @sid", new { sid })).ToHashSet();
        Assert.Superset(new HashSet<string> { "seller.edit_bank", "seller.edit_pickup", "seller.edit_business" }, actions);

        // staff without the sellers permission cannot change them
        var sup = await Staff(admin, "sup2@kadai.in", "support", "Support@2026xx");
        Assert.Equal(403, (await sup.Put($"/api/admin/sellers/{sid}/grievance-officer", new { name = "Hacker", email = "h@x.in", phone = "9400000012" })).Status);
    }

    [Fact]
    public async Task Duplicate_gstin_refused()
    {
        var admin = await Admin();
        var first = (await admin.Post("/api/admin/sellers", new { phone = "9444444444", name = "First", store_name = "First Store" })).Json["id"]!.GetValue<string>();
        var copy = (await admin.Post("/api/admin/sellers", new { phone = "9555555555", name = "Copy", store_name = "Copy Store" })).Json["id"]!.GetValue<string>();
        var body = new
        {
            display_name = "Some Store", legal_name = "Some Store", business_type = "individual", gstin = ValidGstin("33", "AAAAA1111A"), pan = "AAAAA1111A",
            contact_email = "c@example.com", contact_phone = "9555555555",
        };
        Assert.Equal(200, (await admin.Put($"/api/admin/sellers/{first}/business", body)).Status);
        var r = await admin.Put($"/api/admin/sellers/{copy}/business", body);
        Assert.True(r.Status == 409 && r.ErrorCode == "gstin_taken", r.ToString());
    }
}
