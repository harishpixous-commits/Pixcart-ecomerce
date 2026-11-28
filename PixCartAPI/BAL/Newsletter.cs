using BAL.Interface;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>The footer newsletter box: collects email addresses. Nothing is sent from here; staff use the list themselves.</summary>
public static class Newsletter
{
    private static readonly Regex EmailRx = new(@"^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$", RegexOptions.Compiled);

    public static string? CleanEmail(string? raw)
    {
        var e = (raw ?? "").Trim().ToLowerInvariant();
        return e.Length <= 254 && EmailRx.IsMatch(e) ? e : null;
    }

    public static async Task<JsonObject> ConfigAsync(IMySqlDapperHelper db)
    {
        var saved = JsonHelper.Object(await db.QueryFirstOrDefaultAsync<string>("SELECT CAST(`value` AS CHAR) FROM platform_settings WHERE `key` = 'growth'"));
        return (JsonObject)DAL.SettingsDAL.Merge(GrowthBAL.Defaults(), saved)["newsletter"]!;
    }

    public static async Task<JsonObject> BoxAsync(IMySqlDapperHelper db)
    {
        var c = await ConfigAsync(db);
        return new() { ["enabled"] = c.Bool("enabled"), ["title"] = c.Str("title") };
    }

    public static async Task JoinAsync(IMySqlDapperHelper db, string rawEmail)
    {
        if (!(await ConfigAsync(db)).Bool("enabled")) throw new AppException("The newsletter is not open", "newsletter_off");
        var email = CleanEmail(rawEmail) ?? throw new AppException("Enter a valid email address", "invalid_email", fields: new Dictionary<string, string> { { "email", "Invalid" } });
        await db.ExecuteAsync("INSERT IGNORE INTO newsletter_subscribers (id, email, created_at) VALUES (@id, @email, UTC_TIMESTAMP(6))", new { id = Guid.NewGuid(), email });
    }

    private sealed record Row(Guid Id, string Email, DateTime CreatedAt);

    public static async Task<JsonObject> ListAsync(IMySqlDapperHelper db)
    {
        var total = await db.QueryFirstOrDefaultAsync<long>("SELECT COUNT(*) FROM newsletter_subscribers");
        var rows = await db.QueryAsync<Row>("SELECT id AS Id, email AS Email, created_at AS CreatedAt FROM newsletter_subscribers ORDER BY created_at DESC LIMIT 200");
        return new()
        {
            ["enabled"] = (await ConfigAsync(db)).Bool("enabled"), ["total"] = total,
            ["items"] = new JsonArray(rows.Select(r => (JsonNode)new JsonObject { ["id"] = r.Id.ToString(), ["email"] = r.Email, ["created_at"] = DateTime.SpecifyKind(r.CreatedAt, DateTimeKind.Utc).ToString("o") }).ToArray()),
        };
    }

    public static async Task<bool> RemoveAsync(IMySqlDapperHelper db, Guid id) => await db.ExecuteAsync("DELETE FROM newsletter_subscribers WHERE id = @id", new { id }) > 0;
}
