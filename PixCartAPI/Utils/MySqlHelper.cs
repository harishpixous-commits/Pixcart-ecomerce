using System.Data;
using MySqlConnector;
using Utils.Interface;

namespace Utils;

public class MySqlHelper(AppSettings settings) : IMySqlHelper
{
    public async Task<DataTable> GetDataTableAsync(string sql, IDictionary<string, object?>? parameters = null)
    {
        await using var c = new MySqlConnection(settings.ConnectionString);
        await c.OpenAsync();
        await using var cmd = Command(c, sql, parameters);
        await using var reader = await cmd.ExecuteReaderAsync();
        var table = new DataTable();
        table.Load(reader);
        return table;
    }

    public async Task<int> ExecuteNonQueryAsync(string sql, IDictionary<string, object?>? parameters = null)
    {
        await using var c = new MySqlConnection(settings.ConnectionString);
        await c.OpenAsync();
        await using var cmd = Command(c, sql, parameters);
        return await cmd.ExecuteNonQueryAsync();
    }

    private static MySqlCommand Command(MySqlConnection c, string sql, IDictionary<string, object?>? parameters)
    {
        var cmd = new MySqlCommand(sql, c);
        foreach (var (k, v) in parameters ?? new Dictionary<string, object?>()) cmd.Parameters.AddWithValue(k, v ?? DBNull.Value);
        return cmd;
    }
}
