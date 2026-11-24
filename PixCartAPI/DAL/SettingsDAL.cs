using System.Data;
using System.Text.Json.Nodes;
using Utils;
using Utils.Interface;

namespace DAL;

/// <summary>
/// The <c>platform_settings</c> table: one JSON document per area ("auth", "regional", "site", "llm", ...).
/// Each BAL merges its own defaults over what is saved (unknown keys are ignored), like the reference version.
/// </summary>
public class SettingsDAL(IMySqlDapperHelper db)
{
    /// <summary>The saved document for a key, or an empty object.</summary>
    public async Task<JsonObject> GetAsync(string key)
    {
        var json = await db.ExecuteScalarAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = @key", new { key });
        return JsonHelper.Object(json);
    }

    public async Task<bool> ExistsAsync(string key) =>
        await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM platform_settings WHERE `key` = @key", new { key }) > 0;

    /// <summary>Replaces the document for a key (creates it when missing).</summary>
    public Task SaveAsync(string key, JsonNode value, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO platform_settings (`key`, `value`, updated_at) VALUES (@key, CAST(@value AS JSON), UTC_TIMESTAMP(6)) " +
            "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = VALUES(updated_at)",
            new { key, value = value.ToJsonString() }, tx);

    public async Task<JsonObject> GetForUpdateAsync(string key, IDbTransaction tx)
    {
        var json = await db.ExecuteScalarAsync<string>(
            "SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = @key FOR UPDATE", new { key }, tx);
        return JsonHelper.Object(json);
    }

    public Task DeleteAsync(string key) => db.ExecuteAsync("DELETE FROM platform_settings WHERE `key` = @key", new { key });

    /// <summary>Defaults with the saved values on top (only keys that exist in the defaults).</summary>
    public static JsonObject Merge(JsonObject defaults, JsonObject saved)
    {
        var outp = (JsonObject)defaults.DeepClone();
        foreach (var (k, v) in saved)
            if (outp.ContainsKey(k)) outp[k] = v?.DeepClone();
        return outp;
    }
}
