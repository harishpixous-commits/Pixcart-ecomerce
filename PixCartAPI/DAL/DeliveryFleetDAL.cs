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

    public Task<IEnumerable<DeliveryAssignmentModel>> ActiveForPartnerAsync(Guid boyId) =>
        db.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE delivery_boy_id=@boyId " +
            "AND status IN ('offered','accepted','at_store','picked','on_the_way','reached')", new { boyId });

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

    // ------------------------------------------------------------------ cash, payouts, reports, feedback (reference: delivery_admin.py)

    public Task<int> InsertDepositAsync(DeliveryCashDepositModel d, IUnitOfWork? uow = null)
    {
        const string sql = "INSERT INTO delivery_cash_deposits (delivery_boy_id, amount, method, reference, note, recorded_by, created_at, id) " +
                           "VALUES (@DeliveryBoyId, @Amount, @Method, @Reference, @Note, @RecordedBy, @CreatedAt, @Id)";
        return uow is not null ? uow.ExecuteAsync(sql, d) : db.ExecuteAsync(sql, d);
    }

    public Task<IEnumerable<DepositRow>> DepositsRecentAsync() =>
        db.QueryAsync<DepositRow>(
            "SELECT d.amount AS Amount, d.method AS Method, d.reference AS Reference, d.note AS Note, " +
            "d.created_at AS CreatedAt, b.name AS Partner FROM delivery_cash_deposits d " +
            "JOIN delivery_boys b ON b.id=d.delivery_boy_id ORDER BY d.created_at DESC LIMIT 30");

    public Task<IEnumerable<PayoutRow>> PayoutsPageAsync(string status, int offset) =>
        db.QueryAsync<PayoutRow>(
            "SELECT p.*, b.name AS PartnerName, b.phone AS PartnerPhone, b.bank_details AS PartnerBank " +
            "FROM delivery_payouts p JOIN delivery_boys b ON b.id=p.delivery_boy_id " +
            "WHERE (@status='' OR p.status=@status) ORDER BY p.period_start DESC, b.name LIMIT 50 OFFSET @offset",
            new { status, offset });

    public Task<long> PayoutsCountAsync(string status) =>
        db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM delivery_payouts WHERE (@status='' OR status=@status)",
            new { status });

    public Task<long> PendingPayoutTotalAsync() =>
        db.ExecuteScalarAsync<long>("SELECT COALESCE(SUM(net_amount),0) FROM delivery_payouts WHERE status='pending'");

    public Task<long> UnbilledTotalAsync() =>
        db.ExecuteScalarAsync<long>(
            "SELECT COALESCE(SUM(fee_paise+tip_paise+bonus_paise),0) FROM delivery_assignments " +
            "WHERE status='delivered' AND payout_id IS NULL");

    public Task<DeliveryPayoutModel?> PayoutForUpdateAsync(Guid id, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<DeliveryPayoutModel>(
            "SELECT * FROM delivery_payouts WHERE id=@id FOR UPDATE", new { id });

    public Task<int> UpdatePayoutAsync(DeliveryPayoutModel p, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE delivery_payouts SET deliveries=@Deliveries, amount=@Amount, cod_deducted=@CodDeducted, " +
            "net_amount=@NetAmount, status=@Status, paid_at=@PaidAt, paid_by=@PaidBy, reference=@Reference WHERE id=@Id", p);

    public Task<int> InsertPayoutAsync(DeliveryPayoutModel p, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "INSERT INTO delivery_payouts (delivery_boy_id, period_start, period_end, deliveries, amount, cod_deducted, " +
            "net_amount, status, paid_at, paid_by, reference, created_at, id) VALUES (@DeliveryBoyId, @PeriodStart, @PeriodEnd, " +
            "@Deliveries, @Amount, @CodDeducted, @NetAmount, @Status, @PaidAt, @PaidBy, @Reference, @CreatedAt, @Id)", p);

    /// <summary>Unbilled delivered earnings per partner up to a moment (reference: generate_payouts rows).</summary>
    public Task<IEnumerable<UnbilledRow>> UnbilledByPartnerAsync(DateTime until, IUnitOfWork uow) =>
        uow.QueryAsync<UnbilledRow>(
            "SELECT delivery_boy_id AS BoyId, COUNT(*) AS Deliveries, COALESCE(SUM(fee_paise+tip_paise+bonus_paise),0) AS Amount " +
            "FROM delivery_assignments WHERE status='delivered' AND payout_id IS NULL AND delivered_at<@until " +
            "GROUP BY delivery_boy_id", new { until });

    public Task<DeliveryPayoutModel?> PayoutForPeriodAsync(Guid boyId, DateOnly start, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<DeliveryPayoutModel>(
            "SELECT * FROM delivery_payouts WHERE delivery_boy_id=@boyId AND period_start=@start", new { boyId, start });

    public Task<int> AssignPayoutAsync(Guid boyId, DateTime until, Guid payoutId, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            "UPDATE delivery_assignments SET payout_id=@payoutId WHERE delivery_boy_id=@boyId AND status='delivered' " +
            "AND payout_id IS NULL AND delivered_at<@until", new { boyId, until, payoutId });

    /// <summary>Reference: reports day rows (IST calendar day, delivered/failed deliveries with COD).</summary>
    public Task<IEnumerable<ReportDayRow>> ReportDaysAsync(DateTime since) =>
        db.QueryAsync<ReportDayRow>(
            "SELECT DATE(CONVERT_TZ(COALESCE(delivered_at, ended_at), '+00:00', '+05:30')) AS Day, status AS Status, " +
            "COUNT(*) AS Count, COALESCE(SUM(cod_collected),0) AS Cod FROM delivery_assignments " +
            "WHERE kind='delivery' AND status IN ('delivered','failed') AND COALESCE(delivered_at, ended_at)>=@since " +
            "GROUP BY Day, status", new { since });

    /// <summary>Reference: reports partner performance.</summary>
    public Task<IEnumerable<ReportPartnerRow>> ReportPartnersAsync(DateTime since) =>
        db.QueryAsync<ReportPartnerRow>(
            "SELECT b.id AS BoyId, b.name AS Name, b.rating_avg AS RatingAvg, b.rating_count AS RatingCount, " +
            "SUM(a.status='delivered') AS Delivered, SUM(a.status='failed') AS Failed, " +
            "SUM(a.status IN ('rejected','expired')) AS Declined, " +
            "COALESCE(SUM(a.fee_paise+a.tip_paise+a.bonus_paise),0) AS Earned, COALESCE(SUM(a.cod_collected),0) AS Cod, " +
            "AVG(CASE WHEN a.status='delivered' THEN TIMESTAMPDIFF(SECOND, a.accepted_at, a.delivered_at)/60 END) AS AvgMinutes " +
            "FROM delivery_assignments a JOIN delivery_boys b ON b.id=a.delivery_boy_id " +
            "WHERE a.assigned_at>=@since GROUP BY b.id, b.name, b.rating_avg, b.rating_count", new { since });

    public Task<IEnumerable<RatingRow>> RatingsPageAsync(int offset) =>
        db.QueryAsync<RatingRow>(
            "SELECT a.id AS AssignmentId, b.name AS Partner, s.number AS OrderNumber, a.rating AS Rating, " +
            "a.rating_comment AS Comment, a.rated_at AS At FROM delivery_assignments a " +
            "JOIN delivery_boys b ON b.id=a.delivery_boy_id JOIN sub_orders s ON s.id=a.sub_order_id " +
            "WHERE a.rating IS NOT NULL ORDER BY a.rated_at DESC LIMIT 30 OFFSET @offset", new { offset });

    public Task<long> RatingsCountAsync() =>
        db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM delivery_assignments WHERE rating IS NOT NULL");

    public Task<IEnumerable<ComplaintRow>> ComplaintsPageAsync(string status, int offset) =>
        db.QueryAsync<ComplaintRow>(
            "SELECT c.id AS Id, c.assignment_id AS AssignmentId, b.name AS Partner, s.number AS OrderNumber, " +
            "c.category AS Category, c.text AS Text, c.status AS Status, c.admin_note AS AdminNote, c.created_at AS At " +
            "FROM delivery_complaints c JOIN delivery_boys b ON b.id=c.delivery_boy_id " +
            "JOIN delivery_assignments a ON a.id=c.assignment_id JOIN sub_orders s ON s.id=a.sub_order_id " +
            "WHERE (@status='' OR c.status=@status) ORDER BY c.created_at DESC LIMIT 30 OFFSET @offset",
            new { status, offset });

    public Task<long> ComplaintsCountAsync(string status) =>
        db.ExecuteScalarAsync<long>(
            "SELECT COUNT(*) FROM delivery_complaints WHERE (@status='' OR status=@status)", new { status });

    public Task<long> OpenComplaintsCountAsync() =>
        db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM delivery_complaints WHERE status='open'");

    public Task<DeliveryComplaintModel?> ComplaintAsync(Guid id) =>
        db.QueryFirstOrDefaultAsync<DeliveryComplaintModel>("SELECT * FROM delivery_complaints WHERE id=@id", new { id });

    public Task<int> ResolveComplaintAsync(Guid id, string note, DateTime resolvedAt) =>
        db.ExecuteAsync(
            "UPDATE delivery_complaints SET status='resolved', admin_note=@note, resolved_at=@resolvedAt WHERE id=@id",
            new { id, note, resolvedAt });

    /// <summary>Partners for the live map: approved, active, online or on a trip (reference: live).</summary>
    public Task<IEnumerable<DeliveryBoyModel>> LiveBoysAsync() =>
        db.QueryAsync<DeliveryBoyModel>(
            "SELECT * FROM delivery_boys WHERE kyc_status='approved' AND is_active=1 AND (is_online=1 OR id IN " +
            "(SELECT delivery_boy_id FROM delivery_assignments WHERE status IN ('offered','accepted','at_store','picked','on_the_way','reached')))");

    public Task<IEnumerable<DeliveryAssignmentModel>> ActiveTripsAsync() =>
        db.QueryAsync<DeliveryAssignmentModel>(
            "SELECT * FROM delivery_assignments WHERE status IN ('offered','accepted','at_store','picked','on_the_way','reached') " +
            "ORDER BY status_at");

    public Task<IEnumerable<TodayStatRow>> TodayStatsMultiAsync(IReadOnlyCollection<Guid> ids, DateTime since) =>
        db.QueryAsync<TodayStatRow>(
            "SELECT delivery_boy_id AS BoyId, COUNT(*) AS Trips, COALESCE(SUM(fee_paise+tip_paise+bonus_paise),0) AS Earned " +
            "FROM delivery_assignments WHERE delivery_boy_id IN @ids AND status='delivered' AND delivered_at>=@since " +
            "GROUP BY delivery_boy_id", new { ids, since });
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

public class DepositRow
{
    public long Amount { get; set; }
    public string Method { get; set; } = "";
    public string Reference { get; set; } = "";
    public string Note { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public string Partner { get; set; } = "";
}

public class PayoutRow : DeliveryPayoutModel
{
    public string PartnerName { get; set; } = "";
    public string PartnerPhone { get; set; } = "";
    public string PartnerBank { get; set; } = "{}";
}

public class UnbilledRow
{
    public Guid BoyId { get; set; }
    public long Deliveries { get; set; }
    public long Amount { get; set; }
}

public class ReportDayRow
{
    public DateTime Day { get; set; }
    public string Status { get; set; } = "";
    public long Count { get; set; }
    public long Cod { get; set; }
}

public class ReportPartnerRow
{
    public Guid BoyId { get; set; }
    public string Name { get; set; } = "";
    public decimal RatingAvg { get; set; }
    public int RatingCount { get; set; }
    public long Delivered { get; set; }
    public long Failed { get; set; }
    public long Declined { get; set; }
    public long Earned { get; set; }
    public long Cod { get; set; }
    public double? AvgMinutes { get; set; }
}

public class RatingRow
{
    public Guid AssignmentId { get; set; }
    public string Partner { get; set; } = "";
    public string OrderNumber { get; set; } = "";
    public int Rating { get; set; }
    public string Comment { get; set; } = "";
    public DateTime? At { get; set; }
}

public class ComplaintRow
{
    public Guid Id { get; set; }
    public Guid AssignmentId { get; set; }
    public string Partner { get; set; } = "";
    public string OrderNumber { get; set; } = "";
    public string Category { get; set; } = "";
    public string Text { get; set; } = "";
    public string Status { get; set; } = "";
    public string AdminNote { get; set; } = "";
    public DateTime At { get; set; }
}

public class TodayStatRow
{
    public Guid BoyId { get; set; }
    public long Trips { get; set; }
    public long Earned { get; set; }
}
