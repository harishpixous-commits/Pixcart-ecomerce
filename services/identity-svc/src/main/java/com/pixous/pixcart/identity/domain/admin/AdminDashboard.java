package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.identity.domain.rbac.Rbac;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Admin overview dashboard — FR-ADM-001.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "present operator KPIs — GMV (today/MTD), orders by state, funnel conversion,
 *                payment success, OTIF, returns, open approvals, risk queue depth, system health
 *                — with drill-downs and anomaly badges from FR-AI-015."
 *   OUTPUTS:    "Live tiles (order/payment real-time; others D-1), anomaly annotations with
 *                'explain' links, export snapshot (PDF) for reviews."
 *   VALIDATION: "Figures reconcile with source modules (single semantic layer)."
 *   RULES:      "Health tile mirrors SLO burn (Vol. 11); red states link to runbooks."
 *   ERRORS:     "Source lag → per-tile freshness stamp; never mixed-freshness without label."
 *   SECURITY:   "Role-trimmed tiles (MKT sees no finance detail)."
 *   ACCEPTANCE: "Given payment success dips below alert threshold, When dashboard is open, Then
 *                the tile turns red within 60 s with a link to the payments incident view."
 *
 * Like the FR-VEN-010 vendor statement and the FR-FIN-008 report pack, this is a PROJECTION and
 * not a calculator. "Single semantic layer" means a tile's number is the source module's number:
 * every figure arrives already computed, carrying the module that produced it and the instant it
 * was true, and there is no surface here by which a caller could supply a total of their own. A
 * dashboard that recomputes GMV will eventually disagree with the ledger, and then nobody can say
 * which is right.
 *
 * Role trimming reuses the Vol.2 §2.4 capability matrix rather than a parallel scheme of its own,
 * so a role's dashboard cannot drift from what that role is permitted elsewhere in the platform.
 */
public final class AdminDashboard {

    /** ACCEPTANCE: a threshold breach must show within this window. */
    public static final Duration ALERT_PROPAGATION = Duration.ofSeconds(60);

    /** The KPI tiles the requirement enumerates. */
    public enum Tile {
        GMV_TODAY(Rbac.Capability.REPORTS_ANALYTICS, Freshness.REAL_TIME),
        GMV_MTD(Rbac.Capability.REPORTS_ANALYTICS, Freshness.D_MINUS_1),
        ORDERS_BY_STATE(Rbac.Capability.ORDER_MANAGEMENT, Freshness.REAL_TIME),
        FUNNEL_CONVERSION(Rbac.Capability.REPORTS_ANALYTICS, Freshness.D_MINUS_1),
        PAYMENT_SUCCESS(Rbac.Capability.SETTLEMENT_PAYOUTS, Freshness.REAL_TIME),
        OTIF(Rbac.Capability.ORDER_MANAGEMENT, Freshness.D_MINUS_1),
        RETURNS(Rbac.Capability.ORDER_MANAGEMENT, Freshness.D_MINUS_1),
        OPEN_APPROVALS(Rbac.Capability.PRODUCT_APPROVAL, Freshness.REAL_TIME),
        RISK_QUEUE_DEPTH(Rbac.Capability.AI_DASHBOARDS, Freshness.REAL_TIME),
        SYSTEM_HEALTH(Rbac.Capability.SYSTEM_SETTINGS_API_KEYS, Freshness.REAL_TIME);

        private final Rbac.Capability requires;
        private final Freshness expected;

        Tile(Rbac.Capability requires, Freshness expected) {
            this.requires = requires;
            this.expected = expected;
        }

        public Rbac.Capability requires()  { return requires; }
        public Freshness expectedFreshness() { return expected; }
    }

    public enum Freshness { REAL_TIME, D_MINUS_1 }

    public enum TileState { GREEN, AMBER, RED }

    /**
     * A figure as produced by its source module. The dashboard consumes these; it does not derive
     * them, which is what makes the single-semantic-layer claim true rather than aspirational.
     */
    public record SourceFigure(Tile tile, double value, String sourceModule, Instant asOf,
                               Freshness freshness) {
        public SourceFigure {
            if (sourceModule == null || sourceModule.isBlank()) {
                throw new IllegalArgumentException("every figure must name its source module");
            }
            if (asOf == null) throw new IllegalArgumentException("every figure must carry an as-of instant");
        }
    }

