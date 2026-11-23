using System.Text.RegularExpressions;
using DAL.Helpers;
using Utils;
using Utils.Interface;

namespace API.Configurations;

/// <summary>
/// Server commands (run in the site folder):
/// <code>dotnet API.dll create-admin --email ops@yourdomain.in --name "Ops Admin"</code>
/// creates an admin or resets the password of an existing one (from ADMIN_PASSWORD, or asked without echo), and
/// <code>dotnet API.dll migrate</code> brings the database up to date without starting the site.
/// </summary>
public static class CommandLine
{
    /// <summary>True when the arguments were a command (it has run and the process should exit).</summary>
    public static async Task<bool> TryRunAsync(string[] args, IServiceProvider services)
    {
        if (args.Length == 0 || args[0].StartsWith('-')) return false;
        switch (args[0])
        {
            case "migrate":
                await services.GetRequiredService<DatabaseMigrator>().MigrateAsync();
                Console.WriteLine("Database is up to date");
                return true;
            case "create-admin":
                await CreateAdminAsync(args, services);
                return true;
            default:
                return false;
        }
    }

    private static string? Arg(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static async Task CreateAdminAsync(string[] args, IServiceProvider services)
    {
        var email = Arg(args, "--email")?.Trim().ToLowerInvariant() ?? throw new ArgumentException("--email is required");
        var name = Arg(args, "--name") ?? "Admin";
        var pw = Environment.GetEnvironmentVariable("ADMIN_PASSWORD") ?? ReadHidden("Admin password (min 12 chars, upper, lower, digit): ");
        if (pw.Length < 12 || !Regex.IsMatch(pw, "[a-z]") || !Regex.IsMatch(pw, "[A-Z]") || !Regex.IsMatch(pw, @"\d"))
        {
            Console.Error.WriteLine("Password is too weak");
            Environment.ExitCode = 1;
            return;
        }
        await services.GetRequiredService<DatabaseMigrator>().MigrateAsync();
        var db = services.GetRequiredService<IMySqlDapperHelper>();
        var hash = EncryptDecrypt.HashPassword(pw);
        var now = DateTimeFunctions.UtcNow();
        var existing = await db.ExecuteScalarAsync<Guid?>("SELECT id FROM users WHERE email = @email", new { email });
        if (existing is { } id)
            await db.ExecuteAsync("UPDATE users SET password_hash = @hash, is_admin = 1, is_active = 1, updated_at = @now WHERE id = @id", new { hash, now, id });
        else
            await db.ExecuteAsync(
                "INSERT INTO users (id, email, name, password_hash, is_admin, is_active, created_at, updated_at) " +
                "VALUES (@id, @email, @name, @hash, 1, 1, @now, @now)", new { id = Guid.NewGuid(), email, name, hash, now });
        Console.WriteLine($"Admin ready: {email}");
    }

    private static string ReadHidden(string prompt)
    {
        Console.Write(prompt);
        var sb = new System.Text.StringBuilder();
        while (true)
        {
            var k = Console.ReadKey(true);
            if (k.Key == ConsoleKey.Enter) break;
            if (k.Key == ConsoleKey.Backspace && sb.Length > 0) sb.Length--;
            else if (!char.IsControl(k.KeyChar)) sb.Append(k.KeyChar);
        }
        Console.WriteLine();
        return sb.ToString();
    }
}
