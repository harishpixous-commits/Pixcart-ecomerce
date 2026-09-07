package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.identity.domain.admin.AdminDashboard.AnomalyBadge;
import com.pixous.pixcart.identity.domain.admin.AdminDashboard.Freshness;
import com.pixous.pixcart.identity.domain.admin.AdminDashboard.SourceFigure;
import com.pixous.pixcart.identity.domain.admin.AdminDashboard.Threshold;
import com.pixous.pixcart.identity.domain.admin.AdminDashboard.Tile;
import com.pixous.pixcart.identity.domain.admin.AdminDashboard.TileState;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-ADM-001 admin overview dashboard. The two properties worth proving are that a red state is
 * never a dead end (it always carries a runbook, and payment success carries an incident link
 * within 60 seconds) and that a role never sees a tile it is not permitted elsewhere in the
 * platform — checked against the real Vol.2 §2.4 capability matrix rather than a copy of it.
 */
class AdminDashboardTest {

    private static final Instant NOW = Instant.parse("2026-08-20T10:00:00Z");

    private static SourceFigure figure(Tile tile, double value) {
        return new SourceFigure(tile, value, "source:" + tile.name().toLowerCase(), NOW,
                tile.expectedFreshness());
    }

    /** Payment success is bad when LOW: amber under 97%, red under 95%. */
    private static Threshold paymentThreshold() {
        return new Threshold(Tile.PAYMENT_SUCCESS, 0.97, 0.95, true);
    }

    /** Risk queue depth is bad when HIGH. */
    private static Threshold riskThreshold() {
        return new Threshold(Tile.RISK_QUEUE_DEPTH, 50, 200, false);
    }

    // ============================================ the acceptance criterion

    @Test
    void paymentSuccessBelowThresholdTurnsRedWithinSixtySecondsAndLinksToTheIncidentView() {
        // "Given payment success dips below alert threshold, When dashboard is open, Then the tile
        //  turns red within 60 s with a link to the payments incident view."
        var view = AdminDashboard.compose(Rbac.Role.ADMIN,
                List.of(figure(Tile.PAYMENT_SUCCESS, 0.912)),
                List.of(paymentThreshold()), List.of(), NOW.plusSeconds(30));

        var tile = view.tile(Tile.PAYMENT_SUCCESS).orElseThrow();
        assertEquals(TileState.RED, tile.state());
        assertTrue(tile.incidentUrl().isPresent());
        assertEquals("/incidents/payments", tile.incidentUrl().get());
        assertTrue(AdminDashboard.surfacedWithinAlertWindow(tile, NOW.plusSeconds(30)));
        assertEquals(Duration.ofSeconds(60), AdminDashboard.ALERT_PROPAGATION);
    }

    @Test
    void aBreachSurfacedLateIsDetectableAsOutsideTheWindow() {
        var tile = AdminDashboard.renderTile(figure(Tile.PAYMENT_SUCCESS, 0.90), paymentThreshold(), null);
        assertTrue(AdminDashboard.surfacedWithinAlertWindow(tile, NOW.plusSeconds(60)));
        assertFalse(AdminDashboard.surfacedWithinAlertWindow(tile, NOW.plusSeconds(61)),
                "the figure's as-of instant is the clock that matters, not when the page opened");
    }

    @Test
    void everyRedTileCarriesARunbookSoItIsNeverADeadEnd() {
        for (Tile tile : Tile.values()) {
            assertTrue(AdminDashboard.runbookFor(tile).isPresent(), tile + " has no runbook");
        }
    }

    @Test
    void aGreenTileCarriesNoRunbookOrIncidentLink() {
        var tile = AdminDashboard.renderTile(figure(Tile.PAYMENT_SUCCESS, 0.995), paymentThreshold(), null);
        assertEquals(TileState.GREEN, tile.state());
        assertTrue(tile.runbookUrl().isEmpty());
        assertTrue(tile.incidentUrl().isEmpty());
    }

    // ============================================ threshold direction

    @Test
    void thresholdDirectionIsRespectedForBothKindsOfKpi() {
        // low is bad: payment success
        var low = paymentThreshold();
        assertEquals(TileState.GREEN, AdminDashboard.stateOf(0.99, low));
        assertEquals(TileState.AMBER, AdminDashboard.stateOf(0.97, low));
        assertEquals(TileState.AMBER, AdminDashboard.stateOf(0.96, low));
        assertEquals(TileState.RED, AdminDashboard.stateOf(0.95, low));
        assertEquals(TileState.RED, AdminDashboard.stateOf(0.80, low));

        // high is bad: risk queue depth. A single comparison direction would get this backwards.
        var high = riskThreshold();
        assertEquals(TileState.GREEN, AdminDashboard.stateOf(10, high));
        assertEquals(TileState.AMBER, AdminDashboard.stateOf(50, high));
        assertEquals(TileState.RED, AdminDashboard.stateOf(200, high));
        assertEquals(TileState.RED, AdminDashboard.stateOf(500, high));
    }

