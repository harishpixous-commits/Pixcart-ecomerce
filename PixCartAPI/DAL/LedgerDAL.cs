using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Seller payout batch queries (reference: services/ledger.py create_payouts / is_payout_day).</summary>
public class LedgerDAL(IMySqlDapperHelper db)
{
    public sealed class SellerBalanceRow
    {
        public string SellerId { get; set; } = "";
        public long Balance { get; set; }
    }

    public sealed class SellerBankRow
    {
        public string Holder { get; set; } = "";
        public string Last4 { get; set; } = "";
        public string Ifsc { get; set; } = "";
        public string? AccountEnc { get; set; }
    }

    /// <summary>Reference: ledger.create_payouts balance query (unallocated, available, approved sellers).</summary>
    public Task<IEnumerable<SellerBalanceRow>> PayoutBalancesAsync(DateTime now,IUnitOfWork? transaction=null) => transaction is null?db.QueryAsync<SellerBalanceRow>(
        "SELECT CAST(l.seller_id AS CHAR) AS SellerId, SUM(l.amount) AS Balance FROM seller_ledger l" +
        " JOIN sellers s ON s.id = l.seller_id" +
        " WHERE l.payout_id IS NULL AND l.available_at <= @now AND s.status = 'approved' GROUP BY l.seller_id",
        new { now }):transaction.QueryAsync<SellerBalanceRow>("SELECT CAST(l.seller_id AS CHAR) AS SellerId,SUM(l.amount) AS Balance FROM seller_ledger l JOIN sellers s ON s.id=l.seller_id WHERE l.payout_id IS NULL AND l.available_at<=@now AND s.status='approved' GROUP BY l.seller_id",new{now});

    public Task LockSellerAsync(Guid sellerId, IUnitOfWork uow) => uow.ExecuteAsync(
        "SELECT id FROM sellers WHERE id = @sellerId FOR UPDATE", new { sellerId });

    public Task<IEnumerable<string>> EntryIdsForUpdateAsync(Guid sellerId, DateTime now, IUnitOfWork uow) => uow.QueryAsync<string>(
        "SELECT CAST(id AS CHAR) AS Id FROM seller_ledger WHERE seller_id = @sellerId AND payout_id IS NULL AND available_at <= @now FOR UPDATE",
        new { sellerId, now });

    public Task<long> SumEntriesAsync(IReadOnlyCollection<string> ids, IUnitOfWork uow) => uow.ExecuteScalarAsync<long>(
        "SELECT COALESCE(SUM(amount), 0) FROM seller_ledger WHERE id IN @ids", new { ids });

    public Task<SellerBankRow?> SellerBankAsync(Guid sellerId, IUnitOfWork uow) => uow.QueryFirstOrDefaultAsync<SellerBankRow>(
        "SELECT bank_holder_name AS Holder, bank_account_last4 AS Last4, bank_ifsc AS Ifsc, bank_account_enc AS AccountEnc" +
        " FROM sellers WHERE id = @sellerId", new { sellerId });

    public Task InsertPayoutAsync(PayoutModel p, IUnitOfWork uow) => uow.ExecuteAsync(
        "INSERT INTO payouts (number, seller_id, amount, status, mode, utr, provider_payout_id, failure_reason, bank_snapshot, paid_at, id, created_at, updated_at)" +
        " VALUES (@Number, @SellerId, @Amount, @Status, @Mode, @Utr, @ProviderPayoutId, @FailureReason, CAST(@BankSnapshot AS JSON), @PaidAt, @Id, @CreatedAt, @UpdatedAt)", p);

    public Task AttachEntriesAsync(Guid payoutId, IReadOnlyCollection<string> ids, IUnitOfWork uow) => uow.ExecuteAsync(
        "UPDATE seller_ledger SET payout_id = @payoutId WHERE id IN @ids", new { payoutId, ids });

    /// <summary>Reference: create_payouts marks the sale sub-orders of the batched entries settled.</summary>
    public Task SettleSubsAsync(Guid payoutId, IUnitOfWork uow) => uow.ExecuteAsync(
        "UPDATE sub_orders SET settlement_status = 'paid' WHERE id IN" +
        " (SELECT sub_order_id FROM seller_ledger WHERE payout_id = @payoutId AND kind = 'sale')",
        new { payoutId });
}
