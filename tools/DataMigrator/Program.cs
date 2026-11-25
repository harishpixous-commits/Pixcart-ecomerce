// PixCart data copy: PostgreSQL (the Python version) → MySQL (the .NET version).
//
//   dotnet run --project tools/DataMigrator -- --from "Host=localhost;Port=5433;Database=pixcart;Username=postgres;Password=..."
//                                             --to   "Server=127.0.0.1;Port=3307;Database=pixcart;User=pixcart;Password=..."
//                                             [--media-from <python backend var/media> --media-to <.NET var/media>] [--yes]
//
// Copies every row of every table (same table and column names on both sides), converting UUIDs, JSON, times (UTC)
// and booleans; the MySQL schema must exist first (start the .NET API once, or run `dotnet API.dll migrate`).
// The target tables are emptied first, so run it on a new database or one you are happy to replace.
// Keep App:FieldEncryptionKey equal to the Python FIELD_ENCRYPTION_KEY: encrypted PAN, bank numbers and API keys are
// copied as they are and decrypt with the same key.
using System.Text.Json;
using MySqlConnector;
using Npgsql;

string? Arg(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }

var from = Arg("--from") ?? throw new ArgumentException("--from <PostgreSQL connection string> is required");
var to = Arg("--to") ?? throw new ArgumentException("--to <MySQL connection string> is required");
var mediaFrom = Arg("--media-from");
var mediaTo = Arg("--media-to");

if (!args.Contains("--yes"))
{
    Console.Write("This empties the MySQL tables and copies everything from PostgreSQL. Continue? (yes/no) ");
    if (Console.ReadLine()?.Trim().ToLowerInvariant() != "yes") return 1;
}

await using var pg = new NpgsqlConnection(from);
await pg.OpenAsync();
await using var my = new MySqlConnection(new MySqlConnectionStringBuilder(to) { AllowUserVariables = true, GuidFormat = MySqlGuidFormat.Char36 }.ConnectionString);
await my.OpenAsync();

// tables present on both sides
var mysqlTables = new HashSet<string>();
await using (var cmd = new MySqlCommand("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()", my))
await using (var r = await cmd.ExecuteReaderAsync())
    while (await r.ReadAsync()) mysqlTables.Add(r.GetString(0));
var pgTables = new List<string>();
await using (var cmd = new NpgsqlCommand("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version' ORDER BY tablename", pg))
await using (var r = await cmd.ExecuteReaderAsync())
    while (await r.ReadAsync()) pgTables.Add(r.GetString(0));
var tables = pgTables.Where(mysqlTables.Contains).ToList();
var missing = pgTables.Except(tables).ToList();
if (missing.Count > 0) Console.WriteLine($"Not in MySQL (skipped): {string.Join(", ", missing)}");

await Exec(my, "SET FOREIGN_KEY_CHECKS = 0");
long total = 0;
foreach (var table in tables)
{
    // MySQL columns that can be written: computed columns (VIRTUAL/STORED GENERATED, like active_sub_order_id) are
    // skipped. Not "DEFAULT_GENERATED": MySQL marks every column with a default expression that way (JSON columns,
    // created_at), and skipping those silently dropped all JSON data and every original timestamp.
    var myCols = new Dictionary<string, string>();
    await using (var cmd = new MySqlCommand(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = @t AND extra NOT LIKE '%VIRTUAL GENERATED%' AND extra NOT LIKE '%STORED GENERATED%'", my))
    {
        cmd.Parameters.AddWithValue("@t", table);
        await using var r = await cmd.ExecuteReaderAsync();
        while (await r.ReadAsync()) myCols[r.GetString(0)] = r.GetString(1);
    }
    await Exec(my, $"DELETE FROM `{table}`");

    await using var read = new NpgsqlCommand($"SELECT * FROM \"{table}\"", pg);
    await using var reader = await read.ExecuteReaderAsync();
    var cols = Enumerable.Range(0, reader.FieldCount).Select(i => reader.GetName(i)).Where(myCols.ContainsKey).ToList();
    var ordinals = cols.Select(reader.GetOrdinal).ToList();
    var sqlHead = $"INSERT INTO `{table}` ({string.Join(", ", cols.Select(c => $"`{c}`"))}) VALUES ";
    var batch = new List<object?[]>();
    long count = 0;

    while (await reader.ReadAsync())
    {
        var row = new object?[cols.Count];
        for (var c = 0; c < cols.Count; c++) row[c] = ToMySql(reader, ordinals[c], myCols[cols[c]]);
        batch.Add(row);
        count++;
        if (batch.Count >= 200) await Flush(my, sqlHead, cols, myCols, batch);
    }
    await Flush(my, sqlHead, cols, myCols, batch);
    total += count;
    Console.WriteLine($"{table,-32} {count,8} rows");
}
await Exec(my, "SET FOREIGN_KEY_CHECKS = 1");
Console.WriteLine($"Copied {total} rows from {tables.Count} tables.");

if (!string.IsNullOrEmpty(mediaFrom) && !string.IsNullOrEmpty(mediaTo) && Directory.Exists(mediaFrom))
{
    var n = 0;
    foreach (var file in Directory.EnumerateFiles(mediaFrom, "*", SearchOption.AllDirectories))
    {
        var dest = Path.Combine(mediaTo, Path.GetRelativePath(mediaFrom, file));
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        File.Copy(file, dest, overwrite: true);
        n++;
    }
    Console.WriteLine($"Copied {n} media files to {mediaTo}");
}
return 0;

static async Task Flush(MySqlConnection my, string sqlHead, List<string> cols, Dictionary<string, string> myCols, List<object?[]> batch)
{
    if (batch.Count == 0) return;
    await using var tx = await my.BeginTransactionAsync();
    await using var ins = new MySqlCommand { Connection = my, Transaction = tx };
    var rows = new List<string>();
    for (var b = 0; b < batch.Count; b++)
    {
        var ph = new List<string>();
        for (var c = 0; c < cols.Count; c++)
        {
            var name = $"@p{b}_{c}";
            ph.Add(myCols[cols[c]] == "json" ? $"CAST({name} AS JSON)" : name);
            ins.Parameters.AddWithValue(name, batch[b][c] ?? DBNull.Value);
        }
        rows.Add("(" + string.Join(", ", ph) + ")");
    }
    ins.CommandText = sqlHead + string.Join(", ", rows);
    await ins.ExecuteNonQueryAsync();
    await tx.CommitAsync();
    batch.Clear();
}

static object? ToMySql(NpgsqlDataReader r, int i, string mysqlType)
{
    if (r.IsDBNull(i)) return null;
    var v = r.GetValue(i);
    return v switch
    {
        Guid g => g.ToString(),
        DateTime dt => dt.Kind == DateTimeKind.Local ? dt.ToUniversalTime() : DateTime.SpecifyKind(dt, DateTimeKind.Utc),
        DateTimeOffset dto => dto.UtcDateTime,
        DateOnly d => d.ToDateTime(TimeOnly.MinValue),
        bool b => b,
        string s when mysqlType == "json" => s,
        JsonDocument jd => jd.RootElement.GetRawText(),
        _ when mysqlType == "json" => JsonSerializer.Serialize(v),
        _ => v,
    };
}

static async Task Exec(MySqlConnection c, string sql)
{
    await using var cmd = new MySqlCommand(sql, c);
    await cmd.ExecuteNonQueryAsync();
}
