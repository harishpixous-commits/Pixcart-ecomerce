package com.pixous.pixcart.identity.domain.vendor;

import com.pixous.pixcart.identity.domain.admin.AdminDashboard;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.Permission;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.StaffRole;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Vendor dashboard (home) — FR-VEN-014.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "present a task-first dashboard: action queue (new orders, expiring SLAs, QC
 *                fixes, disputes), KPI tiles (today's orders/GMV, pending payout, return rate),
 *                alerts and shortcuts, personalised per sub-role."
 *   INPUTS:     "Role context, dismissals/snoozes on tasks."
 *   OUTPUTS:    "Prioritised task list with deep links, KPI tiles (real-time orders; D-1
 *                aggregates), announcement inbox (policy/fee notices with read-receipts)."
 *   VALIDATION: "Tasks deduplicated; counts consistent with underlying modules."
 *   RULES:      "SLA-breaching tasks pin to top in red band; fee-notice read-receipt required
 *                before dismiss (compliance trail)."
 *   ERRORS:     "Widget source down → per-tile skeleton with retry, page never blank."
 *   SECURITY:   "Sub-role scoping (Finance-view staff see no customer PII)."
 *   ACCEPTANCE: "Given 3 New orders with 1 breaching accept-SLA in 20 min, When dashboard loads,
 *                The[n the breaching task pins to the top in a red band]."
 *
 * Three properties here do real work, and two of them protect somebody other than the vendor.
 *
 *  1. A FEE NOTICE CANNOT BE DISMISSED WITHOUT A READ RECEIPT. This is the compliance trail behind
 *     the FR-VEN-010 rule that a fee-schedule change needs 15 days' forward notice: notice that
 *     can be swiped away unacknowledged is not notice. The receipt is therefore a precondition of
 *     dismissal rather than a checkbox beside it, and the refusal names the notice.
 *
 *  2. FINANCE-VIEW STAFF SEE NO CUSTOMER PII. A staff member who needs payout figures does not
 *     need a buyer's name and address, and the scoping is applied HERE — stripping the fields from
 *     the task rather than trusting a template not to render them. The role matrix is the Slice-46
 *     one, so a vendor's dashboard cannot show more than that role is permitted elsewhere.
 *
 *  3. THE PAGE IS NEVER BLANK. A failed widget yields a per-tile skeleton with a retry, because a
 *     vendor whose order tile is down still needs the six other things on the page. A dashboard
 *     that fails whole because one query failed is a dashboard that is down.
 *
 * Freshness semantics are imported from the FR-ADM-001 dashboard rather than redeclared, so
 * "real-time" and "D-1" mean the same thing on both surfaces.
 */
public final class VendorDashboard {

    /** RULES: a task within this of its SLA is treated as breaching and pinned. */
    public static final Duration SLA_BREACH_WARNING = Duration.ofMinutes(30);

    public enum TaskKind {
        NEW_ORDER(Permission.ORDERS_MANAGE),
        EXPIRING_SLA(Permission.ORDERS_MANAGE),
        QC_FIX(Permission.CATALOGUE_MANAGE),
        DISPUTE(Permission.ORDERS_MANAGE),
        /** RULES: needs a read receipt before it can be dismissed. */
        FEE_NOTICE(Permission.FINANCE_READ),
        POLICY_NOTICE(Permission.FINANCE_READ);

        private final Permission requires;

        TaskKind(Permission requires) {
            this.requires = requires;
        }

        public Permission requires() {
            return requires;
        }

        /** RULES: which notices carry a compliance read-receipt obligation. */
        public boolean requiresReadReceipt() {
            return this == FEE_NOTICE || this == POLICY_NOTICE;
        }
    }

    public enum Tile {
        TODAYS_ORDERS(Permission.ORDERS_MANAGE, AdminDashboard.Freshness.REAL_TIME),
        TODAYS_GMV(Permission.ORDERS_MANAGE, AdminDashboard.Freshness.REAL_TIME),
        PENDING_PAYOUT(Permission.FINANCE_READ, AdminDashboard.Freshness.D_MINUS_1),
        RETURN_RATE(Permission.ORDERS_MANAGE, AdminDashboard.Freshness.D_MINUS_1);

        private final Permission requires;
        private final AdminDashboard.Freshness freshness;

        Tile(Permission requires, AdminDashboard.Freshness freshness) {
            this.requires = requires;
            this.freshness = freshness;
        }

        public Permission requires()                    { return requires; }
        public AdminDashboard.Freshness freshness()     { return freshness; }
    }

    public enum Band { RED, NORMAL }

    /** Customer detail a task may carry, and which Finance-view must not see. */
    public record CustomerContext(String customerName, String deliveryPincode, String contactMasked) {}

