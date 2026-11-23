using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>
/// Small shared pieces the storefront and catalogue need: the fixed-window rate limiter (rate_limit_events), the audit
/// log, a locked read-merge-write of a settings document, in-app notification rows and their templates.
/// </summary>
public class CatalogSupportDAL(IMySqlDapperHelper db)
{
    /// <summary>Counts the key's events in the window; 429 when the limit is reached, otherwise records one more.</summary>
    public async Task RateLimitAsync(string key, int limit, int windowSeconds)
    {
        var now = DateTimeFunctions.UtcNow();
        var since = now.AddSeconds(-windowSeconds);
        var count = await db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM rate_limit_events WHERE `key` = @key AND created_at >= @since", new { key, since });
        if (count >= limit) throw new TooManyRequestsException();
        await db.ExecuteAsync("INSERT INTO rate_limit_events (`key`, created_at) VALUES (@key, @now)", new { key, now });
    }

    public Task AuditAsync(Guid? actorUserId, string action, string entityType, string entityId, string detail = "") =>
        db.ExecuteAsync(
            "INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, detail, created_at) " +
            "VALUES (@id, @actorUserId, @action, @entityType, @entityId, @detail, @now)",
            new
            {
                id = Guid.NewGuid(), actorUserId, action, entityType,
                entityId = entityId.Length > 64 ? entityId[..64] : entityId,
                detail = detail.Length > 2000 ? detail[..2000] : detail, now = DateTimeFunctions.UtcNow(),
            });

    /// <summary>
    /// Locks the settings row (creating it when missing), puts the changes over the saved values and saves it, in one
    /// transaction (the reference version's with_for_update()).
    /// </summary>
    public async Task MergeSettingsAsync(string key, JsonObject changes)
    {
        await using var uow = await db.BeginAsync();
        var json = await uow.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = @key FOR UPDATE", new { key });
        var saved = JsonHelper.Object(json);
        foreach (var (k, v) in changes) saved[k] = v?.DeepClone();
        await uow.ExecuteAsync(
            "INSERT INTO platform_settings (`key`, `value`, updated_at) VALUES (@key, CAST(@value AS JSON), @now) " +
            "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)",
            new { key, value = saved.ToJsonString(), now = DateTimeFunctions.UtcNow() });
        await uow.CommitAsync();
    }

    /// <summary>Running deals with a quantity limit: (variant, limit, sold) per version (reference: deals.units_left).</summary>
    public Task<IEnumerable<(Guid VariantId, int? QtyLimit, int SoldQty)>> DealQuantitiesAsync(IEnumerable<Guid> variantIds) =>
        db.QueryAsync<(Guid, int?, int)>(
            "SELECT variant_id, qty_limit, sold_qty FROM deals WHERE variant_id IN @variantIds AND status = 'active' AND qty_limit IS NOT NULL",
            new { variantIds });

    public Task<UserModel?> GetUserAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id });

    public Task<NotificationTemplateModel?> GetTemplateAsync(string @event, string channel) =>
        db.QueryFirstOrDefaultAsync<NotificationTemplateModel>(
            "SELECT * FROM notification_templates WHERE event = @event AND channel = @channel", new { @event, channel });

    public Task InsertNotificationAsync(NotificationModel n) =>
        db.ExecuteAsync(
            "INSERT INTO notifications (id, user_id, event, channel, recipient, subject, body, link, variables, status, attempts, error, created_at, sent_at, read_at) " +
            "VALUES (@Id, @UserId, @Event, @Channel, @Recipient, @Subject, @Body, @Link, CAST(@Variables AS JSON), @Status, @Attempts, @Error, @CreatedAt, @SentAt, NULL)", n);
}
