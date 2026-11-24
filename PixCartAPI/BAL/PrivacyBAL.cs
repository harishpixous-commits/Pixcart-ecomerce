using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IPrivacyBAL"/>
public class PrivacyBAL(AccountDAL account, AddressDAL addresses, OrdersDAL orders, IMySqlDapperHelper db) : IPrivacyBAL
{
    public async Task<JsonObject> ConsentAsync(UserModel user, bool marketingOptIn)
    {
        user.MarketingOptIn = marketingOptIn;
        await account.SaveUserAsync(user);
        await db.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, 'account.consent', 'user', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, eid = user.Id.ToString(), detail = $"marketing={marketingOptIn}", id = Guid.NewGuid() });
        return new JsonObject { ["marketing_opt_in"] = user.MarketingOptIn };
    }

    public async Task<JsonObject> ExportAsync(UserModel user)
    {
        var addrs = await addresses.ListAsync(user.Id);
        var ords = await orders.OrdersByUserAsync(user.Id, 0, 1000);
        return new JsonObject
        {
            ["profile"] = new JsonObject
            {
                ["name"] = user.Name, ["phone"] = user.Phone, ["email"] = user.Email,
                ["marketing_opt_in"] = user.MarketingOptIn,
                ["joined"] = user.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            },
            ["addresses"] = new JsonArray(addrs.Select(a => (JsonNode)new JsonObject
            {
                ["name"] = a.FullName, ["phone"] = a.Phone, ["line1"] = a.Line1, ["city"] = a.City, ["pincode"] = a.Pincode,
            }).ToArray()),
            ["orders"] = new JsonArray(ords.Select(o => (JsonNode)new JsonObject
            {
                ["number"] = o.Number, ["total"] = o.GrandTotal, ["status"] = o.Status,
                ["placed"] = o.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
                ["ship_to"] = JsonNode.Parse(o.ShipTo)?.DeepClone(),
            }).ToArray()),
        };
    }

    /// <summary>Right to erasure. Order and tax records are kept as the GST law requires (72 months), with the
    /// account itself anonymised so it can no longer be used or linked to the person.</summary>
    public async Task<JsonObject> DeleteAccountAsync(UserModel user)
    {
        if (user.IsAdmin) throw new ConflictException("Staff accounts are removed by the owner", "staff_account");
        var seller = await account.GetSellerByUserAsync(user.Id, null);
        if (seller is not null && seller.Status is "approved" or "submitted")
            throw new ConflictException("Close your seller account with seller support before deleting your login", "seller_active");
        var openSubs = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM sub_orders s JOIN orders o ON o.id = s.order_id " +
            "WHERE o.user_id = @userId AND s.status IN ('pending_payment', 'placed', 'confirmed', 'packed', 'shipped')",
            new { userId = user.Id });
        if (openSubs > 0)
            throw new ConflictException("You have orders on the way. You can delete your account after they are delivered or cancelled.", "open_orders");
        await using var uow = await db.BeginAsync();
        await addresses.AnonymiseAllAsync(user.Id, uow.Transaction);
        await uow.ExecuteAsync(
            "UPDATE refresh_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND revoked_at IS NULL",
            new { userId = user.Id });
        var now = DateTimeFunctions.UtcNow();
        user.Name = "Deleted user";
        user.Phone = null;
        user.Email = $"deleted-{user.Id}@deleted.invalid";
        user.PasswordHash = null;
        user.IsActive = false;
        user.DeletedAt = now;
        user.MarketingOptIn = false;
        await account.SaveUserAsync(user, uow.Transaction);
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (NULL, 'account.deleted', 'user', @eid, '', UTC_TIMESTAMP(6), @id)",
            new { eid = user.Id.ToString(), id = Guid.NewGuid() });
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true };
    }
}
