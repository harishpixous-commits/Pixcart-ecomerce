using System.Data;

namespace Utils.Interface;

/// <summary>
/// Database access with Dapper (MySQL). Columns are snake_case and map to PascalCase properties automatically.
/// Use <see cref="BeginAsync"/> for work that must succeed or fail as one (an order, a payment): every call made with the
/// returned unit runs in the same transaction until <c>CommitAsync</c>; disposing without committing rolls back.
/// </summary>
public interface IMySqlDapperHelper
{
    Task<IEnumerable<T>> QueryAsync<T>(string sql, object? param = null, IDbTransaction? tx = null);
    Task<T?> QueryFirstOrDefaultAsync<T>(string sql, object? param = null, IDbTransaction? tx = null);
    Task<T?> ExecuteScalarAsync<T>(string sql, object? param = null, IDbTransaction? tx = null);
    Task<int> ExecuteAsync(string sql, object? param = null, IDbTransaction? tx = null);
    Task<IUnitOfWork> BeginAsync(IsolationLevel level = IsolationLevel.ReadCommitted);
}

/// <summary>One connection and transaction shared by several statements.</summary>
public interface IUnitOfWork : IAsyncDisposable
{
    IDbConnection Connection { get; }
    IDbTransaction Transaction { get; }
    Task<IEnumerable<T>> QueryAsync<T>(string sql, object? param = null);
    Task<T?> QueryFirstOrDefaultAsync<T>(string sql, object? param = null);
    Task<T?> ExecuteScalarAsync<T>(string sql, object? param = null);
    Task<int> ExecuteAsync(string sql, object? param = null);
    Task CommitAsync();
}
