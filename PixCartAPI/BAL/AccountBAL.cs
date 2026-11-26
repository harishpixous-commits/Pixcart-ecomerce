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
        return new
        {
            profile = new { name = user.Name, phone = user.Phone, email = user.Email, marketing_opt_in = user.MarketingOptIn, joined = DateTimeFunctions.Iso(user.CreatedAt) },
            addresses = addr.Select(a => new { name = a.FullName, phone = a.Phone, line1 = a.Line1, city = a.City, pincode = a.Pincode }).ToList(),
            orders = orders.Select(o => new
            {
                number = o.Number, total = o.GrandTotal, status = o.Status, placed = DateTimeFunctions.Iso(o.CreatedAt), ship_to = JsonHelper.Node(o.ShipTo),
            }).ToList(),
        };
    }

    public async Task DeleteAsync(UserModel user)
    {
        if (user.IsAdmin) throw new ConflictException("Staff accounts are removed by the owner", "staff_account");
        var seller = await accounts.GetSellerByUserAsync(user.Id);
        if (seller is not null && seller.Status is "approved" or "submitted")
            throw new ConflictException("Close your seller account with seller support before deleting your login", "seller_active");
        if (await customers.OpenPackagesAsync(user.Id) > 0)
            throw new ConflictException("You have orders on the way. You can delete your account after they are delivered or cancelled.", "open_orders");
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
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
        await audit.AuditAsync(null, "account.deleted", "user", user.Id, uow: uow);
        await uow.CommitAsync();
    }
}
