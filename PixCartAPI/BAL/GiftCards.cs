using BAL.Interface;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Gift cards (mirror of services/gift_cards.py). Staff issue a card; the holder turns all or part of the balance into
/// a single-use platform-funded flat coupon (30 days) applied at checkout like any coupon. A coupon that runs out unused gives
/// the amount back to the card. Off unless staff switch gift cards on in Admin → Growth. Not built: shoppers buying a card online.</summary>
public static class GiftCards
{
    public const int CouponDays = 30;
    private static string Hex(int bytes) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes));

    private static async Task<JsonObject> CfgAsync(IUnitOfWork uow)
    {
        var saved = JsonHelper.Object(await uow.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        return (JsonObject)DAL.SettingsDAL.Merge(BAL.GrowthBAL.Defaults(), saved)["gift_cards"]!;
    }

    private sealed record Card(Guid Id, string Code, int Initial, int Balance, DateTime ExpiresAt, string Status, string Note);
    private const string CardSql = "SELECT id AS Id, code AS Code, initial_paise AS Initial, balance_paise AS Balance, expires_at AS ExpiresAt, status AS Status, note AS Note FROM gift_cards ";

    private static JsonObject View(Card c) => new()
    {
        ["balance_paise"] = c.Balance, ["initial_paise"] = c.Initial, ["expires_at"] = DateTime.SpecifyKind(c.ExpiresAt, DateTimeKind.Utc).ToString("o"),
        ["status"] = c.Status == "active" && c.ExpiresAt <= DateTime.UtcNow ? "expired" : c.Status,
    };
    private static JsonObject Item(Card c) { var o = View(c); o["id"] = c.Id.ToString(); o["code"] = c.Code; o["note"] = c.Note; return o; }

    public static async Task<List<JsonObject>> IssueAsync(IUnitOfWork uow, int amountPaise, string note, int quantity, int? validityDays)
    {
        var cfg = await CfgAsync(uow);
        if (!cfg.Bool("enabled")) throw new AppException("Gift cards are switched off in Admin → Growth.", "gift_cards_off");
        if (amountPaise < cfg.Int("min_paise") || amountPaise > cfg.Int("max_paise"))
            throw new AppException($"Amount must be between ₹{cfg.Int("min_paise") / 100:N0} and ₹{cfg.Int("max_paise") / 100:N0}.", "invalid_amount");
        var now = DateTime.UtcNow; var items = new List<JsonObject>();
        for (var i = 0; i < quantity; i++)
        {
            var card = new Card(Guid.NewGuid(), "GC" + Hex(5), amountPaise, amountPaise, now.AddDays(validityDays ?? cfg.Int("validity_days")), "active", (note ?? "").Trim());
            await uow.ExecuteAsync("INSERT INTO gift_cards (id, code, initial_paise, balance_paise, expires_at, status, note, created_at) VALUES (@Id, @Code, @Initial, @Balance, @ExpiresAt, 'active', @Note, @now)", new { card.Id, card.Code, card.Initial, card.Balance, card.ExpiresAt, card.Note, now });
            items.Add(Item(card));
        }
        return items;
    }

    public static async Task<List<JsonObject>> ListAsync(IMySqlDapperHelper db) =>
        (await db.QueryAsync<Card>(CardSql + "ORDER BY created_at DESC LIMIT 200")).Select(Item).ToList();

    private static async Task<int> RestoreExpiredAsync(IUnitOfWork uow, Guid cardId)
    {
        var now = DateTime.UtcNow;
        var uses = (await uow.QueryAsync<(Guid Id, string Coupon, int Amount)>("SELECT id AS Id, coupon_code AS Coupon, amount_paise AS Amount FROM gift_card_uses WHERE gift_card_id = @cardId AND restored = 0", new { cardId })).ToList();
        var back = 0;
        foreach (var (id, coupon, amount) in uses)
        {
            var ok = await uow.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM coupons WHERE code = @coupon AND used_count = 0 AND ends_at IS NOT NULL AND ends_at <= @now", new { coupon, now });
            if (ok == 0) continue;
            await uow.ExecuteAsync("UPDATE gift_card_uses SET restored = 1 WHERE id = @id", new { id });
            back += amount;
        }
        if (back > 0) await uow.ExecuteAsync("UPDATE gift_cards SET balance_paise = balance_paise + @back WHERE id = @cardId", new { back, cardId });
        return back;
    }

    private static async Task<Card> FindAsync(IUnitOfWork uow, string code, bool lockRow)
    {
        var card = await uow.QueryFirstOrDefaultAsync<Card>(CardSql + "WHERE code = @code" + (lockRow ? " FOR UPDATE" : ""), new { code = (code ?? "").Trim().ToUpperInvariant() });
        return card ?? throw new AppException("That gift card code is not valid.", "invalid_code");
    }

    public static async Task<JsonObject> BalanceAsync(IUnitOfWork uow, string code)
    {
        if (!(await CfgAsync(uow)).Bool("enabled")) throw new AppException("Gift cards are not available right now.", "gift_cards_off");
        var card = await FindAsync(uow, code, true);
        await RestoreExpiredAsync(uow, card.Id);
        return View(await FindAsync(uow, code, false));
    }

    public static async Task<JsonObject> RedeemAsync(IUnitOfWork uow, Guid userId, string code, int? amountPaise)
    {
        if (!(await CfgAsync(uow)).Bool("enabled")) throw new AppException("Gift cards are not available right now.", "gift_cards_off");
        var card = await FindAsync(uow, code, true);
        var now = DateTime.UtcNow;
        if (card.Status != "active" || card.ExpiresAt <= now) throw new AppException("This gift card is not valid any more.", "card_unavailable");
        await RestoreExpiredAsync(uow, card.Id);
        card = await FindAsync(uow, code, false);
        var amount = amountPaise ?? card.Balance;
        if (amount <= 0 || amount > card.Balance) throw new AppException("That is more than the balance on this card.", "balance_too_low");
        var ccode = "GV" + Hex(4);
        await uow.ExecuteAsync(
            "INSERT INTO coupons (id, code, description, kind, value, min_order_paise, ends_at, usage_limit, per_user_limit, used_count, funded_by, first_order_only, is_active, show_on_checkout) " +
            "VALUES (@id, @ccode, 'Gift card', 'flat', @amount, @amount, @ends, 1, 1, 0, 'platform', 0, 1, 0)", new { id = Guid.NewGuid(), ccode, amount, ends = now.AddDays(CouponDays) });
        await uow.ExecuteAsync("UPDATE gift_cards SET balance_paise = balance_paise - @amount WHERE id = @id", new { amount, id = card.Id });
        await uow.ExecuteAsync("INSERT INTO gift_card_uses (id, gift_card_id, user_id, coupon_code, amount_paise, restored, created_at) VALUES (@id, @cardId, @userId, @ccode, @amount, 0, @now)",
            new { id = Guid.NewGuid(), cardId = card.Id, userId, ccode, amount, now });
        return new JsonObject { ["code"] = ccode, ["discount_paise"] = amount, ["min_order_paise"] = amount, ["valid_days"] = CouponDays, ["card_balance_paise"] = card.Balance - amount };
    }

    public static async Task<JsonObject> VoidAsync(IUnitOfWork uow, Guid id)
    {
        if (await uow.ExecuteAsync("UPDATE gift_cards SET status = 'void' WHERE id = @id", new { id }) == 0) throw new NotFoundException("Gift card");
        return Item((await uow.QueryFirstOrDefaultAsync<Card>(CardSql + "WHERE id = @id", new { id }))!);
    }
}
