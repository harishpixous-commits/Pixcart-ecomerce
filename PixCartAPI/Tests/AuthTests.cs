using Model.CustomeAttributes;
using Utils;

namespace Tests;

/// <summary>Ported from tests/test_auth_and_onboarding.py (the sign-in parts) and tests/test_sessions.py.</summary>
public class AuthTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Otp_login_wrong_code_then_success_and_refresh_rotation()
    {
        var c = Factory.Browser();
        var r = await c.Post("/api/auth/otp/request", new { phone = "+91 98765 43210" });
        Assert.Equal(200, r.Status);
        var code = Otp("9876543210");

        // resend too soon is refused
        r = await c.Post("/api/auth/otp/request", new { phone = "9876543210" });
        Assert.Equal(429, r.Status);

        var wrong = code != "000000" ? "000000" : "111111";
        r = await c.Post("/api/auth/otp/verify", new { phone = "9876543210", code = wrong });
        Assert.True(r.Status == 400 && r.ErrorCode == "otp_invalid", r.ToString());

        r = await c.Post("/api/auth/otp/verify", new { phone = "9876543210", code, name = "Anu" });
        Assert.True(r.Status == 200, r.ToString());
        Assert.True(r.Json["is_new"]!.GetValue<bool>());
        Assert.Equal("Anu", r.Json["user"]!["name"]!.GetValue<string>());
        var oldCookie = c.Cookies["pc_refresh"];

        // the code cannot be reused
        r = await c.Post("/api/auth/otp/verify", new { phone = "9876543210", code });
        Assert.Equal(400, r.Status);

        // refresh needs the CSRF header
        r = await c.Post("/api/auth/refresh");
        Assert.Equal(403, r.Status);
        r = await c.Post("/api/auth/refresh", headers: Csrf);
        Assert.True(r.Status == 200, r.ToString());
        var newCookie = c.Cookies["pc_refresh"];
        Assert.NotEqual(oldCookie, newCookie);

        // the same browser racing itself (a reload while the refresh was on its way) is not theft: renewed quietly
        c.Cookies.Clear();
        c.Cookies["pc_refresh"] = oldCookie;
        r = await c.Post("/api/auth/refresh", headers: Csrf);
        Assert.True(r.Status == 200, r.ToString());
        var raced = c.Cookies["pc_refresh"];
        Assert.NotEqual(oldCookie, raced);
        Assert.NotEqual(newCookie, raced);

        // replaying a rotated token from another browser revokes every session of the user (theft detection)
        c.Cookies.Clear();
        c.Cookies["pc_refresh"] = oldCookie;
        c.UserAgent = "Stolen/1.0";
        r = await c.Post("/api/auth/refresh", headers: Csrf);
        Assert.Equal(401, r.Status);
        c.UserAgent = "TestBrowser/1.0";
        foreach (var cookie in new[] { newCookie, raced })
        {
            c.Cookies.Clear();
            c.Cookies["pc_refresh"] = cookie;
            r = await c.Post("/api/auth/refresh", headers: Csrf);
            Assert.Equal(401, r.Status);
        }
    }

    [Fact]
    public async Task Otp_attempt_limit()
    {
        var c = Factory.Browser();
        await c.Post("/api/auth/otp/request", new { phone = "9000000001" });
        var code = Otp("9000000001");
        var wrong = code != "999999" ? "999999" : "888888";
        for (var i = 0; i < 5; i++) Assert.Equal(400, (await c.Post("/api/auth/otp/verify", new { phone = "9000000001", code = wrong })).Status);
        Assert.Equal(429, (await c.Post("/api/auth/otp/verify", new { phone = "9000000001", code })).Status);
    }

    [Fact]
    public async Task Invalid_phone_rejected()
    {
        var r = await Factory.Browser().Post("/api/auth/otp/request", new { phone = "12345" });
        Assert.Equal(422, r.Status);
        Assert.Contains("mobile", r.ErrorMessage);
    }

    [Fact]
    public async Task Admin_password_login_and_rbac()
    {
        var admin = await Admin();
        var c = Factory.Browser();
        Assert.Equal(401, (await c.Post("/api/auth/login", new { email = "admin@pixcart.in", password = "wrong" })).Status);
        var customer = await LoginPhone("9111111111");
        // the reference checks /api/admin/dashboard; this module's admin endpoints are checked the same way
        Assert.Equal(403, (await customer.Get("/api/admin/staff")).Status);
        Assert.Equal(200, (await admin.Get("/api/admin/staff")).Status);
        Assert.Equal(401, (await c.Get("/api/admin/staff")).Status);
    }

    [Fact]
    public void Gstin_checksum()
    {
        var g = ValidGstin("33", "ABCDE1234F");
        Assert.Equal(g, IndianFormats.ValidateGstin(g));
        var bad = g[..^1] + (g[^1] != 'A' ? "A" : "B");
        Assert.Throws<ArgumentException>(() => IndianFormats.ValidateGstin(bad));
        Assert.Equal('V', IndianFormats.GstinCheckChar("27AAPFU0939F1Z")); // known public example (Maharashtra)
    }

    [Fact]
    public async Task Me_and_profile_update()
    {
        var u = await LoginPhone("9111111112", "Kavya");
        var me = await u.Get("/api/auth/me");
        Assert.Equal("9111111112", me.Json["phone"]!.GetValue<string>());
        Assert.Null(me.Json["seller"]);
        var r = await u.Patch("/api/auth/me", new { name = " Kavya R ", email = "Kavya@Example.in" });
        Assert.True(r.Status == 200, r.ToString());
        Assert.Equal("Kavya R", r.Json["name"]!.GetValue<string>());
        Assert.Equal("kavya@example.in", r.Json["email"]!.GetValue<string>());
        var other = await LoginPhone("9111111113");
        r = await other.Patch("/api/auth/me", new { email = "kavya@example.in" });
        Assert.Equal("email_taken", r.ErrorCode);
        Assert.Equal(422, (await other.Patch("/api/auth/me", new { email = "not-an-email" })).Status);
    }

    [Fact]
    public async Task Logout_ends_the_session()
    {
        var b = Factory.Browser();
        await b.Post("/api/auth/otp/request", new { phone = "9111111114" });
        var r = await b.Post("/api/auth/otp/verify", new { phone = "9111111114", code = Otp("9111111114"), name = "Out" });
        Assert.Equal(200, r.Status);
        var cookie = b.Cookies["pc_refresh"];
        Assert.Equal(403, (await b.Post("/api/auth/logout")).Status);
        r = await b.Post("/api/auth/logout", headers: Csrf);
        Assert.True(r.Status == 200 && r.SetCookies.Any(c => c.Contains("Max-Age=0")), r.ToString());
        b.Cookies["pc_refresh"] = cookie;
        Assert.Equal(401, (await b.Post("/api/auth/refresh", headers: Csrf)).Status);
    }
}

