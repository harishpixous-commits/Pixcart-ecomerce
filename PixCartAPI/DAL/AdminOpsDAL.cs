using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>One row of the staff refund list (reference: routers/admin.py list_refunds).</summary>
public class RefundListRow
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }
    public string OrderNumber { get; set; } = "";
    public long AmountPaise { get; set; }
    public string Status { get; set; } = "";
    public string Reason { get; set; } = "";
    public int Attempts { get; set; }
    public string LastError { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

/// <summary>Staff operations that cut across modules (reference: routers/admin.py refund and customer
/// endpoints): locked refund rows, the refund list and locked user rows.</summary>
public class AdminOpsDAL(IMySqlDapperHelper db)
{
    /// <summary>One refund row, locked (reference: retry_refund / settle_refund FOR UPDATE).</summary>
    public Task<RefundModel?> RefundForUpdateAsync(Guid refundId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<RefundModel>("SELECT * FROM refunds WHERE id = @refundId FOR UPDATE", new { refundId });

    /// <summary>Whether a manual settlement reference is already recorded (reference: settle_refund's check).</summary>
    public async Task<bool> RefundReferenceUsedAsync(string providerRefundId, IUnitOfWork uow) =>
        await uow.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM refunds WHERE provider_refund_id = @providerRefundId", new { providerRefundId }) > 0;

    private const string RefundFrom = "FROM refunds r JOIN orders o ON o.id = r.order_id " +
        "WHERE (@status IS NULL OR r.status = @status) AND (@q = '' OR o.number LIKE CONCAT('%', @q, '%'))";

    public async Task<long> CountRefundsAsync(string? status, string q) =>
        await db.ExecuteScalarAsync<long>($"SELECT COUNT(*) {RefundFrom}", new { status, q });

    public async Task<List<RefundListRow>> ListRefundsAsync(string? status, string q, int offset) =>
        (await db.QueryAsync<RefundListRow>(
            "SELECT r.id AS Id, r.order_id AS OrderId, o.number AS OrderNumber, r.amount_paise AS AmountPaise, " +
            "r.status AS Status, r.reason AS Reason, r.attempts AS Attempts, r.last_error AS LastError, " +
            $"r.created_at AS CreatedAt {RefundFrom} " +
            "ORDER BY r.created_at DESC LIMIT 50 OFFSET @offset", new { status, q, offset })).ToList();

    /// <summary>One user row, locked (reference: block_user / unblock_user).</summary>
    public Task<UserModel?> UserForUpdateAsync(Guid userId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @userId FOR UPDATE", new { userId });
}
