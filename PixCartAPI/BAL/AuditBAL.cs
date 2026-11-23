using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IAuditBAL"/>
public class AuditBAL(AuditDAL dal) : IAuditBAL
{
    public Task AuditAsync(UserModel? actor, string action, string entityType, object entityId, string detail = "", IUnitOfWork? uow = null) =>
        dal.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(),
            ActorUserId = actor?.Id,
            Action = action,
            EntityType = entityType,
            EntityId = Convert.ToString(entityId, System.Globalization.CultureInfo.InvariantCulture) ?? "",
            Detail = detail.Length > 2000 ? detail[..2000] : detail,
            CreatedAt = DateTimeFunctions.UtcNow(),
        }, uow?.Transaction);
}
