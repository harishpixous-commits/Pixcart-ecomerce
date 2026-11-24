using System.Data;
using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>The <c>audit_logs</c> table: who changed what, and when.</summary>
public class AuditDAL(IMySqlDapperHelper db)
{
    public Task InsertAsync(AuditLogModel a, IDbTransaction? tx = null) =>
        db.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@ActorUserId, @Action, @EntityType, @EntityId, @Detail, @CreatedAt, @Id)", a, tx);

    /// <summary>The newest entries about one record (e.g. a customer's history).</summary>
    public Task<IEnumerable<AuditLogModel>> ForEntityAsync(string entityType, string entityId, int limit) =>
        db.QueryAsync<AuditLogModel>(
            "SELECT * FROM audit_logs WHERE entity_type = @entityType AND entity_id = @entityId ORDER BY created_at DESC LIMIT @limit",
            new { entityType, entityId, limit });
}