    @Test
    void aTileWithNoConfiguredThresholdIsGreenRatherThanAlarming() {
        var tile = AdminDashboard.renderTile(figure(Tile.FUNNEL_CONVERSION, 0.02), null, null);
        assertEquals(TileState.GREEN, tile.state());
    }

    // ============================================ role trimming

    @Test
    void marketingSeesNoFinanceDetail() {
        // SECURITY: "Role-trimmed tiles (MKT sees no finance detail)"
        var figures = List.of(
                figure(Tile.GMV_TODAY, 1_250_000),
                figure(Tile.PAYMENT_SUCCESS, 0.98),
                figure(Tile.FUNNEL_CONVERSION, 0.031));

        var mkt = AdminDashboard.compose(Rbac.Role.MARKETING, figures, List.of(), List.of(), NOW);
        assertTrue(mkt.tile(Tile.PAYMENT_SUCCESS).isEmpty(),
                "payment success is settlement detail and must not reach Marketing");

        var admin = AdminDashboard.compose(Rbac.Role.ADMIN, figures, List.of(), List.of(), NOW);
        assertTrue(admin.tile(Tile.PAYMENT_SUCCESS).isPresent());
    }

    @Test
    void tileVisibilityIsDrivenByTheRealCapabilityMatrix() {
        for (Tile tile : Tile.values()) {
            for (Rbac.Role role : Rbac.Role.values()) {
                boolean permitted = Rbac.permits(role, tile.requires());
                boolean visible = AdminDashboard.visibleTilesFor(role).contains(tile);
                assertEquals(permitted, visible,
                        role + " / " + tile + " must match the §2.4 matrix, not a copy of it");
            }
        }
    }

    @Test
    void aSuperAdminSeesEveryTileAndACustomerSeesNoOperatorTile() {
        assertEquals(Tile.values().length, AdminDashboard.visibleTilesFor(Rbac.Role.SUPER_ADMIN).size());
        var customer = AdminDashboard.visibleTilesFor(Rbac.Role.CUSTOMER);
        assertFalse(customer.contains(Tile.PAYMENT_SUCCESS));
        assertFalse(customer.contains(Tile.RISK_QUEUE_DEPTH));
        assertFalse(customer.contains(Tile.SYSTEM_HEALTH));
    }

    @Test
    void aRoleWithNoVisibleTilesGetsAnHonestEmptyView() {
        var view = AdminDashboard.compose(Rbac.Role.CUSTOMER,
                List.of(figure(Tile.PAYMENT_SUCCESS, 0.98)), List.of(), List.of(), NOW);
        assertTrue(view.tiles().isEmpty());
        assertFalse(view.mixedFreshness());
        assertEquals("No tiles visible for this role", view.freshnessLabel());
    }

    // ============================================ freshness labelling

    @Test
    void mixedFreshnessAlwaysCarriesALabel() {
        // ERRORS: "never mixed-freshness without label"
        var view = AdminDashboard.compose(Rbac.Role.SUPER_ADMIN,
                List.of(
                        figure(Tile.PAYMENT_SUCCESS, 0.98),   // real-time
                        figure(Tile.GMV_MTD, 42_000_000)),    // D-1
                List.of(), List.of(), NOW);

        assertTrue(view.mixedFreshness());
        assertFalse(view.freshnessLabel().isBlank(), "a mixed view must never be unlabelled");
        assertTrue(view.freshnessLabel().contains("Mixed freshness"));
    }

    @Test
    void aUniformViewIsLabelledAccordinglyAndNotFlaggedAsMixed() {
        var live = AdminDashboard.compose(Rbac.Role.SUPER_ADMIN,
                List.of(figure(Tile.PAYMENT_SUCCESS, 0.98), figure(Tile.ORDERS_BY_STATE, 1_204)),
                List.of(), List.of(), NOW);
        assertFalse(live.mixedFreshness());
        assertEquals("All tiles live", live.freshnessLabel());

        var daily = AdminDashboard.compose(Rbac.Role.SUPER_ADMIN,
                List.of(figure(Tile.GMV_MTD, 42_000_000), figure(Tile.OTIF, 0.94)),
                List.of(), List.of(), NOW);
        assertFalse(daily.mixedFreshness());
        assertEquals("All tiles D-1", daily.freshnessLabel());
    }

    @Test
    void everyTileCarriesItsOwnFreshnessStampRegardlessOfTheCompositeLabel() {
        var view = AdminDashboard.compose(Rbac.Role.SUPER_ADMIN,
                List.of(figure(Tile.PAYMENT_SUCCESS, 0.98), figure(Tile.GMV_MTD, 42_000_000)),
                List.of(), List.of(), NOW);
        for (var t : view.tiles()) {
            assertFalse(t.freshnessStamp().isBlank(), t.tile() + " has no freshness stamp");
        }
        assertTrue(view.tile(Tile.PAYMENT_SUCCESS).orElseThrow().freshnessStamp().startsWith("live as of"));
        assertTrue(view.tile(Tile.GMV_MTD).orElseThrow().freshnessStamp().contains("(D-1)"));
    }