    /** Amber and red bounds for a tile. Direction matters: some KPIs are bad when LOW. */
    public record Threshold(Tile tile, double amberAt, double redAt, boolean lowIsBad) {}

    /** An anomaly badge from FR-AI-015, with its "explain" link. */
    public record AnomalyBadge(Tile tile, String note, String explainUrl) {}

    public record TileView(Tile tile, double value, TileState state, Freshness freshness,
                           Instant asOf, String sourceModule, String freshnessStamp,
                           Optional<String> runbookUrl, Optional<String> incidentUrl,
                           Optional<AnomalyBadge> anomaly) {}

    public record DashboardView(Rbac.Role role, List<TileView> tiles, boolean mixedFreshness,
                                String freshnessLabel, Instant renderedAt) {
        public DashboardView {
            tiles = List.copyOf(tiles);
        }

        public Optional<TileView> tile(Tile tile) {
            return tiles.stream().filter(t -> t.tile() == tile).findFirst();
        }
    }

    /** RULES: red states link to runbooks. */
    private static final Map<Tile, String> RUNBOOKS = new EnumMap<>(Tile.class);
    /** ACCEPTANCE: the payments incident view. */
    private static final Map<Tile, String> INCIDENT_VIEWS = new EnumMap<>(Tile.class);

    static {
        RUNBOOKS.put(Tile.PAYMENT_SUCCESS, "/runbooks/payments/success-rate-dip");
        RUNBOOKS.put(Tile.SYSTEM_HEALTH, "/runbooks/platform/slo-burn");
        RUNBOOKS.put(Tile.ORDERS_BY_STATE, "/runbooks/orders/state-backlog");
        RUNBOOKS.put(Tile.OTIF, "/runbooks/logistics/otif-breach");
        RUNBOOKS.put(Tile.RISK_QUEUE_DEPTH, "/runbooks/risk/queue-depth");
        RUNBOOKS.put(Tile.RETURNS, "/runbooks/returns/spike");
        RUNBOOKS.put(Tile.OPEN_APPROVALS, "/runbooks/catalogue/approval-backlog");
        RUNBOOKS.put(Tile.GMV_TODAY, "/runbooks/commerce/gmv-drop");
        RUNBOOKS.put(Tile.GMV_MTD, "/runbooks/commerce/gmv-drop");
        RUNBOOKS.put(Tile.FUNNEL_CONVERSION, "/runbooks/commerce/funnel-drop");

        INCIDENT_VIEWS.put(Tile.PAYMENT_SUCCESS, "/incidents/payments");
        INCIDENT_VIEWS.put(Tile.SYSTEM_HEALTH, "/incidents/platform");
    }

    private AdminDashboard() {
    }

    /** Every tile has a runbook, so a red state can never be a dead end. */
    public static Optional<String> runbookFor(Tile tile) {
        return Optional.ofNullable(RUNBOOKS.get(tile));
    }

    public static Optional<String> incidentViewFor(Tile tile) {
        return Optional.ofNullable(INCIDENT_VIEWS.get(tile));
    }

    /**
     * Classify a figure against its threshold. `lowIsBad` matters: payment success and OTIF are
     * alarming when they FALL, while returns and queue depth are alarming when they RISE. A single
     * comparison direction would get half of the tiles exactly backwards.
     */
    public static TileState stateOf(double value, Threshold threshold) {
        if (threshold.lowIsBad()) {
            if (value <= threshold.redAt()) return TileState.RED;
            if (value <= threshold.amberAt()) return TileState.AMBER;
            return TileState.GREEN;
        }
        if (value >= threshold.redAt()) return TileState.RED;
        if (value >= threshold.amberAt()) return TileState.AMBER;
        return TileState.GREEN;
    }

    /** ERRORS: a per-tile freshness stamp, always present. */
    public static String freshnessStampFor(SourceFigure figure) {
        return switch (figure.freshness()) {
            case REAL_TIME -> "live as of " + figure.asOf();
            case D_MINUS_1 -> "as of " + figure.asOf() + " (D-1)";
        };
    }

    public static TileView renderTile(SourceFigure figure, Threshold threshold,
                                      AnomalyBadge anomaly) {
        TileState state = threshold == null ? TileState.GREEN : stateOf(figure.value(), threshold);
        return new TileView(
                figure.tile(),
                figure.value(),
                state,
                figure.freshness(),
                figure.asOf(),
                figure.sourceModule(),
                freshnessStampFor(figure),
                // RULES: red states link to runbooks; a green tile does not clutter the UI with one
                state == TileState.RED ? runbookFor(figure.tile()) : Optional.empty(),
                state == TileState.RED ? incidentViewFor(figure.tile()) : Optional.empty(),
                Optional.ofNullable(anomaly));
    }

