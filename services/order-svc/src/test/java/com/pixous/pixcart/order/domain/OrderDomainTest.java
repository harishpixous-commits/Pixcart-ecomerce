package com.pixous.pixcart.order.domain;

import com.pixous.pixcart.order.domain.Order.QuoteLineRef;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.Event;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.Result;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.State;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * UML-STM-01 sub-order machine (exhaustive matrix) + order assembly acceptance
 * (FR-CUS-014 idempotency & paisa match, BRU-03 split).
 */
class OrderDomainTest {

    private static final Instant NOW = Instant.parse("2026-08-15T10:00:00Z");

    // ---------------------------------------------- exhaustive transition matrix

    @Test
    void everyStateEventPairMatchesUmlStm01() {
        // Legal edges transcribed from UML-STM-01. Anything absent must be Illegal.
        Map<State, Map<Event, State>> legal = new EnumMap<>(State.class);
        legal.put(State.CONFIRMED, Map.of(Event.ACCEPT, State.ACCEPTED, Event.CANCEL, State.CANCELLED));
        legal.put(State.ACCEPTED, Map.of(Event.PACK, State.PACKED, Event.CANCEL, State.CANCELLED));
        legal.put(State.PACKED, Map.of(Event.SHIP, State.SHIPPED, Event.CANCEL, State.CANCELLED));
        legal.put(State.SHIPPED, Map.of(Event.OUT_FOR_DELIVERY, State.OUT_FOR_DELIVERY));
        legal.put(State.OUT_FOR_DELIVERY, Map.of(Event.DELIVER, State.DELIVERED, Event.MARK_NDR, State.NDR));
        legal.put(State.NDR, Map.of(Event.REATTEMPT, State.OUT_FOR_DELIVERY, Event.INITIATE_RTO, State.RTO_INITIATED));
        legal.put(State.RTO_INITIATED, Map.of(Event.RECEIVE_RTO, State.RTO_RECEIVED));
        legal.put(State.RTO_RECEIVED, Map.of(Event.CLOSE, State.CLOSED));
        legal.put(State.DELIVERED, Map.of(Event.REQUEST_RETURN, State.RETURN_REQUESTED, Event.CLOSE, State.CLOSED));
        legal.put(State.RETURN_REQUESTED, Map.of(Event.PICK_UP_RETURN, State.RETURN_PICKED_UP));
        legal.put(State.RETURN_PICKED_UP, Map.of(Event.START_QC, State.QC));
        legal.put(State.QC, Map.of(Event.QC_PASS, State.REFUNDED, Event.QC_FAIL, State.RETURN_REJECTED));
        legal.put(State.REFUNDED, Map.of(Event.CLOSE, State.CLOSED));
        legal.put(State.RETURN_REJECTED, Map.of(Event.CLOSE, State.CLOSED));
        legal.put(State.CANCELLED, Map.of(Event.CLOSE, State.CLOSED));
        legal.put(State.CLOSED, Map.of());

        int checked = 0;
        for (State from : State.values()) {
            for (Event e : Event.values()) {
                Result r = SubOrderLifecycle.apply(from, e);
                State expected = legal.get(from).get(e);
                if (expected != null) {
                    assertEquals(new Result.Moved(expected), r, from + " × " + e);
                } else {
                    assertInstanceOf(Result.Illegal.class, r, from + " × " + e + " should be illegal");
                }
                checked++;
            }
        }
        assertEquals(State.values().length * Event.values().length, checked); // 16 × 16 = 256
    }

    @Test
    void cannotCancelAfterHandoverToCourier() {
        // Packed can still cancel (pre-manifest); once Shipped, cancel is gone.
        assertInstanceOf(Result.Moved.class, SubOrderLifecycle.apply(State.PACKED, Event.CANCEL));
        assertInstanceOf(Result.Illegal.class, SubOrderLifecycle.apply(State.SHIPPED, Event.CANCEL));
        assertInstanceOf(Result.Illegal.class, SubOrderLifecycle.apply(State.OUT_FOR_DELIVERY, Event.CANCEL));
    }