    public record Task(String taskId, TaskKind kind, String title, String deepLink,
                       Instant slaDueAt, String dedupeKey, CustomerContext customer) {
        public Task {
            if (taskId == null || taskId.isBlank()) throw new IllegalArgumentException("taskId");
            if (dedupeKey == null || dedupeKey.isBlank()) throw new IllegalArgumentException("dedupeKey");
        }
    }

    public record TaskView(String taskId, TaskKind kind, String title, String deepLink,
                           Band band, boolean pinned, Instant slaDueAt,
                           Optional<CustomerContext> customer, boolean requiresReadReceipt) {}

    /** ERRORS: a tile that could not load. */
    public enum TileState { LOADED, SKELETON }

    public record TileView(Tile tile, TileState state, String value,
                           AdminDashboard.Freshness freshness, boolean retryAvailable,
                           String unavailableReason) {}

    /** A figure from its owning module. VALIDATION: counts stay consistent with the source. */
    public record TileFigure(Tile tile, String value, String sourceModule) {
        public TileFigure {
            if (sourceModule == null || sourceModule.isBlank()) {
                throw new IllegalArgumentException("every figure must name its source module");
            }
        }
    }

    public record DashboardView(StaffRole role, List<TaskView> tasks, List<TileView> tiles,
                                int redBandCount, Instant renderedAt) {
        public DashboardView {
            tasks = List.copyOf(tasks);
            tiles = List.copyOf(tiles);
        }

        /** ERRORS: the page renders even when every tile failed. */
        public boolean isBlank() {
            return tasks.isEmpty() && tiles.isEmpty();
        }
    }

    public sealed interface DismissResult {
        record Dismissed(Instant at) implements DismissResult {}
        /** RULES: a fee notice needs its receipt first. */
        record ReadReceiptRequired(String taskId, String notice) implements DismissResult {}
        record Rejected(String reason) implements DismissResult {}
    }

    public record ReadReceipt(String taskId, String userId, Instant at) {}

    private final String vendorId;
    private final Map<String, Instant> dismissals = new LinkedHashMap<>();
    private final Map<String, Instant> snoozes = new LinkedHashMap<>();
    private final Map<String, ReadReceipt> receipts = new LinkedHashMap<>();

    public VendorDashboard(String vendorId) {
        this.vendorId = vendorId;
    }

    /**
     * VALIDATION: is this task breaching, or about to? A task already past its SLA and one due in
     * twenty minutes both need the vendor's attention now, so both pin.
     */
    public static boolean isBreaching(Task task, Instant now) {
        if (task.slaDueAt() == null) return false;
        return !task.slaDueAt().isAfter(now.plus(SLA_BREACH_WARNING));
    }

    /**
     * SECURITY: strip customer context for roles that may not see it. Applied here rather than
     * left to a template, because a template that forgets is a template nobody notices forgetting.
     */
    private static Optional<CustomerContext> scopedCustomer(Task task, StaffRole role) {
        if (role == null) return Optional.empty();
        if (!StoreSettings.roleGrants(role, Permission.ORDERS_MANAGE)) {
            // Finance-view needs payout figures, not a buyer's name and address
            return Optional.empty();
        }
        return Optional.ofNullable(task.customer());
    }

    /**
     * Compose the dashboard.
     *
     * VALIDATION: tasks are deduplicated by their dedupe key before anything else, because a
     * duplicated task inflates the count a vendor is judged on and makes the queue untrustworthy.
     * RULES: breaching tasks are then pinned to the top in a red band.
     */
    public DashboardView compose(StaffRole role, List<Task> tasks, List<TileFigure> figures,
                                 Set<Tile> failedTiles, Instant now) {
        // VALIDATION: dedupe, keeping the first occurrence so a stable order survives
        var seenKeys = new LinkedHashSet<String>();
        var deduped = new ArrayList<Task>();
        for (Task t : tasks) {
            if (seenKeys.add(t.dedupeKey())) deduped.add(t);
        }

        var visible = new ArrayList<TaskView>();
        for (Task t : deduped) {
            if (!StoreSettings.roleGrants(role, t.kind().requires())) continue;      // sub-role scoping
            if (dismissals.containsKey(t.taskId())) continue;
            Instant snoozedUntil = snoozes.get(t.taskId());
            if (snoozedUntil != null && now.isBefore(snoozedUntil)) continue;

            boolean breaching = isBreaching(t, now);
            visible.add(new TaskView(
                    t.taskId(), t.kind(), t.title(), t.deepLink(),
                    breaching ? Band.RED : Band.NORMAL,
                    breaching,
                    t.slaDueAt(),
                    scopedCustomer(t, role),
                    t.kind().requiresReadReceipt()));
        }

        // RULES: pinned first; within each group the soonest SLA leads, then a stable id order
        visible.sort((a, b) -> {
            if (a.pinned() != b.pinned()) return a.pinned() ? -1 : 1;
            if (a.slaDueAt() != null && b.slaDueAt() != null) {
                int byDue = a.slaDueAt().compareTo(b.slaDueAt());
                if (byDue != 0) return byDue;
            } else if (a.slaDueAt() != null) {
                return -1;
            } else if (b.slaDueAt() != null) {
                return 1;
            }
            return a.taskId().compareTo(b.taskId());
        });

        var tiles = composeTiles(role, figures, failedTiles);
        int red = (int) visible.stream().filter(t -> t.band() == Band.RED).count();
        return new DashboardView(role, visible, tiles, red, now);
    }

