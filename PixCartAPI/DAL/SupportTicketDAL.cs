using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Customer support tickets and their messages.</summary>
public class SupportTicketDAL(IMySqlDapperHelper db)
{
    public Task<SupportTicketModel?> GetAsync(Guid id, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE id = @id", new { id }, tx);

    public Task<SupportTicketModel?> GetForUpdateAsync(Guid id, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE id = @id FOR UPDATE", new { id }, tx);

    public Task<IEnumerable<SupportTicketModel>> ForUserAsync(Guid userId, int limit) =>
        db.QueryAsync<SupportTicketModel>("SELECT * FROM support_tickets WHERE user_id = @userId ORDER BY updated_at DESC LIMIT @limit", new { userId, limit });

    public async Task<long> OpenCountAsync(Guid userId, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM support_tickets WHERE user_id = @userId AND status IN ('open', 'awaiting_customer')", new { userId }, tx);

    public async Task<bool> NumberExistsAsync(string number, IDbTransaction? tx = null) =>
        await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM support_tickets WHERE number = @number", new { number }, tx) > 0;

    public Task InsertAsync(SupportTicketModel t, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO support_tickets (number, user_id, order_id, category, subject, status, priority, assigned_to, is_grievance, ack_due_at, resolve_due_at, " +
            "acknowledged_at, resolved_at, id, created_at, updated_at) VALUES (@Number, @UserId, @OrderId, @Category, @Subject, @Status, @Priority, @AssignedTo, " +
            "@IsGrievance, @AckDueAt, @ResolveDueAt, @AcknowledgedAt, @ResolvedAt, @Id, @CreatedAt, @UpdatedAt)", t, tx);

    public Task UpdateStatusAsync(SupportTicketModel t, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE support_tickets SET status = @Status, resolved_at = @ResolvedAt, updated_at = @UpdatedAt WHERE id = @Id", t, tx);

    public Task InsertMessageAsync(TicketMessageModel m, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO ticket_messages (ticket_id, author_id, author_role, body, is_internal, created_at, id) " +
            "VALUES (@TicketId, @AuthorId, @AuthorRole, @Body, @IsInternal, @CreatedAt, @Id)", m, tx);

    public Task<IEnumerable<TicketMessageModel>> MessagesAsync(Guid ticketId, IDbTransaction? tx = null) =>
        db.QueryAsync<TicketMessageModel>("SELECT * FROM ticket_messages WHERE ticket_id = @ticketId ORDER BY created_at", new { ticketId }, tx);

    /// <summary>The order's owner, or null when there is no such order.</summary>
    public Task<Guid?> OrderOwnerAsync(Guid orderId, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<Guid?>("SELECT user_id FROM orders WHERE id = @orderId", new { orderId }, tx);
}
