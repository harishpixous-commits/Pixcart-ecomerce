using Utils;

namespace Tests;

/// <summary>
/// Ported from tests/test_security_guards.py: staff with the "customers" permission cannot sign staff out or take over a
/// seller by changing the owner's mobile; two-step sign-in cannot be guessed off or removed quietly.
/// </summary>
public class SecurityGuardTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Customers_permission_cannot_touch_staff_or_take_over_sellers()
    {
        var admin = await Admin();
        var support = await Staff(admin, "desk@kadai.in", "support"); // has "customers", not "sellers"
        var leaver = await Staff(admin, "leaver@kadai.in", "operations");
        // the owner switches a departing employee off in Staff and roles
        Assert.Equal(200, (await admin.Patch($"/api/admin/staff/{leaver.Id}", new { is_active = false })).Status);
        Assert.Equal(401, (await leaver.Get("/api/auth/me")).Status);
        var r = await support.Post($"/api/admin/customers/{admin.Id}/sign-out");
        Assert.True(r.Status == 409 && r.ErrorCode == "invalid_target", r.ToString());
        r = await support.Patch($"/api/admin/customers/{leaver.Id}", new { name = "Back Again" });
        Assert.True(r.Status == 409 && r.ErrorCode == "invalid_target", r.ToString());

        // a seller's owner: support may fix the name, not the mobile or email they sign in with
        var sid = (await admin.Post("/api/admin/sellers", new { phone = "9400000001", name = "Kovai", store_name = "Kovai Textiles" })).Json["user_id"]!.GetValue<string>();
        Assert.Equal(200, (await support.Patch($"/api/admin/customers/{sid}", new { name = "Kovai Owner" })).Status);
        r = await support.Patch($"/api/admin/customers/{sid}", new { phone = "9811111111" });
        Assert.True(r.Status == 403 && r.ErrorMessage!.Contains("manage sellers"), r.ToString());
        Assert.Equal(403, (await support.Patch($"/api/admin/customers/{sid}", new { email = "thief@example.com" })).Status);
        // the owner role may, and the seller is told on the old contact details first
        r = await admin.Patch($"/api/admin/customers/{sid}", new { phone = "9811111111" });
        Assert.True(r.Status == 200, r.ToString());
        var bodies = await ApiFactory.DbQueryAsync<string>("SELECT body FROM notifications WHERE user_id = @sid AND event = 'security_notice'", new { sid });
        Assert.NotEmpty(bodies);
        Assert.Contains("mobile number", bodies[0]);
    }

    [Fact]
    public async Task Turning_off_two_step_needs_the_password_and_is_rate_limited()
    {
        var admin = await Admin();
        var lockUser = await Staff(admin, "lock@kadai.in", "support", "Support@Desk2026");
        var secret = (await lockUser.Post("/api/auth/totp/setup")).Json["secret"]!.GetValue<string>();
        Assert.Equal(200, (await lockUser.Post("/api/auth/totp/enable", new { code = TotpHelper.Current(secret) })).Status);
        // a stolen session without the password cannot remove it, even with a valid code
        var r = await lockUser.Post("/api/auth/totp/disable", new { code = TotpHelper.Current(secret) });
        Assert.True(r.Status == 400 && r.ErrorCode == "wrong_password", r.ToString());
        // every code attempt counts (turning it on was the 1st, the refused one above the 2nd): 5 in 15 minutes, then refused
        for (var i = 0; i < 2; i++)
            Assert.Equal(400, (await lockUser.Post("/api/auth/totp/disable", new { code = "000000", password = "Support@Desk2026" })).Status);
        r = await lockUser.Post("/api/auth/totp/disable", new { code = TotpHelper.Current(secret), password = "Support@Desk2026" });
        Assert.True(r.Status == 200, r.ToString()); // 5th attempt, right code and password
        Assert.False((await lockUser.Get("/api/auth/me")).Json["totp_enabled"]!.GetValue<bool>());
        var subjects = await ApiFactory.DbQueryAsync<string>("SELECT subject FROM notifications WHERE user_id = @id AND event = 'security_notice'", new { id = lockUser.Id });
        Assert.NotEmpty(subjects);
        Assert.Contains("two-step sign-in", subjects[0].ToLowerInvariant());
        Assert.Equal(429, (await lockUser.Post("/api/auth/totp/enable", new { code = "123456" })).Status);
    }

    [Fact]
    public async Task Password_login_with_two_step()
    {
        var admin = await Admin();
        var secret = (await admin.Post("/api/auth/totp/setup")).Json["secret"]!.GetValue<string>();
        Assert.Equal("totp_on", (await admin.Post("/api/auth/totp/enable", new { code = TotpHelper.Current(secret) }) is { Status: 200 }
            ? await admin.Post("/api/auth/totp/setup") : null)!.ErrorCode);
        var c = Factory.Browser();
        var r = await c.Post("/api/auth/login", new { email = "admin@pixcart.in", password = AdminPassword });
        Assert.True(r.Status == 401 && r.ErrorCode == "totp_required", r.ToString());
        r = await c.Post("/api/auth/login", new { email = "admin@pixcart.in", password = AdminPassword, totp = "000000" == TotpHelper.Current(secret) ? "111111" : "000000" });
        Assert.Equal(401, r.Status);
        r = await c.Post("/api/auth/login", new { email = "admin@pixcart.in", password = AdminPassword, totp = TotpHelper.Current(secret) });
        Assert.True(r.Status == 200, r.ToString());
    }
}
