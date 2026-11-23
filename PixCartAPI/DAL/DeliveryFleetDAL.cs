using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>delivery_assignments + order_status_logs + delivery_cash_deposits (reference: services/fleet.py queries).
/// Trip steps run inside a unit of work like the order transitions they drive.</summary>
public class DeliveryFleetDAL(IMySqlDapperHelper db)
{
    public static readonly string[] Active = ["offered", "accepted", "at_store", "picked", "on_the_way", "reached"];
    public static readonly string[] OnTrip = ["accepted", "at_store", "picked", "on_the_way", "reached"];

    // ------------------------------------------------------------------------- assignments

    public Task<DeliveryAssignmentModel?> AssignmentForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE id = @id FOR UPDATE", new { id });

    public async Task<DeliveryAssignmentModel?> ActiveForSubAsync(Guid subOrderId, IUnitOfWork uow) =>
        (await uow.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE sub_order_id = @subOrderId AND status IN ('offered','accepted','at_store','picked','on_the_way','reached') ORDER BY created_at DESC LIMIT 1", new { subOrderId })).FirstOrDefault();

    public Task<int> InsertAsync(DeliveryAssignmentModel a, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO delivery_assignments
                (id, order_id, sub_order_id, delivery_boy_id, assigned_by, mode, kind, return_id, status,
                 reject_reason, assigned_at, expires_at, accepted_at, status_at, cod_amount, cod_collected,
                 cod_method, proof_photo, fee_paise, tip_paise, bonus_paise, fail_reason, rating_comment, created_at)
            VALUES
                (@Id, @OrderId, @SubOrderId, @DeliveryBoyId, @AssignedBy, @Mode, @Kind, @ReturnId, @Status,
                 @RejectReason, @AssignedAt, @ExpiresAt, @AcceptedAt, @StatusAt, @CodAmount, @CodCollected,
                 @CodMethod, @ProofPhoto, @FeePaise, @TipPaise, @BonusPaise, @FailReason, '', @CreatedAt)
            """, a);

    /// <summary>Every mutable field of a live trip (steps write status + their own timestamp + geo/fee fields).</summary>
    public Task<int> UpdateAsync(DeliveryAssignmentModel a, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE delivery_assignments SET status = @Status, reject_reason = @RejectReason, expires_at = @ExpiresAt,
                accepted_at = @AcceptedAt, at_store_at = @AtStoreAt, picked_at = @PickedAt, on_the_way_at = @OnTheWayAt,
                reached_at = @ReachedAt, delivered_at = @DeliveredAt, ended_at = @EndedAt, status_at = @StatusAt,
                stuck_alerted_at = @StuckAlertedAt, cod_amount = @CodAmount, cod_collected = @CodCollected,
                cod_method = @CodMethod, proof_photo = @ProofPhoto, picked_lat = @PickedLat, picked_lng = @PickedLng,
                drop_lat = @DropLat, drop_lng = @DropLng, distance_km = @DistanceKm, fee_paise = @FeePaise,
                tip_paise = @TipPaise, bonus_paise = @BonusPaise, fail_reason = @FailReason
            WHERE id = @Id
            """, a);

    public Task<IEnumerable<DeliveryAssignmentModel>> ExpiredOffersAsync(DateTime now, IUnitOfWork uow) =>
        uow.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE status = 'offered' AND expires_at < @now FOR UPDATE SKIP LOCKED",
            new { now });

    public Task<IEnumerable<DeliveryAssignmentModel>> LiveOffersAsync(Guid boyId, DateTime now, IUnitOfWork uow) =>
        uow.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE delivery_boy_id = @boyId AND status = 'offered' AND expires_at > @now ORDER BY assigned_at", new { boyId, now });

