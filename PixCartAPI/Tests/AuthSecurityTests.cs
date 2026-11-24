using Utils;

namespace Tests;

/// <summary>
/// Ported from tests/test_auth_security.py: one-time code rules, password lockout and policy, how long people stay signed
/// in, sign-in alerts and required two-step sign-in for staff (Admin → Sign-in and accounts).
/// </summary>
public class AuthSecurityTests(ApiFactory f) : ApiTest(f)
{
    private const string Url = "/api/admin/auth-settings";

    [Fact]
    public async Task Defaults_follow_the_environment()
    {
        var admin = await Admin();
        var s = (await admin.Get(Url)).Json;
        var cfg = s["settings"]!;
        var env = new AppSettings();
        Assert.Equal(env.OtpLength, cfg["otp_length"]!.GetValue<int>());
        Assert.Equal(env.OtpTtlSeconds, cfg["otp_ttl_seconds"]!.GetValue<int>());
        Assert.Equal(env.RefreshTokenDays, cfg["customer_session_days"]!.GetValue<int>());
        Assert.Equal(env.RefreshTokenDays, cfg["staff_session_days"]!.GetValue<int>());
        Assert.Equal(12, cfg["password_min_length"]!.GetValue<int>());
        Assert.True(cfg["password_require_mixed"]!.GetValue<bool>());
        Assert.Equal("staff", cfg["login_alerts"]!.GetValue<string>());
        Assert.False(cfg["staff_require_two_step"]!.GetValue<bool>());
        Assert.Equal("[4,8]", s["limits"]!["otp_length"]!.ToJsonString());
    }

    [Fact]
    public async Task Validation()
    {
        var admin = await Admin();
        object[] bodies =
        [
            new { otp_length = 3 }, new { otp_length = 9 }, new { otp_length = "6" }, new { otp_length = true }, new { otp_ttl_seconds = 30 },
            new { login_max_attempts = 0 }, new { password_min_length = 7 }, new { staff_session_days = 91 }, new { login_alerts = "sometimes" },
            new { password_require_mixed = "yes" }, new { unknown = 1 },
        ];
        foreach (var body in bodies)
        {
            var r = await admin.Put(Url, body);
            Assert.True(r.Status == 400 && r.ErrorCode == "invalid_settings", r.ToString());
        }
    }

    [Fact]
    public async Task Code_length_and_attempts()
    {
        var admin = await Admin();
        var c = Factory.Browser();
        Assert.Equal(200, (await admin.Put(Url, new { otp_length = 4, otp_max_attempts = 3 })).Status);
        Assert.Equal(4, (await c.Get("/api/auth/options")).Json["otp_length"]!.GetValue<int>());
        var r = await c.Post("/api/auth/otp/request", new { phone = "9720000001" });
        Assert.True(r.Status == 200 && r.Json["length"]!.GetValue<int>() == 4, r.ToString());
        var code = Otp("9720000001");
        Assert.Equal(4, code.Length);
        var wrong = code != "0000" ? "0000" : "1111";
        for (var i = 0; i < 3; i++)
            Assert.Equal(400, (await c.Post("/api/auth/otp/verify", new { phone = "9720000001", code = wrong, name = "Ravi", purpose = "signup", accept_terms = true })).Status);
        r = await c.Post("/api/auth/otp/verify", new { phone = "9720000001", code, name = "Ravi", purpose = "signup", accept_terms = true });
        Assert.Equal(429, r.Status); // three wrong tries use the code up
    }

    [Fact]
    public async Task Lockout_after_wrong_passwords()
    {
        var admin = await Admin();
        var c = Factory.Browser();
        Assert.Equal(201, (await admin.Post("/api/admin/staff", new { email = "lock@kadai.in", name = "Lock", role = "support", password = "Staff@2026xyz" })).Status);
        Assert.Equal(200, (await admin.Put(Url, new { login_max_attempts = 3, login_lockout_minutes = 5 })).Status);
        for (var i = 0; i < 3; i++) Assert.Equal(401, (await c.Post("/api/auth/login", new { email = "lock@kadai.in", password = "wrong" })).Status);
        // even the right password waits now
        Assert.Equal(429, (await c.Post("/api/auth/login", new { email = "lock@kadai.in", password = "Staff@2026xyz" })).Status);
    }