    @Test
    void happyPathConfirmedToClosedWalksLegally() {
        State s = State.CONFIRMED;
        for (Event e : List.of(Event.ACCEPT, Event.PACK, Event.SHIP, Event.OUT_FOR_DELIVERY,
                Event.DELIVER, Event.CLOSE)) {
            Result r = SubOrderLifecycle.apply(s, e);
            s = assertInstanceOf(Result.Moved.class, r).to();
        }
        assertEquals(State.CLOSED, s);
    }

    @Test
    void returnLegDeliveredToRefundedToClosed() {
        State s = State.DELIVERED;
        for (Event e : List.of(Event.REQUEST_RETURN, Event.PICK_UP_RETURN, Event.START_QC,
                Event.QC_PASS, Event.CLOSE)) {
            s = assertInstanceOf(Result.Moved.class, SubOrderLifecycle.apply(s, e)).to();
        }
        assertEquals(State.CLOSED, s);
    }

    @Test
    void ndrReattemptCapIsThree() {
        assertEquals(3, SubOrderLifecycle.MAX_NDR_REATTEMPTS);
        // the re-attempt edge itself is legal; the count is enforced by the aggregate
        assertInstanceOf(Result.Moved.class, SubOrderLifecycle.apply(State.NDR, Event.REATTEMPT));
        assertInstanceOf(Result.Moved.class, SubOrderLifecycle.apply(State.NDR, Event.INITIATE_RTO));
    }

    // ------------------------------------------------------- order assembly

    private static String mint(String vendorId) {
        return "SUB-" + vendorId;
    }

    @Test
    void splitsPerVendorAndSumsToGrandTotal_bru03() {
        var lines = List.of(
                new QuoteLineRef("L1", "V1", 40_000),
                new QuoteLineRef("L2", "V1", 20_000),
                new QuoteLineRef("L3", "V2", 60_000));
        var order = Order.create("ORD1", "QTE1", "PAYREF1", 120_000, lines, OrderDomainTest::mint, NOW);
        assertEquals(2, order.subOrders().size());
        assertEquals(60_000, order.subOrders().get(0).amountPaise()); // V1: 40k+20k
        assertEquals(60_000, order.subOrders().get(1).amountPaise()); // V2
        assertTrue(order.subOrders().stream().allMatch(s -> s.state() == State.CONFIRMED));
        long sum = order.subOrders().stream().mapToLong(Order.SubOrder::amountPaise).sum();
        assertEquals(order.grandTotalPaise(), sum);
    }

    @Test
    void assemblyRejectsWhenSplitDoesNotMatchQuoteToThePaisa() {
        var lines = List.of(new QuoteLineRef("L1", "V1", 99_999));
        var ex = assertThrows(IllegalArgumentException.class,
                () -> Order.create("ORD1", "QTE1", "PAYREF1", 100_000, lines, OrderDomainTest::mint, NOW));
        assertTrue(ex.getMessage().startsWith("SPLIT_MISMATCH"));
    }

    @Test
    void createOnceIsIdempotentOnPaymentReference_frCus014() {
        var factory = new Order.OrderFactory();
        var lines = List.of(new QuoteLineRef("L1", "V1", 50_000));
        var first = factory.createOnce("ORD1", "QTE1", "PAYREF-DUP", 50_000, lines, OrderDomainTest::mint, NOW);
        var second = factory.createOnce("ORD2", "QTE1", "PAYREF-DUP", 50_000, lines, OrderDomainTest::mint, NOW);
        assertInstanceOf(Order.OrderFactory.Outcome.Created.class, first);
        var existing = assertInstanceOf(Order.OrderFactory.Outcome.Existing.class, second);
        // the SAME order comes back — no second order for the same payment reference
        assertEquals("ORD1", existing.order().orderId());
    }

    @Test
    void singleVendorProducesOneSubOrder() {
        var order = Order.create("ORD1", "QTE1", "PAYREF1", 30_000,
                List.of(new QuoteLineRef("L1", "V1", 30_000)), OrderDomainTest::mint, NOW);
        assertEquals(1, order.subOrders().size());
        assertEquals(List.of("L1"), order.subOrders().get(0).lineIds());
    }
}
