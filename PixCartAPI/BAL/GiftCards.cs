using BAL.Interface;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Utils;
using Model.DomainModel;
using Utils.Interface;
namespace BAL;

/// <summary>Gift cards (mirror of services/gift_cards.py). Staff issue a card; the holder turns all or part of the balance into
/// a single-use platform-funded flat coupon (30 days) applied at checkout like any coupon. A coupon that runs out unused gives
/// the amount back to the card. Off unless staff switch gift cards on in Admin → Growth. Shoppers can buy a card online when allow_purchase is on: the card is issued once, only after the gateway's own records show the full amount captured (no webhook for purchases yet; the shopper's return page calls check). Razorpay is not used for this.</summary>
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

    public static async Task<JsonObject> OptionsAsync(IUnitOfWork uow)
    {
        var cfg = await CfgAsync(uow);
        return new JsonObject { ["can_buy"] = cfg.Bool("enabled") && cfg.Bool("allow_purchase"), ["min_paise"] = cfg.Int("min_paise"), ["max_paise"] = cfg.Int("max_paise") };
    }

    // ---- buying a card online (mirror of start_purchase / check_purchase)
    public sealed record Purchase(Guid Id, Guid UserId, int Amount, string Gateway, string Ref, string Status, Guid? CardId, string Error);
    private const string PurchaseSql = "SELECT id AS Id, user_id AS UserId, amount_paise AS Amount, gateway AS Gateway, gateway_ref AS Ref, status AS Status, gift_card_id AS CardId, error AS Error FROM gift_card_purchases ";

    private static JsonObject PurchaseView(Purchase p, Card? card = null)
    {
        var o = new JsonObject { ["id"] = p.Id.ToString(), ["amount_paise"] = p.Amount, ["status"] = p.Status, ["gateway"] = p.Gateway, ["error"] = p.Error };
        if (card is not null && p.Status == "issued") { o["code"] = card.Code; o["expires_at"] = DateTime.SpecifyKind(card.ExpiresAt, DateTimeKind.Utc).ToString("o"); }
        return o;
    }

    public static async Task<JsonObject> StartPurchaseAsync(IUnitOfWork uow, IPaymentGatewayBAL gateways, IIntegrationBAL integrations, UserModel user, int amountPaise)
    {
        var cfg = await CfgAsync(uow);
        if (!(cfg.Bool("enabled") && cfg.Bool("allow_purchase"))) throw new AppException("Gift cards cannot be bought right now.", "gift_cards_off");
        if (amountPaise < cfg.Int("min_paise") || amountPaise > cfg.Int("max_paise"))
            throw new AppException($"Amount must be between ₹{cfg.Int("min_paise") / 100:N0} and ₹{cfg.Int("max_paise") / 100:N0}.", "invalid_amount");
        var cands = (await gateways.EligibleAsync("INR")).Where(c => c != "razorpay").ToList();
        if (cands.Count == 0) throw new AppException("Online payment for gift cards is not available right now.", "online_unavailable", 409);
        var id = Guid.NewGuid(); var code = cands[0];
        var b = (await integrations.GetAsync()).PublicWebUrl.TrimEnd('/');
        var cust = new JsonObject { ["id"] = user.Id.ToString(), ["name"] = user.Name, ["contact"] = string.IsNullOrEmpty(user.Phone) ? "" : $"+91{user.Phone}", ["email"] = user.Email ?? "" };
        GatewayPayment made;
        try { made = await (await gateways.AdapterAsync(code)).CreateAsync(amountPaise, "INR", $"GC-{id.ToString("N")[..10]}", cust, $"{b}/api/payments/{code}/callback", $"{b}/api/payments/{code}/webhook"); }
        catch (RazorpayBAL.GatewayException e) { throw new AppException($"Could not start the payment: {e.Message}", "gateway_error", 502); }
        var data = new JsonObject { ["mode"] = made.Mode };
        foreach (var (k, v) in made.Fields) data[k] = v?.DeepClone();
        await uow.ExecuteAsync("INSERT INTO gift_card_purchases (id, user_id, amount_paise, gateway, gateway_ref, client_data, status, error, created_at) VALUES (@id, @uid, @amountPaise, @code, @r, CAST(@data AS JSON), 'created', '', @now)",
            new { id, uid = user.Id, amountPaise, code, r = made.Reference, data = data.ToJsonString(), now = DateTime.UtcNow });
        var view = PurchaseView(new Purchase(id, user.Id, amountPaise, code, made.Reference, "created", null, ""));
        view["payment"] = data;
        return view;
    }

    public static async Task<JsonObject> CheckPurchaseAsync(IUnitOfWork uow, IPaymentGatewayBAL gateways, Guid? userId, Guid purchaseId, List<Func<Task>>? afterCommit = null, BAL.Interface.ICatalogNotifyBAL? notify = null)
    {
        var p = await uow.QueryFirstOrDefaultAsync<Purchase>(PurchaseSql + "WHERE id = @purchaseId FOR UPDATE", new { purchaseId });
        if (p is null || (userId is not null && p.UserId != userId)) throw new NotFoundException("Purchase"); // staff pass null and may check anyone's
        if (p.Status == "issued") return PurchaseView(p, await uow.QueryFirstOrDefaultAsync<Card>(CardSql + "WHERE id = @id", new { id = p.CardId }));
        List<GatewayAttempt> attempts;
        try { attempts = await (await gateways.AdapterAsync(p.Gateway)).AttemptsAsync(p.Ref); }
        catch (RazorpayBAL.GatewayException) { throw new AppException("We could not reach the payment gateway. Try again in a minute.", "gateway_error", 502); }
        var done = attempts.FirstOrDefault(a => a.Status is "captured" or "authorized");
        if (done is null)
        {
            if (attempts.Count > 0 && attempts.All(a => a.Status == "failed"))
            {
                var err = attempts[0].Error.Length > 0 ? attempts[0].Error : "The payment did not go through";
                await uow.ExecuteAsync("UPDATE gift_card_purchases SET status = 'failed', error = @err WHERE id = @id", new { err = err.Length > 500 ? err[..500] : err, id = p.Id });
                p = p with { Status = "failed", Error = err };
            }
            return PurchaseView(p);
        }
        if (done.Amount != p.Amount)
        {
            const string err = "The amount paid does not match the card. Contact support.";
            await uow.ExecuteAsync("UPDATE gift_card_purchases SET status = 'failed', error = @err WHERE id = @id", new { err, id = p.Id });
            return PurchaseView(p with { Status = "failed", Error = err });
        }
        // paid in full: issue even if purchases were switched off meanwhile, the money is already taken
        var cfg = await CfgAsync(uow);
        var now = DateTime.UtcNow;
        var card = new Card(Guid.NewGuid(), "GC" + Hex(5), p.Amount, p.Amount, now.AddDays(cfg.Int("validity_days")), "active", $"Bought online ({p.Gateway})");
        await uow.ExecuteAsync("INSERT INTO gift_cards (id, code, initial_paise, balance_paise, expires_at, status, note, created_at) VALUES (@Id, @Code, @Initial, @Balance, @ExpiresAt, 'active', @Note, @now)", new { card.Id, card.Code, card.Initial, card.Balance, card.ExpiresAt, card.Note, now });
        await uow.ExecuteAsync("UPDATE gift_card_purchases SET status = 'issued', gift_card_id = @cid, error = '' WHERE id = @id", new { cid = card.Id, id = p.Id });
        // the code also goes to the buyer's email, after the commit (once: only the first check gets here)
        afterCommit?.Add(() => notify!.NotifyUserAsync(p.UserId, "gift_card_bought", new Dictionary<string, string>
        {
            ["amount"] = p.Amount % 100 == 0 ? $"₹{p.Amount / 100:N0}" : $"₹{p.Amount / 100m:N2}", ["code"] = card.Code, ["expires"] = card.ExpiresAt.ToString("dd MMM yyyy", System.Globalization.CultureInfo.InvariantCulture),
        }, "/rewards"));
        return PurchaseView(p with { Status = "issued", CardId = card.Id }, card);
    }

    public static async Task<List<JsonObject>> PurchasesAsync(IMySqlDapperHelper db) =>
        (await db.QueryAsync<(Guid Id, string? Name, string? Phone, int Amount, string Gateway, string Status, string Error, Guid? CardId, DateTime At, string Ref)>(
            "SELECT p.id AS Id, u.name AS Name, u.phone AS Phone, p.amount_paise AS Amount, p.gateway AS Gateway, p.status AS Status, p.error AS Error, p.gift_card_id AS CardId, p.created_at AS At, p.refund_reference AS Ref " +
            "FROM gift_card_purchases p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200")).Select(r => new JsonObject
        {
            ["id"] = r.Id.ToString(), ["user"] = r.Name, ["phone"] = r.Phone, ["amount_paise"] = r.Amount, ["gateway"] = r.Gateway, ["status"] = r.Status, ["error"] = r.Error,
            ["refund_reference"] = r.Ref, ["gift_card_id"] = r.CardId?.ToString(), ["created_at"] = DateTime.SpecifyKind(r.At, DateTimeKind.Utc).ToString("o"),
        }).ToList();

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
            "INSERT INTO coupons (id, code, description, kind, value, min_order_paise, ends_at, usage_limit, per_user_limit, used_count, funded_by, first_order_only, is_active, show_on_checkout, only_user_id) " +
            "VALUES (@id, @ccode, 'Gift card', 'flat', @amount, @amount, @ends, 1, 1, 0, 'platform', 0, 1, 0, @userId)", new { id = Guid.NewGuid(), userId, ccode, amount, ends = now.AddDays(CouponDays) });
        await uow.ExecuteAsync("UPDATE gift_cards SET balance_paise = balance_paise - @amount WHERE id = @id", new { amount, id = card.Id });
        await uow.ExecuteAsync("INSERT INTO gift_card_uses (id, gift_card_id, user_id, coupon_code, amount_paise, restored, created_at) VALUES (@id, @cardId, @userId, @ccode, @amount, 0, @now)",
            new { id = Guid.NewGuid(), cardId = card.Id, userId, ccode, amount, now });
        return new JsonObject { ["code"] = ccode, ["discount_paise"] = amount, ["min_order_paise"] = amount, ["valid_days"] = CouponDays, ["card_balance_paise"] = card.Balance - amount };
    }

    /// <summary>Staff give back what a shopper paid for a card that was never used (setting gift_cards.staff_refund). The card is voided and
    /// its balance zeroed; the purchase becomes 'refunded' with the staff member's payment reference. No gateway is called.</summary>
    public static async Task<(JsonObject View, Purchase P, bool Changed)> RefundPurchaseAsync(IUnitOfWork uow, Guid purchaseId, string reference)
    {
        if (!(await CfgAsync(uow)).Bool("staff_refund")) throw new AppException("Refunding bought gift cards is switched off in Admin → Growth.", "gift_refund_off");
        var reference2 = string.Join(' ', (reference ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (reference2.Length == 0 || reference2.Length > 100) throw new AppException("Enter the payment reference of the refund (up to 100 characters).", "reference_required");
        var p = await uow.QueryFirstOrDefaultAsync<Purchase>(PurchaseSql + "WHERE id = @purchaseId FOR UPDATE", new { purchaseId }) ?? throw new NotFoundException("Purchase");
        if (p.Status == "refunded") return (PurchaseView(p), p, false);
        if (p.Status != "issued" || p.CardId is null) throw new ConflictException("Only a paid purchase whose card was issued can be refunded.", "not_refundable");
        var card = await uow.QueryFirstOrDefaultAsync<Card>(CardSql + "WHERE id = @id FOR UPDATE", new { id = p.CardId });
        var used = await uow.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM gift_card_uses WHERE gift_card_id = @id", new { id = p.CardId });
        if (card is null || used > 0 || card.Balance != card.Initial) throw new ConflictException("This card has been used, so it cannot be refunded.", "card_used");
        await uow.ExecuteAsync("UPDATE gift_cards SET status = 'void', balance_paise = 0 WHERE id = @id", new { id = card.Id });
        await uow.ExecuteAsync("UPDATE gift_card_purchases SET status = 'refunded', refund_reference = @reference2, refunded_at = UTC_TIMESTAMP(6) WHERE id = @id", new { reference2, id = p.Id });
        var done = p with { Status = "refunded" };
        return (PurchaseView(done), done, true);
    }

    public static async Task<JsonObject> VoidAsync(IUnitOfWork uow, Guid id)
    {
        if (await uow.ExecuteAsync("UPDATE gift_cards SET status = 'void' WHERE id = @id", new { id }) == 0) throw new NotFoundException("Gift card");
        return Item((await uow.QueryFirstOrDefaultAsync<Card>(CardSql + "WHERE id = @id", new { id }))!);
    }
}
