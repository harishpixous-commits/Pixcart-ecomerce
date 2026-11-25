using System.Data;
using Dapper;
using MySqlConnector;
using Utils.Interface;

namespace Utils;

public class MySqlDapperHelper : IMySqlDapperHelper
{
    private readonly string _connectionString;

    static MySqlDapperHelper()
    {
        DefaultTypeMap.MatchNamesWithUnderscores = true;
        SqlMapper.AddTypeHandler(new DateOnlyHandler());
        SqlMapper.AddTypeHandler(new UtcDateTimeHandler());
    }

    public MySqlDapperHelper(AppSettings settings)
    {
        var b = new MySqlConnectionStringBuilder(settings.ConnectionString)
        {
            GuidFormat = MySqlGuidFormat.Char36,
            AllowUserVariables = true,
            ConvertZeroDateTime = true,
            // Pin utf8mb4 explicitly (the schema's charset) so non-ASCII text such as the rupee sign
            // is never dependent on server-negotiated defaults.
            CharacterSet = "utf8mb4",
        };
        _connectionString = b.ConnectionString;
    }

    public MySqlConnection Open() => new(_connectionString);

    public async Task<IEnumerable<T>> QueryAsync<T>(string sql, object? param = null, IDbTransaction? tx = null)
    {
        if (tx != null) return await tx.Connection!.QueryAsync<T>(sql, param, tx);
        await using var c = Open();
        return await c.QueryAsync<T>(sql, param);
    }

    public async Task<IEnumerable<TReturn>> QueryAsync<T1, T2, T3, TReturn>(string sql, Func<T1, T2, T3, TReturn> map, object? param = null, string splitOn = "id", IDbTransaction? tx = null)
    {
        if (tx != null) return await tx.Connection!.QueryAsync(sql, map, param, tx, splitOn: splitOn);
        await using var c = Open();
        return await c.QueryAsync(sql, map, param, splitOn: splitOn);
    }

    public async Task<IEnumerable<TReturn>> QueryAsync<T1, T2, T3, T4, TReturn>(string sql, Func<T1, T2, T3, T4, TReturn> map, object? param = null, string splitOn = "id", IDbTransaction? tx = null)
    {
        if (tx != null) return await tx.Connection!.QueryAsync(sql, map, param, tx, splitOn: splitOn);
        await using var c = Open();
        return await c.QueryAsync(sql, map, param, splitOn: splitOn);
    }

    public async Task<T?> QueryFirstOrDefaultAsync<T>(string sql, object? param = null, IDbTransaction? tx = null)
    {
        if (tx != null) return await tx.Connection!.QueryFirstOrDefaultAsync<T>(sql, param, tx);
        await using var c = Open();
        return await c.QueryFirstOrDefaultAsync<T>(sql, param);
    }

    public async Task<T?> ExecuteScalarAsync<T>(string sql, object? param = null, IDbTransaction? tx = null)
    {
        if (tx != null) return await tx.Connection!.ExecuteScalarAsync<T>(sql, param, tx);
        await using var c = Open();
        return await c.ExecuteScalarAsync<T>(sql, param);
    }

    public async Task<int> ExecuteAsync(string sql, object? param = null, IDbTransaction? tx = null)
    {
        if (tx != null) return await tx.Connection!.ExecuteAsync(sql, param, tx);
        await using var c = Open();
        return await c.ExecuteAsync(sql, param);
    }

    public async Task<IUnitOfWork> BeginAsync(IsolationLevel level = IsolationLevel.ReadCommitted)
    {
        var c = Open();
        await c.OpenAsync();
        var tx = await c.BeginTransactionAsync(level);
        return new UnitOfWork(c, tx);
    }

    private sealed class UnitOfWork(MySqlConnection connection, MySqlTransaction transaction) : IUnitOfWork
    {
        private bool _done;
        private readonly List<Action> _afterCommit = [];
        public void AfterCommit(Action callback)
        {
            if (_done) throw new InvalidOperationException("Transaction already completed.");
            _afterCommit.Add(callback);
        }
        public IDbConnection Connection => connection;
        public IDbTransaction Transaction => transaction;
        public Task<IEnumerable<T>> QueryAsync<T>(string sql, object? param = null) => connection.QueryAsync<T>(sql, param, transaction);
        public Task<T?> QueryFirstOrDefaultAsync<T>(string sql, object? param = null) => connection.QueryFirstOrDefaultAsync<T>(sql, param, transaction);
        public Task<T?> ExecuteScalarAsync<T>(string sql, object? param = null) => connection.ExecuteScalarAsync<T>(sql, param, transaction);
        public Task<int> ExecuteAsync(string sql, object? param = null) => connection.ExecuteAsync(sql, param, transaction);

        public async Task CommitAsync()
        {
            await transaction.CommitAsync();
            _done = true;
            foreach (var callback in _afterCommit) callback();
            _afterCommit.Clear();
        }

        public async ValueTask DisposeAsync()
        {
            if (!_done)
            {
                try { await transaction.RollbackAsync(); } catch (InvalidOperationException) { /* already finished */ }
            }
            await transaction.DisposeAsync();
            await connection.DisposeAsync();
        }
    }

    private sealed class DateOnlyHandler : SqlMapper.TypeHandler<DateOnly>
    {
        public override DateOnly Parse(object value) => value switch
        {
            DateTime dt => DateOnly.FromDateTime(dt),
            DateOnly d => d,
            _ => DateOnly.Parse(value.ToString()!),
        };

        public override void SetValue(IDbDataParameter parameter, DateOnly value)
        {
            parameter.DbType = DbType.Date;
            parameter.Value = value.ToDateTime(TimeOnly.MinValue);
        }
    }

    /// <summary>The database stores UTC; values read back are marked as UTC so they serialise with +00:00.</summary>
    private sealed class UtcDateTimeHandler : SqlMapper.TypeHandler<DateTime>
    {
        public override DateTime Parse(object value) => DateTime.SpecifyKind((DateTime)value, DateTimeKind.Utc);

        public override void SetValue(IDbDataParameter parameter, DateTime value)
        {
            parameter.DbType = DbType.DateTime;
            parameter.Value = value.Kind == DateTimeKind.Local ? value.ToUniversalTime() : value;
        }
    }
}
