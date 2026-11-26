using DAL;
using Microsoft.Extensions.DependencyInjection;

namespace Tests;

/// <summary>
/// Account writes carry only what an action changed: a change someone else made meanwhile (an admin blocking the
/// account) survives, and an action that changes nothing writes nothing.
/// </summary>
public class AccountWritesTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Saving_an_account_writes_only_the_changed_fields()
    {
        var customer = await LoginPhone("9500000101", "Asha");
        var id = Guid.Parse(customer.Id);
        using var scope = Factory.Services.CreateScope();
        var accounts = scope.ServiceProvider.GetRequiredService<AccountDAL>();
        var loaded = (await accounts.GetUserAsync(id))!;

        // meanwhile an admin blocks the account
        await ApiFactory.DbExecAsync("UPDATE users SET is_active = 0 WHERE id = @id", new { id = customer.Id });
        var before = loaded.Copy();
        loaded.Name = "Asha K";
        Assert.True(await accounts.SaveUserChangesAsync(before, loaded, DateTime.UtcNow));
        Assert.False(await ApiFactory.DbScalarAsync<bool>("SELECT is_active FROM users WHERE id = @id", new { id = customer.Id }));
        Assert.Equal("Asha K", await ApiFactory.DbScalarAsync<string>("SELECT name FROM users WHERE id = @id", new { id = customer.Id }));

        // no change: no write, updated_at stays
        var stamp = await ApiFactory.DbScalarAsync<DateTime>("SELECT updated_at FROM users WHERE id = @id", new { id = customer.Id });
        Assert.False(await accounts.SaveUserChangesAsync(loaded.Copy(), loaded, DateTime.UtcNow.AddMinutes(5)));
        Assert.Equal(stamp, await ApiFactory.DbScalarAsync<DateTime>("SELECT updated_at FROM users WHERE id = @id", new { id = customer.Id }));
    }

    [Fact]
    public async Task A_staff_edit_that_changes_nothing_writes_nothing()
    {
        var admin = await Admin();
        var support = await Staff(admin, "same.edit@kadai.in", "support");
        var stamp = await ApiFactory.DbScalarAsync<DateTime>("SELECT updated_at FROM users WHERE id = @id", new { id = support.Id });
        var r = await admin.Patch($"/api/admin/staff/{support.Id}", new { role = "support" });
        Assert.Equal(200, r.Status);
        Assert.Equal(stamp, await ApiFactory.DbScalarAsync<DateTime>("SELECT updated_at FROM users WHERE id = @id", new { id = support.Id }));
    }
}
