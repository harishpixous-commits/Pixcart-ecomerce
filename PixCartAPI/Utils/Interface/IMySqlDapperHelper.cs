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
    Task<IEnumerable<TReturn>> QueryAsync<T1, T2, T3, TReturn>(string sql, Func<T1, T2, T3, TReturn> map, object? param = null, string splitOn = "id", IDbTransaction? tx = null);
    Task<IEnumerable<TReturn>> QueryAsync<T1, T2, T3, T4, TReturn>(string sql, Func<T1, T2, T3, T4, TReturn> map, object? param = null, string splitOn = "id", IDbTransaction? tx = null);
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
    /// <summary>Runs only after a successful commit; discarded on rollback/disposal.</summary>
    void AfterCommit(Action callback);
    Task CommitAsync();
}
