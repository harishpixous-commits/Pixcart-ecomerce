using BAL.Interface;
using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Referral rewards (mirror of services/referral.py). A customer shares a code derived from their id. A new customer
/// with no orders enters it once. When the friend's first package is delivered and worth at least the minimum, both get the
/// reward as loyalty points (reward in rupees / value of one point). Off unless staff switch it on in Admin → Growth.</summary>
public static class ReferralRewards
{
    public const string Prefix = "PX";
    public static string CodeFor(Guid userId) => Prefix + userId.ToString("N")[..8].ToUpperInvariant();

    private const string GrowthSql = "SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'";
    public static async Task<JsonObject> GrowthAsync(IMySqlDapperHelper db) => DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), JsonHelper.Object(await db.ExecuteScalarAsync<string>(GrowthSql)));
    private static async Task<JsonObject> GrowthAsync(IUnitOfWork uow) => DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), JsonHelper.Object(await uow.ExecuteScalarAsync<string>(GrowthSql)));

    public static async Task<JsonObject> SummaryAsync(IMySqlDapperHelper db, Guid userId)
    {
        var cfg = (JsonObject)(await GrowthAsync(db))["referral"]!;
        var rows = (await db.QueryAsync<(string Status, int Reward)>("SELECT status AS Status, reward_paise AS Reward FROM referrals WHERE referrer_id = @userId", new { userId })).ToList();
        var used = await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM referrals WHERE referee_id = @userId", new { userId });
        return new JsonObject
        {
            ["enabled"] = cfg.Bool("enabled"), ["code"] = CodeFor(userId), ["referrer_reward_paise"] = cfg.Int("referrer_reward_paise"), ["friend_reward_paise"] = cfg.Int("friend_reward_paise"),
            ["min_order_paise"] = cfg.Int("min_order_paise"), ["joined"] = rows.Count, ["rewarded"] = rows.Count(r => r.Status == "rewarded"),
            ["earned_paise"] = rows.Sum(r => (long)r.Reward), ["used_code"] = used > 0,
        };
    }

    public static async Task<JsonObject> ApplyAsync(IMySqlDapperHelper db, Guid userId, string code)
    {
        var cfg = (JsonObject)(await GrowthAsync(db))["referral"]!;
        if (!cfg.Bool("enabled")) throw new AppException("Referral rewards are not available right now.", "referral_off");
        code = (code ?? "").Trim().ToUpperInvariant();
        Guid? referrer = null;
        if (code.StartsWith(Prefix) && code.Length == Prefix.Length + 8 && code[Prefix.Length..].All(Uri.IsHexDigit))
            referrer = await db.ExecuteScalarAsync<Guid?>("SELECT id FROM users WHERE REPLACE(id, '-', '') LIKE @p LIMIT 1", new { p = code[Prefix.Length..].ToLowerInvariant() + "%" });
        if (referrer is null) throw new AppException("That referral code is not valid.", "invalid_code");
        if (referrer == userId) throw new AppException("You cannot use your own code.", "own_code");
        if (await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM referrals WHERE referee_id = @userId", new { userId }) > 0) throw new AppException("You have already used a referral code.", "already_used", 409);
        if (await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM orders WHERE user_id = @userId", new { userId }) > 0) throw new AppException("Referral codes are for new customers, before the first order.", "not_new");
        await db.ExecuteAsync("INSERT INTO referrals (id, referrer_id, referee_id, status, reward_paise, created_at) VALUES (@id, @referrer, @userId, 'joined', 0, @now)",
            new { id = Guid.NewGuid(), referrer, userId, now = DateTime.UtcNow });
        return new JsonObject { ["ok"] = true, ["friend_reward_paise"] = cfg.Int("friend_reward_paise"), ["min_order_paise"] = cfg.Int("min_order_paise") };
    }

    public static async Task<IReadOnlyList<JsonObject>> ListAsync(IMySqlDapperHelper db)
    {
        var rows = await db.QueryAsync<(string Referrer, string Friend, string Status, int Reward, DateTime At)>(
            "SELECT COALESCE(NULLIF(a.name,''), a.phone, a.email, '') AS Referrer, COALESCE(NULLIF(b.name,''), b.phone, b.email, '') AS Friend, r.status AS Status, r.reward_paise AS Reward, r.created_at AS At " +
            "FROM referrals r JOIN users a ON a.id = r.referrer_id JOIN users b ON b.id = r.referee_id ORDER BY r.created_at DESC LIMIT 200");
        return rows.Select(r => new JsonObject { ["referrer"] = r.Referrer, ["friend"] = r.Friend, ["status"] = r.Status, ["reward_paise"] = r.Reward, ["at"] = DateTime.SpecifyKind(r.At, DateTimeKind.Utc).ToString("o") }).ToList();
    }

    /// <summary>Called when a package is delivered, inside the caller's transaction. True when both sides were rewarded.</summary>
    public static async Task<bool> RewardAsync(IUnitOfWork uow, long itemsTotal, Guid userId)
    {
        var all = await GrowthAsync(uow);
        var cfg = (JsonObject)all["referral"]!;
        if (!cfg.Bool("enabled")) return false;
        var ref_ = await uow.QueryFirstOrDefaultAsync<(Guid Id, Guid Referrer, string Status)?>("SELECT id AS Id, referrer_id AS Referrer, status AS Status FROM referrals WHERE referee_id = @userId FOR UPDATE", new { userId });
        if (ref_ is null || ref_.Value.Status != "joined" || itemsTotal < cfg.Int("min_order_paise")) return false;
        var unit = Math.Max(1, ((JsonObject)all["loyalty"]!).Int("point_value_paise"));
        var done = await uow.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM referrals WHERE referrer_id = @r AND status = 'rewarded'", new { r = ref_.Value.Referrer });
        var now = DateTime.UtcNow;
        if (done >= cfg.Int("max_per_user"))
        {
            await uow.ExecuteAsync("UPDATE referrals SET status = 'capped' WHERE id = @id", new { id = ref_.Value.Id });
            return false;
        }
        foreach (var (uid, paise, note) in new[] { (userId, (long)cfg.Int("friend_reward_paise"), "Referral welcome reward"), (ref_.Value.Referrer, (long)cfg.Int("referrer_reward_paise"), "Referral reward for a friend's first order") })
        {
            var points = (int)(paise / unit);
            if (points > 0)
                await uow.ExecuteAsync("INSERT INTO loyalty_ledger (id, user_id, sub_order_id, kind, points, note, created_at) VALUES (@id, @uid, NULL, 'adjust', @points, @note, @now)",
                    new { id = Guid.NewGuid(), uid, points, note, now });
        }
        await uow.ExecuteAsync("UPDATE referrals SET status = 'rewarded', reward_paise = @paise, rewarded_at = @now WHERE id = @id", new { paise = cfg.Int("referrer_reward_paise"), now, id = ref_.Value.Id });
        return true;
    }
}