    [Fact]
    public async Task Password_policy_everywhere()
    {
        var admin = await Admin();
        Assert.Equal(200, (await admin.Put(Url, new { password_min_length = 16 })).Status);
        var r = await admin.Post("/api/auth/password", new { current_password = AdminPassword, new_password = "Short@2026abc" });
        Assert.True(r.Status == 400 && r.ErrorCode == "weak_password" && r.ErrorMessage!.Contains("16"), r.ToString());
        r = await admin.Post("/api/admin/staff", new { email = "x@kadai.in", name = "Xavier", role = "support", password = "Short@2026abc" });
        Assert.True(r.Status == 400 && r.ErrorCode == "weak_password", r.ToString());
        // mixed case can be switched off; the length still counts
        Assert.Equal(200, (await admin.Put(Url, new { password_require_mixed = false })).Status);
        r = await admin.Post("/api/auth/password", new { current_password = AdminPassword, new_password = "a long passphrase here" });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal(16, (await Factory.Browser().Get("/api/auth/options")).Json["password_min_length"]!.GetValue<int>());
    }

    [Fact]
    public async Task Session_length_by_kind()
    {
        var admin = await Admin();
        Assert.Equal(200, (await admin.Put(Url, new { staff_session_days = 7, customer_session_days = 60 })).Status);
        var c = Factory.Browser();
        var r = await c.Post("/api/auth/login", new { email = "admin@pixcart.in", password = AdminPassword });
        Assert.Contains(r.SetCookies, x => x.Contains($"Max-Age={7 * 86400}"));
        c.Cookies.Clear();
        await c.Post("/api/auth/otp/request", new { phone = "9720000002" });
        r = await c.Post("/api/auth/otp/verify", new { phone = "9720000002", code = Otp("9720000002"), name = "Asha", purpose = "signup", accept_terms = true });
        Assert.Contains(r.SetCookies, x => x.Contains($"Max-Age={60 * 86400}"));
    }

    [Fact]
    public async Task Alert_on_a_new_device()
    {
        await Admin();
        var login = new { email = "admin@pixcart.in", password = AdminPassword };
        var laptop = Factory.Browser("Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36");
        var phone = Factory.Browser("Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile Safari/537.36");
        Assert.Equal(200, (await laptop.Post("/api/auth/login", login)).Status);
        Assert.Equal(200, (await laptop.Post("/api/auth/login", login)).Status); // same device: no alert
        Assert.Equal(200, (await phone.Post("/api/auth/login", login)).Status);  // new device: alert
        var subjects = await ApiFactory.DbQueryAsync<string>("SELECT subject FROM notifications WHERE event = 'security_notice' AND channel = 'inapp'");
        // one alert per new device (the laptop was new too: the test client signed in before); none for the repeat
        Assert.Equal(["Security notice: new sign-in on Chrome on Android", "Security notice: new sign-in on Chrome on Windows"], subjects.Order());
    }

    [Fact]
    public async Task Staff_must_use_two_step()
    {
        var admin = await Admin();
        var helper = await Staff(admin, "desk@kadai.in");
        // the owner must have it first, so they are never locked out
        var r = await admin.Put(Url, new { staff_require_two_step = true });
        Assert.True(r.Status == 400 && r.ErrorCode == "two_step_self", r.ToString());
        var secret = (await admin.Post("/api/auth/totp/setup")).Json["secret"]!.GetValue<string>();
        Assert.Equal(200, (await admin.Post("/api/auth/totp/enable", new { code = TotpHelper.Current(secret) })).Status);
        Assert.Equal(200, (await admin.Put(Url, new { staff_require_two_step = true })).Status);

        // staff without it: every admin action waits (the reference also checks /api/admin/me and /api/admin/orders,
        // which belong to other modules; a customers endpoint of this module is checked instead)
        var shopper = await LoginPhone("9720000003", "Meena");
        r = await helper.Get($"/api/admin/customers/{shopper.Id}");
        Assert.True(r.Status == 403 && r.ErrorCode == "two_step_required", r.ToString());
        // the owner (who has it) carries on
        Assert.Equal(200, (await admin.Get($"/api/admin/customers/{shopper.Id}")).Status);
        // customers are not affected
        Assert.Equal(200, (await shopper.Get("/api/auth/me")).Status);
    }
}
