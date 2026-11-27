using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Make N copies of a platform coupon, each with its own random code (mirror of admin_extras.generate_coupons). Single-use copies can
/// be redeemed once in total and stay off the checkout list.</summary>
public static class CouponBatch
{
    const string Chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

    public static async Task<JsonObject> GenerateAsync(IMySqlDapperHelper db, UserModel admin, Guid couponId, int count, string prefix, bool singleUse)
    {
        if (count is < 1 or > 200) throw new AppException("Count must be 1 to 200", "invalid_count", 400);
        prefix = (prefix ?? "").Trim().ToUpperInvariant();
        if (prefix.Length is < 2 or > 10 || !prefix.All(char.IsAsciiLetterOrDigit)) throw new AppException("The prefix must be 2 to 10 letters or digits", "invalid_prefix", 400);
        await using var tx = await db.BeginAsync();
        var b = await tx.QueryFirstOrDefaultAsync<(string Description, string Kind, int Value, long? Max, long MinOrder, DateTime? Starts, DateTime? Ends, int? Limit, string Funded, Guid? Category, bool First, bool Active, Guid? OnlyUser)?>(
            "SELECT description AS Description, kind AS Kind, value AS Value, max_discount_paise AS Max, min_order_paise AS MinOrder, starts_at AS Starts, ends_at AS Ends, usage_limit AS `Limit`, funded_by AS Funded, category_id AS Category, first_order_only AS First, is_active AS Active, only_user_id AS OnlyUser FROM coupons WHERE id = @couponId", new { couponId });
        if (b is null) throw new NotFoundException("Coupon");
        var c = b.Value;
        if (c.Funded != "platform" || c.OnlyUser is not null) throw new AppException("Only a platform coupon can be copied in bulk", "not_copyable", 400);
        var codes = new List<string>();
        while (codes.Count < count)
        {
            var want = Enumerable.Range(0, count - codes.Count).Select(_ => prefix + new string(Enumerable.Range(0, 6).Select(_ => Chars[RandomNumberGenerator.GetInt32(Chars.Length)]).ToArray())).Distinct().ToList();
            var taken = (await tx.QueryAsync<string>("SELECT code FROM coupons WHERE code IN @want", new { want })).ToHashSet();
            codes.AddRange(want.Where(w => !taken.Contains(w) && !codes.Contains(w)));
        }
        foreach (var code in codes)
            await tx.ExecuteAsync(@"INSERT INTO coupons (id, code, description, kind, value, max_discount_paise, min_order_paise, starts_at, ends_at, usage_limit, per_user_limit, used_count, funded_by, category_id, first_order_only, is_active, show_on_checkout)
                VALUES (@id, @code, @d, @k, @v, @max, @min, @s, @e, @lim, 1, 0, 'platform', @cat, @first, @active, 0)",
                new { id = Guid.NewGuid(), code, d = c.Description, k = c.Kind, v = c.Value, max = c.Max, min = c.MinOrder, s = c.Starts, e = c.Ends, lim = singleUse ? 1 : c.Limit, cat = c.Category, first = c.First, active = c.Active });
        await tx.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, 'coupon.generate', 'coupon', @eid, '', UTC_TIMESTAMP(6), @id)",
            new { by = admin.Id, eid = $"{couponId} x{codes.Count}", id = Guid.NewGuid() });
        await tx.CommitAsync();
        return new JsonObject { ["count"] = codes.Count, ["codes"] = new JsonArray(codes.Select(x => (JsonNode)x).ToArray()) };
    }
}
