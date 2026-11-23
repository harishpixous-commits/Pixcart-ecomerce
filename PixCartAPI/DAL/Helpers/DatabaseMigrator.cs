using System.Reflection;
using Dapper;
using Microsoft.Extensions.Logging;
using MySqlConnector;
using Utils;

namespace DAL.Helpers;

/// <summary>
/// Brings the MySQL database up to date at startup: runs the embedded scripts DAL/Helpers/Scripts/V###__name.sql that
/// have not run yet, in order, and records each in <c>schema_versions</c>. A database lock keeps two servers from
/// migrating at the same time. To change the schema, add a new script with the next number (never edit an old one).
/// </summary>
public class DatabaseMigrator(AppSettings settings, ILogger<DatabaseMigrator> log)
{
    public async Task MigrateAsync(CancellationToken ct = default)
    {
        await EnsureDatabaseAsync(ct);
        await using var c = new MySqlConnection(settings.ConnectionString);
        await c.OpenAsync(ct);
        await c.ExecuteAsync("SELECT GET_LOCK('pixcart_migrations', 120)");
        try
        {
            await c.ExecuteAsync(
                "CREATE TABLE IF NOT EXISTS schema_versions (version VARCHAR(80) NOT NULL PRIMARY KEY, applied_at DATETIME(6) NOT NULL) ENGINE=InnoDB");
            var done = (await c.QueryAsync<string>("SELECT version FROM schema_versions")).ToHashSet();
            foreach (var (version, sql) in Scripts())
            {
                if (done.Contains(version)) continue;
                log.LogInformation("Applying database script {Version}", version);
                await using (var cmd = new MySqlCommand(sql, c) { CommandTimeout = 600 })
                    await cmd.ExecuteNonQueryAsync(ct);
                await c.ExecuteAsync("INSERT INTO schema_versions (version, applied_at) VALUES (@version, UTC_TIMESTAMP(6))", new { version });
            }
        }
        finally
        {
            await c.ExecuteAsync("SELECT RELEASE_LOCK('pixcart_migrations')");
        }
    }

    /// <summary>Creates the database itself when the user is allowed to (local development).</summary>
    private async Task EnsureDatabaseAsync(CancellationToken ct)
    {
        var b = new MySqlConnectionStringBuilder(settings.ConnectionString);
        var name = b.Database;
        if (string.IsNullOrEmpty(name)) return;
        b.Database = "";
        try
        {
            await using var c = new MySqlConnection(b.ConnectionString);
            await c.OpenAsync(ct);
            await c.ExecuteAsync($"CREATE DATABASE IF NOT EXISTS `{name.Replace("`", "")}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
        }
        catch (MySqlException e)
        {
            log.LogDebug("Could not create the database (it may already exist): {Message}", e.Message);
        }
    }

    /// <summary>The embedded scripts, ordered by their version number.</summary>
    public static IEnumerable<(string Version, string Sql)> Scripts()
    {
        var asm = Assembly.GetExecutingAssembly();
        return asm.GetManifestResourceNames()
            .Where(n => n.Contains(".Scripts.V") && n.EndsWith(".sql"))
            .Select(n =>
            {
                var file = n[(n.IndexOf(".Scripts.", StringComparison.Ordinal) + 9)..^4];
                using var s = asm.GetManifestResourceStream(n)!;
                using var r = new StreamReader(s);
                return (Version: file, Sql: r.ReadToEnd());
            })
            .OrderBy(x => int.Parse(x.Version[1..x.Version.IndexOf("__", StringComparison.Ordinal)]))
            .ToList();
    }
}
