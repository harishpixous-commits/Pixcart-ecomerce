using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Notifications (the outbox: in-app rows are sent at once, email/SMS/WhatsApp rows wait for the dispatcher) and their templates.</summary>
public class NotificationDAL(IMySqlDapperHelper db)
{
    public Task<NotificationTemplateModel?> GetTemplateAsync(string evt, string channel, IDbTransaction? tx = null) =>
        db.QueryFirstOrDefaultAsync<NotificationTemplateModel>(
            "SELECT * FROM notification_templates WHERE event = @evt AND channel = @channel", new { evt, channel }, tx);

    public Task InsertAsync(NotificationModel n, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO notifications (user_id, event, channel, recipient, subject, body, link, variables, status, attempts, error, created_at, sent_at, read_at, id) " +
            "VALUES (@UserId, @Event, @Channel, @Recipient, @Subject, @Body, @Link, CAST(@Variables AS JSON), @Status, @Attempts, @Error, @CreatedAt, @SentAt, @ReadAt, @Id)",
            n, tx);

    /// <summary>A page of the user's in-app notifications, newest first.</summary>
    public Task<IEnumerable<NotificationModel>> InAppPageAsync(Guid userId, int offset, int limit) =>
        db.QueryAsync<NotificationModel>(
            "SELECT * FROM notifications WHERE user_id = @userId AND channel = 'inapp' ORDER BY created_at DESC LIMIT @limit OFFSET @offset",
            new { userId, offset, limit });

    public async Task<long> UnreadCountAsync(Guid userId) =>
        await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM notifications WHERE user_id = @userId AND channel = 'inapp' AND read_at IS NULL", new { userId });

    public Task<int> MarkAllReadAsync(Guid userId, DateTime at) =>
        db.ExecuteAsync("UPDATE notifications SET read_at = @at WHERE user_id = @userId AND read_at IS NULL", new { userId, at });

    /// <summary>Waiting email/SMS/WhatsApp rows, oldest first, locked (rows another server is sending are skipped).</summary>
    public Task<IEnumerable<NotificationModel>> PendingForUpdateAsync(int limit, IDbTransaction tx) =>
        db.QueryAsync<NotificationModel>(
            "SELECT * FROM notifications WHERE status = 'pending' ORDER BY created_at LIMIT @limit FOR UPDATE SKIP LOCKED", new { limit }, tx);

    public Task UpdateDeliveryAsync(NotificationModel n, IDbTransaction? tx = null) =>
        db.ExecuteAsync("UPDATE notifications SET status = @Status, attempts = @Attempts, error = @Error, sent_at = @SentAt WHERE id = @Id", n, tx);
}
