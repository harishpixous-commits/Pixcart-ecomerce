package com.pixous.pixcart.identity.domain.vendor;

import com.pixous.pixcart.identity.domain.admin.AdminDashboard;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.Permission;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.StaffRole;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.Band;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.CustomerContext;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.DismissResult;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.Task;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.TaskKind;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.Tile;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.TileFigure;
import com.pixous.pixcart.identity.domain.vendor.VendorDashboard.TileState;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-VEN-014 vendor dashboard. The documented acceptance scenario is run directly, and the two
 * properties that protect somebody other than the vendor — the fee-notice receipt and the
 * Finance-view PII scoping — get the most attention.
 */
class VendorDashboardTest {

    private static final Instant NOW = Instant.parse("2026-08-24T10:00:00Z");

    private static Task order(String id, Instant slaDueAt) {
        return new Task(id, TaskKind.NEW_ORDER, "New order " + id, "/orders/" + id,
                slaDueAt, "order:" + id,
                new CustomerContext("Priya R", "641012", "+91******3210"));
    }

    private static Task feeNotice(String id) {
        return new Task(id, TaskKind.FEE_NOTICE,
                "Commission on Sarees rises to 9% from 10 September",
                "/notices/" + id, null, "notice:" + id, null);
    }

    private static List<TileFigure> figures() {
        return List.of(
                new TileFigure(Tile.TODAYS_ORDERS, "12", "order-svc"),
                new TileFigure(Tile.TODAYS_GMV, "24,600", "order-svc"),
                new TileFigure(Tile.PENDING_PAYOUT, "1,08,400", "finance-svc"),
                new TileFigure(Tile.RETURN_RATE, "4.1%", "order-svc"));
    }

    private static VendorDashboard dashboard() {
        return new VendorDashboard("01VEND0001");
    }

    // ============================================ the acceptance criterion

    @Test
    void threeNewOrdersWithOneBreachingPinsThatOneToTopInARedBand() {
        // "Given 3 New orders with 1 breaching accept-SLA in 20 min, When dashboard loads, Then
        //  the breaching task pins to the top in a red band."
        var d = dashboard();
        var tasks = List.of(
                order("ORD-1", NOW.plus(Duration.ofHours(6))),
                order("ORD-2", NOW.plus(Duration.ofMinutes(20))),      // breaching
                order("ORD-3", NOW.plus(Duration.ofHours(3))));

        var view = d.compose(StaffRole.ORDERS, tasks, figures(), Set.of(), NOW);

        assertEquals(3, view.tasks().size());
        assertEquals("ORD-2", view.tasks().get(0).taskId());
        assertEquals(Band.RED, view.tasks().get(0).band());
        assertTrue(view.tasks().get(0).pinned());
        assertEquals(1, view.redBandCount());
        // and the others are not red
        assertEquals(Band.NORMAL, view.tasks().get(1).band());
        assertEquals(Band.NORMAL, view.tasks().get(2).band());
    }