    @Test
    void theDocumentedTilesHaveTheDocumentedFreshness() {
        // "order/payment real-time; others D-1"
        assertEquals(Freshness.REAL_TIME, Tile.ORDERS_BY_STATE.expectedFreshness());
        assertEquals(Freshness.REAL_TIME, Tile.PAYMENT_SUCCESS.expectedFreshness());
        assertEquals(Freshness.D_MINUS_1, Tile.GMV_MTD.expectedFreshness());
        assertEquals(Freshness.D_MINUS_1, Tile.OTIF.expectedFreshness());
        assertEquals(Freshness.D_MINUS_1, Tile.RETURNS.expectedFreshness());
    }

    // ============================================ single semantic layer

    @Test
    void aTileCarriesItsSourceModuleAndAgreesWithIt() {
        // VALIDATION: "figures reconcile with source modules (single semantic layer)"
        var tile = AdminDashboard.renderTile(figure(Tile.GMV_TODAY, 1_250_000), null, null);
        assertEquals("source:gmv_today", tile.sourceModule());
        assertTrue(AdminDashboard.reconciles(tile, 1_250_000));
        assertFalse(AdminDashboard.reconciles(tile, 1_250_001),
                "a one-rupee divergence from the source is still a divergence");
    }

    @Test
    void theDashboardExposesNoWayToSupplyOrOverrideAFigure() {
        var suspicious = java.util.Arrays.stream(AdminDashboard.class.getMethods())
                .map(java.lang.reflect.Method::getName)
                .filter(n -> {
                    String l = n.toLowerCase();
                    return l.startsWith("settile") || l.contains("override") || l.contains("setvalue")
                            || l.contains("computegmv") || l.contains("recalculate");
                })
                .toList();
        assertTrue(suspicious.isEmpty(), "the dashboard must stay a projection, found: " + suspicious);
    }

    @Test
    void aFigureWithoutASourceModuleOrAsOfInstantIsUnconstructible() {
        assertThrows(IllegalArgumentException.class,
                () -> new SourceFigure(Tile.GMV_TODAY, 1, "  ", NOW, Freshness.REAL_TIME));
        assertThrows(IllegalArgumentException.class,
                () -> new SourceFigure(Tile.GMV_TODAY, 1, "src", null, Freshness.REAL_TIME));
    }

    // ============================================ health & anomalies

    @Test
    void theHealthTileMirrorsSloBurn() {
        assertEquals(TileState.GREEN, AdminDashboard.healthFromSloBurn(0.4));
        assertEquals(TileState.AMBER, AdminDashboard.healthFromSloBurn(1.0));
        assertEquals(TileState.AMBER, AdminDashboard.healthFromSloBurn(1.9));
        assertEquals(TileState.RED, AdminDashboard.healthFromSloBurn(2.0));
        assertEquals(TileState.RED, AdminDashboard.healthFromSloBurn(14.4));
    }

    @Test
    void anomalyBadgesCarryAnExplainLink() {
        var badge = new AnomalyBadge(Tile.GMV_TODAY, "GMV 32% below the 8-week Tuesday median",
                "/ai/anomalies/gmv-2026-08-20");
        var view = AdminDashboard.compose(Rbac.Role.ADMIN, List.of(figure(Tile.GMV_TODAY, 800_000)),
                List.of(), List.of(badge), NOW);
        var tile = view.tile(Tile.GMV_TODAY).orElseThrow();
        assertTrue(tile.anomaly().isPresent());
        assertEquals("/ai/anomalies/gmv-2026-08-20", tile.anomaly().get().explainUrl());
        assertTrue(tile.anomaly().get().note().contains("32%"));
    }

    @Test
    void aTileWithoutAnAnomalyCarriesNone() {
        var view = AdminDashboard.compose(Rbac.Role.ADMIN, List.of(figure(Tile.GMV_TODAY, 1_250_000)),
                List.of(), List.of(), NOW);
        assertTrue(view.tile(Tile.GMV_TODAY).orElseThrow().anomaly().isEmpty());
    }

    // ============================================ export

    @Test
    void anExportSnapshotCarriesTheFreshnessLabelAndAWatermark() {
        var view = AdminDashboard.compose(Rbac.Role.ADMIN,
                List.of(figure(Tile.PAYMENT_SUCCESS, 0.98), figure(Tile.GMV_MTD, 42_000_000)),
                List.of(), List.of(), NOW);
        var snap = AdminDashboard.exportSnapshot(view, "01ADM1");

        assertEquals(view.freshnessLabel(), snap.freshnessLabel(),
                "a PDF read a week later must not be mistaken for live data");
        assertTrue(snap.freshnessLabel().contains("Mixed freshness"));
        assertTrue(snap.watermark().contains("operator=01ADM1"));
        assertTrue(snap.watermark().contains("role=ADMIN"));
        assertEquals(NOW, snap.takenAt());
        assertEquals(view.tiles().size(), snap.tiles().size());
    }
}
