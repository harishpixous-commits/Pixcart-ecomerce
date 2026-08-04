package com.pixous.pixcart.inventory.domain;

import com.pixous.pixcart.inventory.domain.InventoryItem.Result;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** FR-VEN-004 inventory: ATP, no-oversell, reserve→commit→release, idempotency, safety stock. */
class InventoryItemTest {

    private static InventoryItem item(int onHand, int reserved, int safety) {
        return new InventoryItem("SKU-1", "LOC-1", onHand, reserved, safety);
    }

    @Test
    void atpIsOnHandMinusReservedMinusSafety() {
        assertEquals(70, item(100, 20, 10).availableToPromise());
    }

    @Test
    void reserveWithinAtpSucceedsAndReducesAtp() {
        var inv = item(100, 0, 0);
        var r = inv.reserve("HOLD-1", 30);
        assertEquals(new Result.Ok(70), r);
        assertEquals(30, inv.reserved());
        assertTrue(inv.invariantHolds());
    }

    @Test
    void reserveBeyondAtpIsRejected_noOversell() {
        var inv = item(10, 0, 0);
        var r = inv.reserve("HOLD-1", 11);
        var rej = assertInstanceOf(Result.Rejected.class, r);
        assertTrue(rej.reason().startsWith("INSUFFICIENT_ATP"));
        assertEquals(0, inv.reserved(), "a rejected reservation must not change stock");
        assertTrue(inv.invariantHolds());
    }

    @Test
    void safetyStockIsProtectedFromReservation() {
        var inv = item(100, 0, 90); // ATP = 10
        assertInstanceOf(Result.Rejected.class, inv.reserve("H", 11));
        assertInstanceOf(Result.Ok.class, inv.reserve("H", 10));
    }

    @Test
    void concurrentHoldsCannotCollectivelyOversell() {
        var inv = item(10, 0, 0);
        assertInstanceOf(Result.Ok.class, inv.reserve("A", 6));
        // second hold can only take the remaining 4, not another 6
        assertInstanceOf(Result.Rejected.class, inv.reserve("B", 6));
        assertInstanceOf(Result.Ok.class, inv.reserve("B", 4));
        assertEquals(0, inv.availableToPromise());
        assertTrue(inv.invariantHolds());
    }

    @Test
    void reserveIsIdempotentOnHoldRef() {
        var inv = item(100, 0, 0);
        assertInstanceOf(Result.Ok.class, inv.reserve("HOLD-1", 30));
        var again = inv.reserve("HOLD-1", 30);
        assertInstanceOf(Result.Idempotent.class, again);
        assertEquals(30, inv.reserved(), "replay must not double-reserve");
        // same ref, different qty is a conflict
        assertInstanceOf(Result.Rejected.class, inv.reserve("HOLD-1", 40));
    }

    @Test
    void commitDecrementsOnHandAndReserved() {
        var inv = item(100, 0, 0);
        inv.reserve("HOLD-1", 30);
        var r = inv.commit("HOLD-1");
        assertInstanceOf(Result.Ok.class, r);
        assertEquals(70, inv.onHand());
        assertEquals(0, inv.reserved());
        assertFalse(inv.hasHold("HOLD-1"));
        assertTrue(inv.invariantHolds());
    }

    @Test
    void releaseRestoresAtpWithoutTouchingOnHand() {
        var inv = item(100, 0, 0);
        inv.reserve("HOLD-1", 30);
        assertEquals(70, inv.availableToPromise());
        var r = inv.release("HOLD-1");
        assertInstanceOf(Result.Ok.class, r);
        assertEquals(100, inv.onHand());
        assertEquals(0, inv.reserved());
        assertEquals(100, inv.availableToPromise());
    }

    @Test
    void commitOrReleaseOfUnknownHoldIsRejected() {
        var inv = item(100, 0, 0);
        assertInstanceOf(Result.Rejected.class, inv.commit("nope"));
        assertInstanceOf(Result.Rejected.class, inv.release("nope"));
    }

    @Test
    void cannotCommitTwice() {
        var inv = item(100, 0, 0);
        inv.reserve("HOLD-1", 30);
        assertInstanceOf(Result.Ok.class, inv.commit("HOLD-1"));
        assertInstanceOf(Result.Rejected.class, inv.commit("HOLD-1")); // spent
        assertEquals(70, inv.onHand());
    }

    @Test
    void restockAddsPhysicalStock() {
        var inv = item(5, 0, 0);
        inv.reserve("H", 5);                 // ATP now 0
        assertEquals(0, inv.availableToPromise());
        inv.restock(20);                     // GRN inbound
        assertEquals(20, inv.availableToPromise());
        assertEquals(25, inv.onHand());
    }

    @Test
    void lowStockAlertFiresAtThreshold() {
        var inv = item(12, 0, 0);
        assertFalse(inv.isLowStock(10));
        inv.reserve("H", 3);                 // ATP = 9
        assertTrue(inv.isLowStock(10));
    }

    @Test
    void rowVersionAdvancesOnEveryMutation() {
        var inv = item(100, 0, 0);
        int v0 = inv.rowVersion();
        inv.reserve("H", 10);
        inv.commit("H");
        assertEquals(v0 + 2, inv.rowVersion());
    }

    @Test
    void constructorRejectsReservedOverOnHand() {
        assertThrows(IllegalArgumentException.class, () -> item(5, 6, 0));
    }

    @Test
    void fullLifecycleReserveThenReleaseThenReReserve() {
        var inv = item(10, 0, 0);
        inv.reserve("A", 10);
        assertEquals(0, inv.availableToPromise());
        inv.release("A");                    // cancel
        assertEquals(10, inv.availableToPromise());
        assertInstanceOf(Result.Ok.class, inv.reserve("B", 10)); // stock freed for another order
    }
}
