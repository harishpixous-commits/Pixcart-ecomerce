using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>payment_gateway_events: each gateway's calls, for routing, the circuit breaker and Admin → Payments.</summary>
public class PaymentEventsDAL(IMySqlDapperHelper db)
{
    public sealed class Totals
    {
        public string Gateway { get; set; } = "";
        public long Attempts { get; set; }
        public long Good { get; set; }
        public long TotalMs { get; set; }
    }

    public sealed class LastError
    {
        public string Error { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    /// <summary>On its own connection: the event is kept even when the caller's transaction rolls back.</summary>
    public Task InsertAsync(PaymentGatewayEventModel e) => db.ExecuteAsync(
        "INSERT INTO payment_gateway_events (id, gateway, ok, ms, error, created_at) VALUES (@Id, @Gateway, @Ok, @Ms, @Error, @CreatedAt)", e);

    /// <summary>The newest events of a gateway, newest first.</summary>
    public Task<IEnumerable<PaymentGatewayEventModel>> LatestAsync(string gateway, int count) => db.QueryAsync<PaymentGatewayEventModel>(
        "SELECT id, gateway, ok, ms, error, created_at FROM payment_gateway_events WHERE gateway = @gateway ORDER BY created_at DESC LIMIT @count",
        new { gateway, count });

    public Task<IEnumerable<Totals>> TotalsAsync(IEnumerable<string> gateways, DateTime since) => db.QueryAsync<Totals>(
        "SELECT gateway AS Gateway, COUNT(*) AS Attempts, CAST(COALESCE(SUM(ok), 0) AS SIGNED) AS Good, CAST(COALESCE(SUM(ms), 0) AS SIGNED) AS TotalMs " +
        "FROM payment_gateway_events WHERE gateway IN @gateways AND created_at >= @since GROUP BY gateway",
        new { gateways = gateways.ToArray(), since });

    /// <summary>The time at a 1-based position of the gateway's sorted times since <paramref name="since"/>.</summary>
    public Task<int> MsAtAsync(string gateway, DateTime since, int position) => db.ExecuteScalarAsync<int>(
        "SELECT ms FROM payment_gateway_events WHERE gateway = @gateway AND created_at >= @since ORDER BY ms LIMIT 1 OFFSET @offset",
        new { gateway, since, offset = position - 1 });

    public Task<LastError?> LastErrorAsync(string gateway, DateTime since) => db.QueryFirstOrDefaultAsync<LastError>(
        "SELECT error AS Error, created_at AS CreatedAt FROM payment_gateway_events WHERE gateway = @gateway AND created_at >= @since AND ok = 0 " +
        "ORDER BY created_at DESC LIMIT 1", new { gateway, since });

    public Task<int> PruneAsync(DateTime before) => db.ExecuteAsync("DELETE FROM payment_gateway_events WHERE created_at < @before", new { before });
}