/// <summary>Ported from tests/test_sessions.py: signed-in devices and "sign out of other devices".</summary>
public class SessionTests(ApiFactory f) : ApiTest(f)
{
    private const string Phone = "9711111111";
    private const string PhoneUa = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
    private const string LaptopUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0";

    private async Task<string> SignIn(Browser b)
    {
        await AgeOtps(); // as if the last code was sent a while ago (the resend wait is not under test)
        Assert.Equal(200, (await b.Post("/api/auth/otp/request", new { phone = Phone })).Status);
        var r = await b.Post("/api/auth/otp/verify", new { phone = Phone, code = Otp(Phone), name = "Divya" });
        Assert.True(r.Status == 200, r.ToString());
        return r.Json["access_token"]!.GetValue<string>();
    }

    [Fact]
    public async Task List_and_sign_out_others()
    {
        var phone = Factory.Browser(PhoneUa);
        var laptop = Factory.Browser(LaptopUa);
        var tPhone = await SignIn(phone);
        var tLaptop = await SignIn(laptop);

        var r = await laptop.Get("/api/auth/sessions", tLaptop);
        Assert.True(r.Status == 200, r.ToString());
        var rows = r.Json["sessions"]!.AsArray();
        Assert.Equal(["Chrome on Android", "Edge on Windows"], rows.Select(x => x!["device"]!.GetValue<string>()).Order());
        Assert.Equal(["Edge on Windows"], rows.Where(x => x!["current"]!.GetValue<bool>()).Select(x => x!["device"]!.GetValue<string>()));
        Assert.DoesNotContain("Mozilla", r.Text); // never the raw header

        await Task.Delay(1100); // tokens carry whole seconds
        r = await laptop.Post("/api/auth/sessions/sign-out-others", token: tLaptop, headers: Csrf);
        Assert.True(r.Status == 200 && r.Json["signed_out"]!.GetValue<int>() == 1, r.ToString());

        // the phone is out: its access token is refused and it cannot renew it
        Assert.Equal(401, (await phone.Get("/api/auth/me", tPhone)).Status);
        Assert.Equal(401, (await phone.Post("/api/auth/refresh", headers: Csrf)).Status);
        // the laptop renews with its own session and carries on
        r = await laptop.Post("/api/auth/refresh", headers: Csrf);
        Assert.True(r.Status == 200, r.ToString());
        tLaptop = r.Json["access_token"]!.GetValue<string>();
        Assert.Equal(200, (await laptop.Get("/api/auth/me", tLaptop)).Status);
        var devices = (await laptop.Get("/api/auth/sessions", tLaptop)).Json["sessions"]!.AsArray().Select(x => x!["device"]!.GetValue<string>());
        Assert.Equal(["Edge on Windows"], devices);

        Assert.Equal(1, await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action = 'account.sign_out_others'"));
    }

    [Fact]
    public async Task Needs_sign_in_and_the_header()
    {
        var phone = Factory.Browser(PhoneUa);
        Assert.Equal(401, (await phone.Get("/api/auth/sessions")).Status);
        Assert.Equal(401, (await phone.Post("/api/auth/sessions/sign-out-others", headers: Csrf)).Status);
        var token = await SignIn(phone);
        // a cross-site form cannot send the custom header
        Assert.Equal(403, (await phone.Post("/api/auth/sessions/sign-out-others", token: token)).Status);
        Assert.Equal(200, (await phone.Get("/api/auth/me", token)).Status);
    }
}
