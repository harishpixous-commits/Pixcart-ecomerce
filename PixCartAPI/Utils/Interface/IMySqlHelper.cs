using System.Data;

namespace Utils.Interface;

/// <summary>Plain ADO.NET access for the few places that need a DataTable (exports, reports with dynamic columns).</summary>
public interface IMySqlHelper
{
    Task<DataTable> GetDataTableAsync(string sql, IDictionary<string, object?>? parameters = null);
    Task<int> ExecuteNonQueryAsync(string sql, IDictionary<string, object?>? parameters = null);
}
