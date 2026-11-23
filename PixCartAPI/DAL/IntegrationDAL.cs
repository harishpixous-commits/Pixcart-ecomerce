using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Inbound webhook receipts (each provider event is handled once), cached provider log-ins, and the package a courier update is about.</summary>
public class IntegrationDAL(IMySqlDapperHelper db)
{
    /// <summary>Records a webhook event; false when it was already received (a retry).</summary>
    public async Task<bool> RecordWebhookOnceAsync(string provider, string eventId, string eventType, DateTime at, IDbTransaction? tx = null) =>
        await db.ExecuteAsync(
            "INSERT IGNORE INTO webhook_events (provider, event_id, event_type, received_at, id) VALUES (@provider, @eventId, @eventType, @at, @id)",
            new { provider, eventId, eventType, at, id = Guid.NewGuid() }, tx) == 1;

    /// <summary>When each provider's webhook last reached us, and how many times.</summary>
    public async Task<Dictionary<string, (DateTime At, long Count)>> LastWebhooksAsync()
    {
        var rows = await db.QueryAsync<WebhookStat>(
            "SELECT provider AS Provider, MAX(received_at) AS At, COUNT(*) AS N FROM webhook_events GROUP BY provider");
        return rows.ToDictionary(r => r.Provider, r => (DateTime.SpecifyKind(r.At, DateTimeKind.Utc), r.N));
    }

    private sealed class WebhookStat
    {
        public string Provider { get; set; } = "";
        public DateTime At { get; set; }
        public long N { get; set; }
    }

    /// <summary>A platform_settings document locked until the transaction ends (empty object when missing).</summary>
    public async Task<System.Text.Json.Nodes.JsonObject> GetSettingForUpdateAsync(string key, IDbTransaction tx) =>
        Utils.JsonHelper.Object(await db.ExecuteScalarAsync<string>(
            "SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = @key FOR UPDATE", new { key }, tx));

    public Task SaveSettingAsync(string key, System.Text.Json.Nodes.JsonNode value, IDbTransaction tx) =>
        db.ExecuteAsync(
            "INSERT INTO platform_settings (`key`, `value`, updated_at) VALUES (@key, CAST(@value AS JSON), UTC_TIMESTAMP(6)) " +
            "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)",
            new { key, value = value.ToJsonString() }, tx);

    public Task DeleteTokenAsync(string provider) => db.ExecuteAsync("DELETE FROM integration_tokens WHERE provider = @provider", new { provider });

    /// <summary>The package with this courier tracking number, locked until the transaction ends.</summary>
    public Task<SubOrderModel?> SubOrderByAwbForUpdateAsync(string awb, IDbTransaction tx) =>
        db.QueryFirstOrDefaultAsync<SubOrderModel>("SELECT * FROM sub_orders WHERE tracking_number = @awb LIMIT 1 FOR UPDATE", new { awb }, tx);
}