    @Test
    void anAlreadyBreachedTaskPinsToo() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS,
                List.of(order("ORD-LATE", NOW.minus(Duration.ofHours(2))),
                        order("ORD-OK", NOW.plus(Duration.ofHours(6)))),
                figures(), Set.of(), NOW);
        assertEquals("ORD-LATE", view.tasks().get(0).taskId());
        assertEquals(Band.RED, view.tasks().get(0).band());
    }

    @Test
    void withinTheRedBandTheSoonestSlaLeads() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS,
                List.of(order("ORD-A", NOW.plus(Duration.ofMinutes(25))),
                        order("ORD-B", NOW.plus(Duration.ofMinutes(5))),
                        order("ORD-C", NOW.plus(Duration.ofMinutes(15)))),
                figures(), Set.of(), NOW);
        assertEquals(List.of("ORD-B", "ORD-C", "ORD-A"),
                view.tasks().stream().map(t -> t.taskId()).toList());
        assertEquals(3, view.redBandCount());
    }

    @Test
    void theBreachWarningBoundaryIsExact() {
        assertEquals(Duration.ofMinutes(30), VendorDashboard.SLA_BREACH_WARNING);
        assertTrue(VendorDashboard.isBreaching(order("O", NOW.plus(Duration.ofMinutes(30))), NOW));
        assertFalse(VendorDashboard.isBreaching(order("O", NOW.plus(Duration.ofMinutes(31))), NOW));
        // a task with no SLA cannot breach one
        assertFalse(VendorDashboard.isBreaching(feeNotice("N-1"), NOW));
    }

    // ============================================ fee-notice read receipt

    @Test
    void aFeeNoticeCannotBeDismissedWithoutAReadReceipt() {
        var d = dashboard();
        var notice = feeNotice("N-1");

        var refused = assertInstanceOf(DismissResult.ReadReceiptRequired.class,
                d.dismiss(notice, "VEN-USER-1", NOW));
        // notice that can be swiped away unacknowledged is not notice
        assertEquals("N-1", refused.taskId());
        assertTrue(refused.notice().contains("Commission on Sarees"));
        assertTrue(d.dismissedTaskIds().isEmpty());

        d.recordReadReceipt("N-1", "VEN-USER-1", NOW.plusSeconds(30));
        var dismissed = assertInstanceOf(DismissResult.Dismissed.class,
                d.dismiss(notice, "VEN-USER-1", NOW.plusSeconds(60)));
        assertEquals(NOW.plusSeconds(60), dismissed.at());
        assertTrue(d.dismissedTaskIds().contains("N-1"));
    }

    @Test
    void theReadReceiptIsTheComplianceTrailAndRecordsWhoAndWhen() {
        var d = dashboard();
        d.recordReadReceipt("N-1", "VEN-USER-7", NOW);
        var receipt = d.readReceipt("N-1").orElseThrow();
        assertEquals("VEN-USER-7", receipt.userId());
        assertEquals(NOW, receipt.at());
        assertTrue(d.readReceipt("N-UNKNOWN").isEmpty());
    }

    @Test
    void aPolicyNoticeCarriesTheSameObligationAsAFeeNotice() {
        var d = dashboard();
        var policy = new Task("P-1", TaskKind.POLICY_NOTICE, "Returns policy update",
                "/notices/P-1", null, "notice:P-1", null);
        assertTrue(TaskKind.POLICY_NOTICE.requiresReadReceipt());
        assertInstanceOf(DismissResult.ReadReceiptRequired.class, d.dismiss(policy, "VEN-USER-1", NOW));
    }

    @Test
    void anOrdinaryTaskNeedsNoReceipt() {
        var d = dashboard();
        assertFalse(TaskKind.NEW_ORDER.requiresReadReceipt());
        assertInstanceOf(DismissResult.Dismissed.class,
                d.dismiss(order("ORD-1", NOW.plus(Duration.ofHours(6))), "VEN-USER-1", NOW));
    }

    @Test
    void aDismissedTaskCannotBeDismissedTwice() {
        var d = dashboard();
        var task = order("ORD-1", NOW.plus(Duration.ofHours(6)));
        d.dismiss(task, "VEN-USER-1", NOW);
        var again = assertInstanceOf(DismissResult.Rejected.class, d.dismiss(task, "VEN-USER-1", NOW));
        assertEquals("ALREADY_DISMISSED", again.reason());
    }

    @Test
    void aDismissedTaskLeavesTheQueue() {
        var d = dashboard();
        var task = order("ORD-1", NOW.plus(Duration.ofHours(6)));
        assertEquals(1, d.compose(StaffRole.ORDERS, List.of(task), figures(), Set.of(), NOW).tasks().size());
        d.dismiss(task, "VEN-USER-1", NOW);
        assertTrue(d.compose(StaffRole.ORDERS, List.of(task), figures(), Set.of(), NOW).tasks().isEmpty());
    }

    // ============================================ snooze

    @Test
    void aBreachingTaskCannotBeSnoozed() {
        var d = dashboard();
        var breaching = order("ORD-2", NOW.plus(Duration.ofMinutes(10)));
        var refused = assertInstanceOf(DismissResult.Rejected.class,
                d.snooze(breaching, NOW.plus(Duration.ofHours(2)), NOW));
        // snoozing an SLA does not move the SLA, it only hides that it is about to be missed
        assertEquals("CANNOT_SNOOZE_AN_SLA_BREACHING_TASK", refused.reason());
        assertTrue(d.snoozedUntil("ORD-2").isEmpty());
    }

    @Test
    void aNonBreachingTaskCanBeSnoozedAndReturnsWhenTheSnoozeLapses() {
        var d = dashboard();
        var task = order("ORD-1", NOW.plus(Duration.ofHours(8)));
        assertInstanceOf(DismissResult.Dismissed.class,
                d.snooze(task, NOW.plus(Duration.ofHours(2)), NOW));

        assertTrue(d.compose(StaffRole.ORDERS, List.of(task), figures(), Set.of(), NOW).tasks().isEmpty());
        // once the snooze lapses the task is back
        var later = d.compose(StaffRole.ORDERS, List.of(task), figures(), Set.of(),
                NOW.plus(Duration.ofHours(3)));
        assertEquals(1, later.tasks().size());
    }

    @Test
    void aSnoozeMustBeInTheFutureAndANoticeMustBeReadFirst() {
        var d = dashboard();
        var task = order("ORD-1", NOW.plus(Duration.ofHours(8)));
        assertInstanceOf(DismissResult.Rejected.class, d.snooze(task, NOW, NOW));
        assertInstanceOf(DismissResult.Rejected.class, d.snooze(task, null, NOW));

        // a notice may be deferred, but only once it has been read
        var notice = feeNotice("N-1");
        assertInstanceOf(DismissResult.ReadReceiptRequired.class,
                d.snooze(notice, NOW.plus(Duration.ofHours(4)), NOW));
        d.recordReadReceipt("N-1", "VEN-USER-1", NOW);
        assertInstanceOf(DismissResult.Dismissed.class,
                d.snooze(notice, NOW.plus(Duration.ofHours(4)), NOW));
    }

    // ============================================ sub-role scoping

    @Test
    void financeViewStaffSeeNoCustomerPii() {
        var d = dashboard();
        // a Finance-view staff member needs payout figures, not a buyer's name and address
        var view = d.compose(StaffRole.FINANCE_VIEW,
                List.of(feeNotice("N-1")), figures(), Set.of(), NOW);
        assertEquals(1, view.tasks().size());
        assertTrue(view.tasks().get(0).customer().isEmpty());
    }

    @Test
    void financeViewCannotSeeOrderTasksAtAll() {
        var d = dashboard();
        var view = d.compose(StaffRole.FINANCE_VIEW,
                List.of(order("ORD-1", NOW.plus(Duration.ofHours(6))), feeNotice("N-1")),
                figures(), Set.of(), NOW);
        assertEquals(List.of("N-1"), view.tasks().stream().map(t -> t.taskId()).toList());
    }

    @Test
    void anOrdersRoleDoesSeeTheCustomerContextItNeeds() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS,
                List.of(order("ORD-1", NOW.plus(Duration.ofHours(6)))), figures(), Set.of(), NOW);
        var customer = view.tasks().get(0).customer().orElseThrow();
        assertEquals("Priya R", customer.customerName());
        assertEquals("641012", customer.deliveryPincode());
    }

    @Test
    void aCatalogueRoleSeesQcFixesButNotOrdersOrFinance() {
        var d = dashboard();
        var qc = new Task("QC-1", TaskKind.QC_FIX, "Add a size chart", "/catalogue/QC-1",
                null, "qc:QC-1", null);
        var view = d.compose(StaffRole.CATALOGUE,
                List.of(qc, order("ORD-1", NOW.plus(Duration.ofHours(6))), feeNotice("N-1")),
                figures(), Set.of(), NOW);
        assertEquals(List.of("QC-1"), view.tasks().stream().map(t -> t.taskId()).toList());
        assertTrue(view.tiles().isEmpty(), "Catalogue staff have no order or finance tiles");
    }

    @Test
    void tileVisibilityMatchesTheSliceFortySixRoleMatrix() {
        for (Tile tile : Tile.values()) {
            for (StaffRole role : StaffRole.values()) {
                boolean permitted = StoreSettings.roleGrants(role, tile.requires());
                assertEquals(permitted, VendorDashboard.visibleTilesFor(role).contains(tile),
                        role + " / " + tile + " must match the role matrix, not a copy of it");
            }
        }
    }

    @Test
    void noRoleSeesAPayoutEditingSurfaceThroughTheDashboard() {
        // the dashboard shows the pending-payout FIGURE to Finance-view, which is a read
        for (StaffRole role : StaffRole.values()) {
            assertFalse(StoreSettings.roleGrants(role, Permission.PAYOUT_SETTINGS_EDIT), role.name());
        }
        assertTrue(VendorDashboard.visibleTilesFor(StaffRole.FINANCE_VIEW).contains(Tile.PENDING_PAYOUT));
    }

    // ============================================ dedupe

    @Test
    void tasksAreDeduplicatedByKey() {
        var d = dashboard();
        // the same order arriving twice from two upstream events
        var tasks = List.of(
                order("ORD-1", NOW.plus(Duration.ofHours(6))),
                new Task("ORD-1-DUP", TaskKind.NEW_ORDER, "New order ORD-1", "/orders/ORD-1",
                        NOW.plus(Duration.ofHours(6)), "order:ORD-1", null));

        var view = d.compose(StaffRole.ORDERS, tasks, figures(), Set.of(), NOW);
        // a duplicated task inflates the count a vendor is judged on
        assertEquals(1, view.tasks().size());
        assertEquals("ORD-1", view.tasks().get(0).taskId(), "the first occurrence is kept");
    }

    @Test
    void differentTasksWithDifferentKeysBothSurvive() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS,
                List.of(order("ORD-1", NOW.plus(Duration.ofHours(6))),
                        order("ORD-2", NOW.plus(Duration.ofHours(7)))),
                figures(), Set.of(), NOW);
        assertEquals(2, view.tasks().size());
    }

    @Test
    void aTaskCannotBeConstructedWithoutADedupeKeyOrId() {
        assertThrows(IllegalArgumentException.class, () -> new Task(
                "T", TaskKind.NEW_ORDER, "t", "/x", null, "  ", null));
        assertThrows(IllegalArgumentException.class, () -> new Task(
                "", TaskKind.NEW_ORDER, "t", "/x", null, "k", null));
    }

    // ============================================ never blank

    @Test
    void aFailedTileBecomesASkeletonWithARetryRatherThanDisappearing() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS, List.of(), figures(),
                Set.of(Tile.TODAYS_GMV), NOW);

        var gmv = view.tiles().stream().filter(t -> t.tile() == Tile.TODAYS_GMV).findFirst().orElseThrow();
        assertEquals(TileState.SKELETON, gmv.state());
        assertTrue(gmv.retryAvailable());
        assertEquals("SOURCE_UNAVAILABLE", gmv.unavailableReason());

        // and the other tiles still load: one failed query does not fail the page
        var orders = view.tiles().stream().filter(t -> t.tile() == Tile.TODAYS_ORDERS).findFirst().orElseThrow();
        assertEquals(TileState.LOADED, orders.state());
        assertEquals("12", orders.value());
    }

    @Test
    void thePageIsNeverBlankEvenWhenEveryTileFailed() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS,
                List.of(order("ORD-1", NOW.plus(Duration.ofHours(6)))),
                List.of(), Set.of(Tile.values()), NOW);

        assertFalse(view.isBlank());
        assertFalse(view.tiles().isEmpty());
        assertTrue(view.tiles().stream().allMatch(t -> t.state() == TileState.SKELETON));
        // the task queue is unaffected by tile failures
        assertEquals(1, view.tasks().size());
    }

    @Test
    void aMissingFigureIsDistinguishedFromAFailedSource() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS, List.of(),
                List.of(new TileFigure(Tile.TODAYS_ORDERS, "12", "order-svc")), Set.of(), NOW);
        var gmv = view.tiles().stream().filter(t -> t.tile() == Tile.TODAYS_GMV).findFirst().orElseThrow();
        assertEquals(TileState.SKELETON, gmv.state());
        assertEquals("NO_FIGURE_SUPPLIED", gmv.unavailableReason());
    }

    @Test
    void tilesCarryTheDocumentedFreshness() {
        // "real-time orders; D-1 aggregates"
        assertEquals(AdminDashboard.Freshness.REAL_TIME, Tile.TODAYS_ORDERS.freshness());
        assertEquals(AdminDashboard.Freshness.REAL_TIME, Tile.TODAYS_GMV.freshness());
        assertEquals(AdminDashboard.Freshness.D_MINUS_1, Tile.PENDING_PAYOUT.freshness());
        assertEquals(AdminDashboard.Freshness.D_MINUS_1, Tile.RETURN_RATE.freshness());
    }

    @Test
    void everyFigureMustNameItsSourceModule() {
        // VALIDATION: counts stay consistent with the underlying modules
        assertThrows(IllegalArgumentException.class,
                () -> new TileFigure(Tile.TODAYS_ORDERS, "12", "  "));
        assertThrows(IllegalArgumentException.class,
                () -> new TileFigure(Tile.TODAYS_ORDERS, "12", null));
    }

    @Test
    void anEmptyQueueStillRendersTiles() {
        var d = dashboard();
        var view = d.compose(StaffRole.ORDERS, List.of(), figures(), Set.of(), NOW);
        assertTrue(view.tasks().isEmpty());
        assertFalse(view.isBlank());
        assertEquals(0, view.redBandCount());
        assertEquals(NOW, view.renderedAt());
    }
}
