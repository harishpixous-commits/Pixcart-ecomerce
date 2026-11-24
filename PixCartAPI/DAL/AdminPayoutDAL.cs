using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminPayoutDAL(IMySqlDapperHelper db)
{
    public sealed class DueRow{public string Seller{get;set;}="";public long Amount{get;set;}}
    public Task<long> CountAsync(string? status,Guid? seller)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM payouts p JOIN sellers s ON s.id=p.seller_id WHERE (@status IS NULL OR @status='' OR p.status=@status) AND (@seller IS NULL OR p.seller_id=@seller)",new{status,seller});
    public Task<IEnumerable<PayoutModel>> ListAsync(string? status,Guid? seller,int page)=>db.QueryAsync<PayoutModel>("SELECT p.* FROM payouts p JOIN sellers s ON s.id=p.seller_id WHERE (@status IS NULL OR @status='' OR p.status=@status) AND (@seller IS NULL OR p.seller_id=@seller) ORDER BY p.created_at DESC LIMIT 50 OFFSET @offset",new{status,seller,offset=(long)(page-1)*50});
    public Task<SellerModel?> SellerAsync(Guid id)=>db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id=@id",new{id});
    public Task<IEnumerable<DueRow>> DueAsync(DateTime now)=>db.QueryAsync<DueRow>("SELECT s.display_name AS seller,SUM(l.amount) AS amount FROM seller_ledger l JOIN sellers s ON s.id=l.seller_id WHERE l.payout_id IS NULL AND l.available_at<=@now GROUP BY s.display_name HAVING SUM(l.amount)>0",new{now});
    public Task<PayoutModel?> LockAsync(Guid id,IUnitOfWork uow)=>uow.QueryFirstOrDefaultAsync<PayoutModel>("SELECT * FROM payouts WHERE id=@id FOR UPDATE",new{id});
    public Task SaveAsync(PayoutModel p,IUnitOfWork uow)=>uow.ExecuteAsync("UPDATE payouts SET status=@Status,utr=@Utr,failure_reason=@FailureReason,bank_snapshot=CAST(@BankSnapshot AS JSON),paid_at=@PaidAt,updated_at=@UpdatedAt WHERE id=@Id",p);
    public async Task ReleaseAsync(Guid id,IUnitOfWork uow){await uow.ExecuteAsync("UPDATE sub_orders SET settlement_status='pending' WHERE settlement_status='paid' AND id IN (SELECT sub_order_id FROM seller_ledger WHERE payout_id=@id AND kind='sale')",new{id});await uow.ExecuteAsync("UPDATE seller_ledger SET payout_id=NULL WHERE payout_id=@id",new{id});}
}
