namespace BAL.Interface;

using System.Text.Json.Nodes;
using Model.DomainModel;

public interface IPayoutsBAL
{
    /// <summary>jobs.payouts_job: on a payout day, batch unallocated available ledger balances into payouts.</summary>
    Task<int> RunScheduledAsync();

    /// <summary>Reference: ledger.create_payouts.</summary>
    Task<List<PayoutModel>> CreatePayoutsAsync(long minAmount);

    /// <summary>Reference: ledger.is_payout_day.</summary>
    JsonObject Schedule(JsonObject cfg,DateTime? now=null);
    bool IsPayoutDay(JsonObject cfg, DateOnly day);
}
