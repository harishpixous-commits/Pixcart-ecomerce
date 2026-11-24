using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>Cross-module staff operations (reference: routers/admin.py): package cancel/deliver, refund list,
/// retry and manual settle, customer block/unblock and platform settings read/write.</summary>
public class AdminOpsBAL(
    AdminOpsDAL adminOps,
    OrdersDAL ordersDal,
    IOrdersBAL ordersBal,
    IDeliveryFleetBAL fleet,
    IPlatformSettingsBAL platformSettings,
    IAccessBAL access,
    IRefundQueue refundQueue,
    IMySqlDapperHelper db) : IAdminOpsBAL
{
    private static async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, string entityType,
        string entityId, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, @entityType, @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, entityType, eid = entityId, detail, id = Guid.NewGuid() });

    public async Task<JsonObject> CancelSubOrderAsync(UserModel admin, Guid subId, string reason)
    {
        await access.RequireAsync(admin, "orders");
        await using var uow = await db.BeginAsync();
        var s = await ordersDal.SubForUpdateAsync(subId, uow) ?? throw new NotFoundException("Sub-order");
        var refund = await ordersBal.CancelSubOrderAsync(s, "admin", reason, uow);
        await AuditAsync(uow, admin, "suborder.admin_cancel", "sub_order", s.Id.ToString(), reason);
        var refundId = refund?.Id;
        await uow.CommitAsync();
        if (refundId is not null) refundQueue.Enqueue([refundId.Value]);
        var order = await ordersDal.GetOrderAsync(s.OrderId) ?? throw new NotFoundException("Order");
        return await ordersBal.DetailAsync(order, forAdmin: true);
    }

    public async Task<JsonObject> DeliverSubOrderAsync(UserModel admin, Guid subId)
    {
        await access.RequireAsync(admin, "orders");
        await using var uow = await db.BeginAsync();
        var s = await ordersDal.SubForUpdateAsync(subId, uow) ?? throw new NotFoundException("Sub-order");
        // Reference: admin_deliver — when our delivery partner has the package, close the trip too (fee, tip,
        // cash counted as with the partner); otherwise a plain status change.
        var closed = s.ShippingProvider == "fleet" && await fleet.StaffDeliverForSubAsync(admin, s, uow);
        if (!closed)
            await ordersBal.TransitionAsync(s, "delivered", "admin", "Marked delivered by admin", uow);
        await AuditAsync(uow, admin, "suborder.admin_deliver", "sub_order", s.Id.ToString());
        await uow.CommitAsync();
        var order = await ordersDal.GetOrderAsync(s.OrderId) ?? throw new NotFoundException("Order");
        return await ordersBal.DetailAsync(order, forAdmin: true);
    }

    public async Task<JsonObject> ListRefundsAsync(UserModel admin, string? status, string q, int page)
    {
        await access.RequireAsync(admin, "refunds");
        q = q.Trim();
        if (q.Length > 40) throw new AppException("q must be at most 40 characters", "validation", 422);
        var total = await adminOps.CountRefundsAsync(status, q);
        var rows = await adminOps.ListRefundsAsync(status, q, (page - 1) * 50);
        var items = new JsonArray();
        foreach (var r in rows)
            items.Add(new JsonObject
            {
                ["id"] = r.Id.ToString(), ["order_id"] = r.OrderId.ToString(), ["order_number"] = r.OrderNumber,
                ["amount"] = r.AmountPaise, ["status"] = r.Status, ["reason"] = r.Reason, ["attempts"] = r.Attempts,
                ["last_error"] = r.LastError,
                ["created_at"] = r.CreatedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            });
        return new JsonObject { ["total"] = total, ["page"] = page, ["page_size"] = 50, ["items"] = items };
    }

    public async Task<JsonObject> RetryRefundAsync(UserModel admin, Guid refundId)
    {
        await access.RequireAsync(admin, "refunds");
        await using var uow = await db.BeginAsync();
        var r = await adminOps.RefundForUpdateAsync(refundId, uow) ?? throw new NotFoundException("Refund");
        if (r.Status != "failed")
            throw new ConflictException("Only failed refunds can be retried", "invalid_status");
        // Reference: retry_refund — back to pending, fresh attempts, provider id cleared; the worker re-runs it.
        await uow.ExecuteAsync(
            "UPDATE refunds SET status = 'pending', attempts = 0, provider_refund_id = NULL WHERE id = @refundId",
            new { refundId });
        await AuditAsync(uow, admin, "refund.retry", "refund", r.Id.ToString());
        await uow.CommitAsync();
        refundQueue.Enqueue([refundId]);
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> SettleRefundAsync(UserModel admin, Guid refundId, string method, string refInput)
    {
        await access.RequireAsync(admin, "refunds");
        await using var uow = await db.BeginAsync();
        var r = await adminOps.RefundForUpdateAsync(refundId, uow) ?? throw new NotFoundException("Refund");
        if (r.Status is not ("failed" or "pending"))
            throw new ConflictException("Only refunds that have not gone through can be settled by hand", "invalid_status");
        // Reference: settle_refund — manual:{method}:{squashed reference}, truncated at 40 characters.
        var reference = $"manual:{method}:{string.Join(' ', refInput.Split(' ', StringSplitOptions.RemoveEmptyEntries))}";
        if (reference.Length > 40) reference = reference[..40];
        if (await adminOps.RefundReferenceUsedAsync(reference, uow))
            throw new ConflictException("This reference is already recorded on another refund", "reference_used");
        await uow.ExecuteAsync(
            "UPDATE refunds SET status = 'processed', provider_refund_id = @reference, last_error = '' WHERE id = @refundId",
            new { reference, refundId });
        await AuditAsync(uow, admin, "refund.settle_manual", "refund", r.Id.ToString(), $"{method} {refInput}");
        await uow.CommitAsync();
        r.Status = "processed";
        r.ProviderRefundId = reference;
        r.LastError = "";
        await ordersBal.NotifyRefundProcessedAsync(r);
        return new JsonObject { ["ok"] = true, ["status"] = r.Status, ["reference"] = reference };
    }

    public async Task<JsonObject> BlockUserAsync(UserModel admin, Guid userId, string reason)
    {
        await access.RequireAsync(admin, "customers");
        await using var uow = await db.BeginAsync();
        var u = await adminOps.UserForUpdateAsync(userId, uow) ?? throw new NotFoundException("User");
        if (u.Id == admin.Id || u.IsAdmin)
            throw new ConflictException("Admins cannot be blocked here", "invalid_target");
        // Reference: block_user — deactivated and every live refresh session revoked.
        await uow.ExecuteAsync("UPDATE users SET is_active = 0 WHERE id = @userId", new { userId });
        await uow.ExecuteAsync(
            "UPDATE refresh_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND revoked_at IS NULL",
            new { userId });
        await AuditAsync(uow, admin, "user.block", "user", u.Id.ToString(), reason);
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> UnblockUserAsync(UserModel admin, Guid userId)
    {
        await access.RequireAsync(admin, "customers");
        await using var uow = await db.BeginAsync();
        var u = await adminOps.UserForUpdateAsync(userId, uow) ?? throw new NotFoundException("User");
        // Reference: staff (and owners) are switched on and off only in Staff and roles.
        if (u.IsAdmin)
            throw new ConflictException("Staff accounts are managed in Staff and roles", "invalid_target");
        await uow.ExecuteAsync("UPDATE users SET is_active = 1 WHERE id = @userId", new { userId });
        await AuditAsync(uow, admin, "user.unblock", "user", u.Id.ToString());
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> ReadSettingsAsync(UserModel admin)
    {
        await access.RequireAsync(admin, "settings");
        return await platformSettings.GetAsync();
    }

    public async Task<JsonObject> WriteSettingsAsync(UserModel admin, JsonObject body)
    {
        await access.RequireAsync(admin, "settings");
        var result = await platformSettings.UpdateAsync(body);
        await using var uow = await db.BeginAsync();
        var detail = body.ToJsonString();
        if (detail.Length > 1000) detail = detail[..1000];
        await AuditAsync(uow, admin, "settings.update", "settings", "marketplace", detail);
        await uow.CommitAsync();
        return result;
    }
}
