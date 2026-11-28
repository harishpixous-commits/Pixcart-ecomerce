using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IAccountBAL"/>
public class AccountBAL(AccountDAL accounts, AddressDAL addresses, CustomerAccountDAL customers, IMySqlDapperHelper db, IAuditBAL audit) : IAccountBAL
{
    public async Task<object> ConsentAsync(UserModel user, bool marketingOptIn)
    {
        await using var uow = await db.BeginAsync();
        var before = user.Copy();
        user.MarketingOptIn = marketingOptIn;
        await accounts.SaveUserChangesAsync(before, user, DateTimeFunctions.UtcNow(), uow.Transaction);
        await audit.AuditAsync(user, "account.consent", "user", user.Id, $"marketing={(marketingOptIn ? "True" : "False")}", uow);
        await uow.CommitAsync();
        return new { marketing_opt_in = user.MarketingOptIn };
    }

    /// <summary>Right to access: a summary of the personal data we hold.</summary>
    public async Task<object> ExportAsync(UserModel user)
    {
        var addr = await customers.AddressesAsync(user.Id);
        var orders = await customers.AllOrdersAsync(user.Id);
        var uid = user.Id;
        var tickets = (await db.QueryAsync<(string Number, string Subject, string Status, DateTime CreatedAt)>("SELECT number AS Number, subject AS Subject, status AS Status, created_at AS CreatedAt FROM support_tickets WHERE user_id = @uid ORDER BY created_at DESC LIMIT 500", new { uid })).ToList();
        var points = (await db.QueryAsync<(string Kind, int Points, string Note, DateTime CreatedAt)>("SELECT kind AS Kind, points AS Points, note AS Note, created_at AS CreatedAt FROM loyalty_ledger WHERE user_id = @uid ORDER BY created_at DESC LIMIT 500", new { uid })).ToList();
        var wished = await db.QueryFirstOrDefaultAsync<long>("SELECT COUNT(*) FROM wishlist_items WHERE user_id = @uid", new { uid });
        return new
        {
            support_tickets = tickets.Select(t => new { number = t.Number, subject = t.Subject, status = t.Status, created = DateTimeFunctions.Iso(t.CreatedAt) }).ToList(),
            loyalty = new { balance = points.Sum(x => (long)x.Points), history = points.Select(x => new { kind = x.Kind, points = x.Points, note = x.Note, at = DateTimeFunctions.Iso(x.CreatedAt) }).ToList() },
            referral_code = ReferralRewards.CodeFor(uid),
            wishlist_count = wished,
            profile = new { name = user.Name, phone = user.Phone, email = user.Email, marketing_opt_in = user.MarketingOptIn, joined = DateTimeFunctions.Iso(user.CreatedAt) },
            addresses = addr.Select(a => new { name = a.FullName, phone = a.Phone, line1 = a.Line1, city = a.City, pincode = a.Pincode }).ToList(),
            orders = orders.Select(o => new
            {
                number = o.Number, total = o.GrandTotal, status = o.Status, placed = DateTimeFunctions.Iso(o.CreatedAt), ship_to = JsonHelper.Node(o.ShipTo),
            }).ToList(),
        };
    }

    private async Task<(bool Clear, long Balance)> DeletePolicyAsync(Guid uid)
    {
        var saved = JsonHelper.Object(await db.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        var policy = (string?)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["loyalty"]!["on_account_delete"] ?? "keep";
        var bal = await db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(points), 0) FROM loyalty_ledger WHERE user_id = @uid", new { uid });
        return (policy == "zero" && bal > 0, Math.Max(0, bal));
    }

    /// <summary>What deleting the account will do to loyalty points, so the shopper is told before confirming.</summary>
    public async Task<object> DeleteInfoAsync(UserModel user)
    {
        var (clear, bal) = await DeletePolicyAsync(user.Id);
        return new { loyalty_points = bal, points_will_be_cleared = clear };
    }

    public async Task<int> DeleteAsync(UserModel user)
    {
        if (user.IsAdmin) throw new ConflictException("Staff accounts are removed by the owner", "staff_account");
        var seller = await accounts.GetSellerByUserAsync(user.Id);
        if (seller is not null && seller.Status is "approved" or "submitted")
            throw new ConflictException("Close your seller account with seller support before deleting your login", "seller_active");
        if (await customers.OpenPackagesAsync(user.Id) > 0)
            throw new ConflictException("You have orders on the way. You can delete your account after they are delivered or cancelled.", "open_orders");
        var now = DateTimeFunctions.UtcNow();
        var (clearPoints, balance) = await DeletePolicyAsync(user.Id);
        await using var uow = await db.BeginAsync();
        if (clearPoints)
            await uow.ExecuteAsync("INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @uid, NULL, 'adjust', @pts, 'Account deleted: points cleared', @now)",
                new { id = Guid.NewGuid(), uid = user.Id, pts = -(int)balance, now });
        await addresses.AnonymiseAllAsync(user.Id, uow.Transaction);
        await accounts.RevokeAllSessionsAsync(user.Id, now, uow.Transaction);
        var before = user.Copy();
        user.Name = "Deleted user";
        user.Phone = null;
        user.Email = $"deleted-{user.Id}@deleted.invalid";
        user.PasswordHash = null;
        user.IsActive = false;
        user.DeletedAt = now;
        user.MarketingOptIn = false;
        await accounts.SaveUserChangesAsync(before, user, now, uow.Transaction);
        await audit.AuditAsync(null, "account.deleted", "user", user.Id, clearPoints ? $"{balance} loyalty points cleared" : "", uow);
        await uow.CommitAsync();
        return clearPoints ? (int)balance : 0;
    }
}