    public Task<IEnumerable<DeliveryAssignmentModel>> OnTripAsync(Guid boyId, IUnitOfWork uow) =>
        uow.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE delivery_boy_id = @boyId AND status IN ('accepted','at_store','picked','on_the_way','reached') ORDER BY accepted_at",
            new { boyId });

    public Task<int> OnTripCountAsync(Guid boyId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM delivery_assignments WHERE delivery_boy_id = @boyId AND status IN ('accepted','at_store','picked','on_the_way','reached')", new { boyId })!;

    /// <summary>Partners already asked about this package (reference: candidates' "already asked").</summary>
    public async Task<HashSet<Guid>> TriedForSubAsync(Guid subOrderId, IUnitOfWork uow) =>
        (await uow.QueryAsync<Guid>(
            "SELECT DISTINCT delivery_boy_id FROM delivery_assignments WHERE sub_order_id = @subOrderId",
            new { subOrderId })).ToHashSet();

    public Task<int> AutoOffersForSubAsync(Guid subOrderId, IUnitOfWork uow) =>
        uow.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM delivery_assignments WHERE sub_order_id = @subOrderId AND mode = 'auto'",
            new { subOrderId })!;

    /// <summary>Live load per partner: open offers plus trips in hand (reference: loads).</summary>
    public async Task<Dictionary<Guid, int>> LoadsAsync(IReadOnlyCollection<Guid> ids, IUnitOfWork uow)
    {
        if (ids.Count == 0) return [];
        var rows = await uow.QueryAsync<LoadRow>(
            "SELECT delivery_boy_id AS DeliveryBoyId, COUNT(*) AS Cnt FROM delivery_assignments WHERE delivery_boy_id IN @ids AND status IN ('offered','accepted','at_store','picked','on_the_way','reached') GROUP BY delivery_boy_id", new { ids });
        return ids.ToDictionary(i => i, i => (int)(rows.FirstOrDefault(r => r.DeliveryBoyId == i)?.Cnt ?? 0));
    }

    /// <summary>COD cash each partner still holds: collected on delivered trips minus deposits (reference: cash_by_partner).</summary>
    public async Task<Dictionary<Guid, long>> CashByPartnerAsync(IReadOnlyCollection<Guid> ids, IUnitOfWork uow)
    {
        if (ids.Count == 0) return [];
        var got = (await uow.QueryAsync<CashRow>(
            "SELECT delivery_boy_id AS DeliveryBoyId, COALESCE(SUM(cod_collected), 0) AS Total FROM delivery_assignments WHERE delivery_boy_id IN @ids AND status = 'delivered' GROUP BY delivery_boy_id", new { ids }))
            .ToDictionary(r => r.DeliveryBoyId, r => (long)r.Total);
        var paid = (await uow.QueryAsync<CashRow>(
            "SELECT delivery_boy_id AS DeliveryBoyId, COALESCE(SUM(amount), 0) AS Total FROM delivery_cash_deposits WHERE delivery_boy_id IN @ids GROUP BY delivery_boy_id", new { ids }))
            .ToDictionary(r => r.DeliveryBoyId, r => (long)r.Total);
        return ids.ToDictionary(i => i, i => got.GetValueOrDefault(i) - paid.GetValueOrDefault(i));
    }

    /// <summary>Today's finished trips and earnings for the feed (reference: feed's today block).</summary>
    public async Task<(int Trips, long Earned)> TodayStatsAsync(Guid boyId, DateTime since, IUnitOfWork uow)
    {
        var row = (await uow.QueryAsync<TodayRow>(
            "SELECT COUNT(*) AS Trips, COALESCE(SUM(fee_paise + tip_paise + bonus_paise), 0) AS Earned FROM delivery_assignments WHERE delivery_boy_id = @boyId AND status = 'delivered' AND delivered_at >= @since",
            new { boyId, since })).First();
        return ((int)row.Trips, (long)row.Earned);
    }

    private sealed record LoadRow(Guid DeliveryBoyId, long Cnt);
    private sealed record CashRow(Guid DeliveryBoyId, decimal Total);
    private sealed record TodayRow(long Trips, decimal Earned);

    // ------------------------------------------------------------------------- status log

    public Task<int> InsertLogAsync(OrderStatusLogModel l, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            INSERT INTO order_status_logs
                (id, order_id, sub_order_id, assignment_id, status, updated_by, actor, note, lat, lng, created_at)
            VALUES
                (@Id, @OrderId, @SubOrderId, @AssignmentId, @Status, @UpdatedBy, @Actor, @Note, @Lat, @Lng, @CreatedAt)
            """, l);

    public Task<IEnumerable<OrderStatusLogModel>> LogsForAssignmentAsync(Guid assignmentId, IUnitOfWork uow) =>
        uow.QueryAsync<OrderStatusLogModel>(
            "SELECT * FROM order_status_logs WHERE assignment_id = @assignmentId ORDER BY created_at",
            new { assignmentId });

    // ------------------------------------------------------------------------- partner location

    public Task<int> UpdateLocationAsync(Guid boyId, decimal lat, decimal lng, DateTime at) =>
        db.ExecuteAsync(
            "UPDATE delivery_boys SET lat = @lat, lng = @lng, location_at = @at, updated_at = UTC_TIMESTAMP(6) WHERE id = @boyId",
            new { boyId, lat, lng, at });

    // ------------------------------------------------------------------ staff operations (reference: delivery_admin.py)

    public Task<DeliveryAssignmentModel?> AssignmentAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE id=@id", new { id });

    /// <summary>Packages ready for pickup with no live request or trip (reference: _waiting).</summary>
    public Task<IEnumerable<SubOrderModel>> WaitingSubsAsync() =>
        db.QueryAsync<SubOrderModel>(
            "SELECT * FROM sub_orders WHERE shipping_provider='fleet' AND status='packed' " +
            "AND ready_for_pickup_at IS NOT NULL AND id NOT IN (SELECT sub_order_id FROM delivery_assignments " +
            "WHERE status IN ('offered','accepted','at_store','picked','on_the_way','reached')) ORDER BY ready_for_pickup_at");

    public Task<IEnumerable<DeliveryAssignmentModel>> OfferedAsync() =>
        db.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE status='offered' ORDER BY expires_at");

    /// <summary>Failed attempts whose package is still out, newest first (reference: _failed; dedupe in the BAL).</summary>
    public Task<IEnumerable<DeliveryAssignmentModel>> FailedListAsync() =>
        db.QueryAsync<DeliveryAssignmentModel>(
            "SELECT a.* FROM delivery_assignments a JOIN sub_orders s ON s.id=a.sub_order_id " +
            "WHERE a.status='failed' AND s.status='shipped' AND a.sub_order_id NOT IN " +
            "(SELECT sub_order_id FROM delivery_assignments WHERE status IN ('offered','accepted','at_store','picked','on_the_way','reached')) " +
            "ORDER BY a.ended_at DESC");

    /// <summary>Every attempt on a package, oldest first, with the partner name (reference: _package tries).</summary>
    public Task<IEnumerable<TryRow>> TriesForSubAsync(Guid subOrderId) =>
        db.QueryAsync<TryRow>(
            "SELECT a.status AS Status, a.reject_reason AS RejectReason, a.fail_reason AS FailReason, b.name AS Partner " +
            "FROM delivery_assignments a JOIN delivery_boys b ON b.id=a.delivery_boy_id " +
            "WHERE a.sub_order_id=@subOrderId ORDER BY a.created_at", new { subOrderId });

    public Task<IEnumerable<DeliveryAssignmentModel>> TripsPageAsync(string status, string like, Guid? partnerId, int offset) =>
        db.QueryAsync<DeliveryAssignmentModel>(
            "SELECT a.* FROM delivery_assignments a JOIN sub_orders s ON s.id=a.sub_order_id " +
            "JOIN delivery_boys b ON b.id=a.delivery_boy_id " +
            "WHERE (@status='' OR (@status='active' AND a.status IN ('offered','accepted','at_store','picked','on_the_way','reached')) " +
            "  OR (@status<>'active' AND a.status=@status)) " +
            "AND (@pid IS NULL OR a.delivery_boy_id=@pid) " +
            "AND (@like='' OR s.number LIKE @like OR b.name LIKE @like OR b.phone LIKE @like) " +
            "ORDER BY a.assigned_at DESC LIMIT 30 OFFSET @offset",
            new { status, like, pid = partnerId, offset });

    public Task<long> TripsCountAsync(string status, string like, Guid? partnerId) =>
        db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM delivery_assignments a JOIN sub_orders s ON s.id=a.sub_order_id " +
            "JOIN delivery_boys b ON b.id=a.delivery_boy_id " +
            "WHERE (@status='' OR (@status='active' AND a.status IN ('offered','accepted','at_store','picked','on_the_way','reached')) " +
            "  OR (@status<>'active' AND a.status=@status)) " +
            "AND (@pid IS NULL OR a.delivery_boy_id=@pid) " +
            "AND (@like='' OR s.number LIKE @like OR b.name LIKE @like OR b.phone LIKE @like)",
            new { status, like, pid = partnerId });

    public Task<IEnumerable<StatusCountRow>> ActiveStatusCountsAsync() =>
        db.QueryAsync<StatusCountRow>(
            "SELECT status AS Status, COUNT(*) AS Count FROM delivery_assignments " +
            "WHERE status IN ('offered','accepted','at_store','picked','on_the_way','reached') GROUP BY status");

    public Task<long> DeliveredSinceAsync(DateTime dayStart) =>
        db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM delivery_assignments WHERE status='delivered' AND kind='delivery' AND delivered_at>=@dayStart",
            new { dayStart });

    public Task<long> FailedSinceAsync(DateTime dayStart) =>
        db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM delivery_assignments WHERE status='failed' AND ended_at>=@dayStart", new { dayStart });

    public Task<long> StuckCountAsync(DateTime limit) =>
        db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM delivery_assignments " +
            "WHERE status IN ('accepted','at_store','picked','on_the_way','reached') AND status_at<@limit", new { limit });

    public Task<IEnumerable<OrderStatusLogModel>> StatusLogsAsync(Guid subOrderId) =>
        db.QueryAsync<OrderStatusLogModel>(
            "SELECT * FROM order_status_logs WHERE sub_order_id=@subOrderId ORDER BY created_at", new { subOrderId });
}

public class TryRow
{
    public string Status { get; set; } = "";
    public string RejectReason { get; set; } = "";
    public string FailReason { get; set; } = "";
    public string Partner { get; set; } = "";
}

public class StatusCountRow
{
    public string Status { get; set; } = "";
    public long Count { get; set; }
}