    /**
     * ERRORS: a failed source yields a SKELETON with a retry rather than removing the tile or
     * failing the page. A vendor whose order tile is down still needs the other six things.
     */
    private List<TileView> composeTiles(StaffRole role, List<TileFigure> figures, Set<Tile> failedTiles) {
        var byTile = new EnumMap<Tile, TileFigure>(Tile.class);
        for (TileFigure f : figures) byTile.put(f.tile(), f);

        var out = new ArrayList<TileView>();
        for (Tile tile : Tile.values()) {
            if (!StoreSettings.roleGrants(role, tile.requires())) continue;
            if (failedTiles.contains(tile) || !byTile.containsKey(tile)) {
                out.add(new TileView(tile, TileState.SKELETON, "—", tile.freshness(), true,
                        failedTiles.contains(tile) ? "SOURCE_UNAVAILABLE" : "NO_FIGURE_SUPPLIED"));
                continue;
            }
            out.add(new TileView(tile, TileState.LOADED, byTile.get(tile).value(),
                    tile.freshness(), false, ""));
        }
        return out;
    }

    // ------------------------------------------------------------- receipts & dismissal

    /** RULES: record the read receipt that a notice's dismissal depends on. */
    public ReadReceipt recordReadReceipt(String taskId, String userId, Instant now) {
        var receipt = new ReadReceipt(taskId, userId, now);
        receipts.put(taskId, receipt);
        return receipt;
    }

    public Optional<ReadReceipt> readReceipt(String taskId) {
        return Optional.ofNullable(receipts.get(taskId));
    }

    /**
     * RULES: dismiss a task. A fee or policy notice needs its read receipt FIRST — notice that can
     * be swiped away unacknowledged is not notice, and this is the compliance trail behind the
     * FR-VEN-010 requirement that a fee change carry 15 days' forward notice.
     */
    public DismissResult dismiss(Task task, String userId, Instant now) {
        if (dismissals.containsKey(task.taskId())) {
            return new DismissResult.Rejected("ALREADY_DISMISSED");
        }
        if (task.kind().requiresReadReceipt() && !receipts.containsKey(task.taskId())) {
            return new DismissResult.ReadReceiptRequired(task.taskId(), task.title());
        }
        dismissals.put(task.taskId(), now);
        return new DismissResult.Dismissed(now);
    }

    /**
     * INPUTS: snooze a task. A breaching task may not be snoozed — snoozing an SLA does not move
     * the SLA, it only hides the fact that it is about to be missed.
     */
    public DismissResult snooze(Task task, Instant until, Instant now) {
        if (until == null || !until.isAfter(now)) {
            return new DismissResult.Rejected("SNOOZE_UNTIL_MUST_BE_IN_THE_FUTURE");
        }
        if (isBreaching(task, now)) {
            return new DismissResult.Rejected("CANNOT_SNOOZE_AN_SLA_BREACHING_TASK");
        }
        if (task.kind().requiresReadReceipt() && !receipts.containsKey(task.taskId())) {
            // a notice may be deferred, but only once it has been read
            return new DismissResult.ReadReceiptRequired(task.taskId(), task.title());
        }
        snoozes.put(task.taskId(), until);
        return new DismissResult.Dismissed(now);
    }

    public String vendorId()                        { return vendorId; }
    public Set<String> dismissedTaskIds()           { return new LinkedHashSet<>(dismissals.keySet()); }
    public Optional<Instant> snoozedUntil(String taskId) { return Optional.ofNullable(snoozes.get(taskId)); }

    /** Which tiles a role may see at all. */
    public static Set<Tile> visibleTilesFor(StaffRole role) {
        var out = new LinkedHashSet<Tile>();
        for (Tile t : Tile.values()) {
            if (StoreSettings.roleGrants(role, t.requires())) out.add(t);
        }
        return out;
    }
}