    /**
     * ACCEPTANCE: has a breach been surfaced inside the 60-second window? The figure's as-of
     * instant is the clock that matters, not when the dashboard happened to be opened.
     */
    public static boolean surfacedWithinAlertWindow(TileView tile, Instant renderedAt) {
        return !renderedAt.isAfter(tile.asOf().plus(ALERT_PROPAGATION));
    }

    /**
     * VALIDATION: does a rendered tile still agree with its source module? The dashboard has no
     * way to alter a figure, so this can only fail if a caller passed a stale view — which is
     * exactly the drift worth catching in a monitor.
     */
    public static boolean reconciles(TileView tile, double sourceModuleValue) {
        return Double.compare(tile.value(), sourceModuleValue) == 0;
    }

    /**
     * Compose the dashboard for a role.
     *
     * SECURITY: tiles are trimmed against the Vol.2 §2.4 capability matrix, so Marketing sees no
     * finance detail without that rule being restated here.
     *
     * ERRORS: when the surviving tiles mix real-time and D-1 data, the view carries an explicit
     * mixed-freshness label. The requirement's "never mixed-freshness without label" is the whole
     * point — an operator comparing a live payment figure against yesterday's GMV will draw a
     * false conclusion unless the difference is stated.
     */
    public static DashboardView compose(Rbac.Role role, List<SourceFigure> figures,
                                        List<Threshold> thresholds, List<AnomalyBadge> anomalies,
                                        Instant renderedAt) {
        var thresholdByTile = new EnumMap<Tile, Threshold>(Tile.class);
        for (Threshold t : thresholds) thresholdByTile.put(t.tile(), t);
        var anomalyByTile = new EnumMap<Tile, AnomalyBadge>(Tile.class);
        for (AnomalyBadge a : anomalies) anomalyByTile.put(a.tile(), a);

        var visible = new ArrayList<TileView>();
        var freshnesses = new LinkedHashSet<Freshness>();
        for (SourceFigure f : figures) {
            if (!Rbac.permits(role, f.tile().requires())) continue;      // role-trimmed
            visible.add(renderTile(f, thresholdByTile.get(f.tile()), anomalyByTile.get(f.tile())));
            freshnesses.add(f.freshness());
        }

        boolean mixed = freshnesses.size() > 1;
        String label = mixed
                ? "Mixed freshness: order and payment tiles are live; other tiles are D-1"
                : freshnesses.isEmpty() ? "No tiles visible for this role"
                        : freshnesses.iterator().next() == Freshness.REAL_TIME
                                ? "All tiles live" : "All tiles D-1";

        return new DashboardView(role, visible, mixed, label, renderedAt);
    }

    /** Which tiles a role may see at all — useful for a saved-view editor. */
    public static Set<Tile> visibleTilesFor(Rbac.Role role) {
        var out = new LinkedHashSet<Tile>();
        for (Tile t : Tile.values()) {
            if (Rbac.permits(role, t.requires())) out.add(t);
        }
        return out;
    }

    /** RULES: the health tile mirrors SLO burn. Burn above 1.0 means the budget is being consumed
     *  faster than the period allows. */
    public static TileState healthFromSloBurn(double burnRate) {
        if (burnRate >= 2.0) return TileState.RED;
        if (burnRate >= 1.0) return TileState.AMBER;
        return TileState.GREEN;
    }

    /** OUTPUTS: an export snapshot for reviews. Carries the freshness label so a PDF read a week
     *  later cannot be mistaken for live data. */
    public record ExportSnapshot(Rbac.Role role, Instant takenAt, String freshnessLabel,
                                 List<TileView> tiles, String watermark) {
        public ExportSnapshot {
            tiles = List.copyOf(tiles);
        }
    }

    public static ExportSnapshot exportSnapshot(DashboardView view, String operatorId) {
        return new ExportSnapshot(
                view.role(), view.renderedAt(), view.freshnessLabel(), view.tiles(),
                "operator=" + operatorId + " taken=" + view.renderedAt() + " role=" + view.role());
    }
}
