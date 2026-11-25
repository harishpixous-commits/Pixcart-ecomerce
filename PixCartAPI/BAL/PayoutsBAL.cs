namespace BAL;

using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

/// <summary>Seller payout batching (reference: services/ledger.py create_payouts, is_payout_day; jobs.payouts_job).</summary>
public class PayoutsBAL(LedgerDAL ledger, IPlatformSettingsBAL platform, IIntegrationBAL integrations, IMySqlDapperHelper db,EncryptDecrypt crypto) : IPayoutsBAL
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);
    private static readonly DateOnly WeekZero = new(2024, 1, 1); // Monday (reference: _WEEK_ZERO)

    public bool IsPayoutDay(JsonObject cfg, DateOnly day)
    {
        var weekday = ((int)day.DayOfWeek + 6) % 7; // Python weekday(): Monday = 0
        var weeks = (day.DayNumber - WeekZero.DayNumber) / 7;
        var every = (int)Math.Max(1, cfg.Long("payout_every_weeks"));
        return weekday == (int)cfg.Long("payout_weekday") && weeks % every == 0;
    }

    public JsonObject Schedule(JsonObject cfg,DateTime? at=null)
    {
        var now=DateTime.SpecifyKind(at??DateTimeFunctions.UtcNow(),DateTimeKind.Utc);DateTime? next=null;
        if(cfg.Bool("auto_payouts"))
        {
            var today=DateOnly.FromDateTime(now+Ist);
            for(var n=0;n<15;n++) {var day=today.AddDays(n);var run=DateTime.SpecifyKind(day.ToDateTime(new TimeOnly(10,0))-Ist,DateTimeKind.Utc);if(run>now&&IsPayoutDay(cfg,day)){next=run;break;}}
        }
        return new JsonObject{["auto"]=cfg.Bool("auto_payouts"),["weekday"]=cfg.Int("payout_weekday"),["every_weeks"]=cfg.Int("payout_every_weeks"),["min_paise"]=cfg.Long("payout_min_paise"),["next_at"]=next is {} when?DateTimeFunctions.Iso(when):null};
    }
    /// <summary>Reference: jobs.payouts_job — fires daily at 10:00 IST and only pays out on a payout day.</summary>
    public async Task<int> RunScheduledAsync()
    {
        var cfg = await platform.GetAsync();
        var todayIst = DateOnly.FromDateTime(DateTimeFunctions.UtcNow() + Ist);
        if (!cfg.Bool("auto_payouts") || !IsPayoutDay(cfg, todayIst)) return 0;
        return (await CreatePayoutsAsync(cfg.Long("payout_min_paise"))).Count;
    }

    /// <summary>
    /// Reference: ledger.create_payouts. Whole batch is committed atomically; an optional caller transaction includes audit.
    /// </summary>
    public async Task<List<PayoutModel>> CreatePayoutsAsync(long minAmount,IUnitOfWork? transaction=null)
    {
        if(transaction is null){await using var owned=await db.BeginAsync();var result=await CreatePayoutsAsync(minAmount,owned);await owned.CommitAsync();return result;}
        var uow=transaction;
        var now = DateTimeFunctions.UtcNow();
        var mode = (await integrations.GetAsync()).PayoutMode;
        var made = new List<PayoutModel>();
        foreach (var row in await ledger.PayoutBalancesAsync(now,uow))
        {
            var sellerId = Guid.Parse(row.SellerId);
            if (row.Balance < minAmount) continue;
            await ledger.LockSellerAsync(sellerId, uow);
            var ids = (await ledger.EntryIdsForUpdateAsync(sellerId, now, uow)).ToList();
            var total = ids.Count == 0 ? 0 : await ledger.SumEntriesAsync(ids, uow);
            if (ids.Count == 0 || total == 0 || total < minAmount) continue;
            var bank = await ledger.SellerBankAsync(sellerId, uow);
            var account=crypto.Decrypt(bank?.AccountEnc);
            var snapshot = new JsonObject
            {
                ["holder"] = bank?.Holder ?? "",
                ["account_last4"] = account.Length>4?account[^4..]:account,
                ["ifsc"] = bank?.Ifsc ?? "",
                ["account_enc"] = bank?.AccountEnc,
            };
            var p = new PayoutModel
            {
                Id = Guid.NewGuid(),
                Number = ("PO" + now.ToString("yyMMdd") + Guid.NewGuid().ToString("N")[..6]).ToUpperInvariant(),
                SellerId = sellerId,
                Amount = total,
                Status = "pending",
                Mode = mode,
                BankSnapshot = snapshot.ToJsonString(),
                CreatedAt = now,
                UpdatedAt = now,
            };
            await ledger.InsertPayoutAsync(p, uow);
            await ledger.AttachEntriesAsync(p.Id, ids, uow);
            await ledger.SettleSubsAsync(p.Id, uow);
            made.Add(p);
        }
        return made;
    }
}
