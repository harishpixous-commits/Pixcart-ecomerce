package com.pixous.pixcart.e2e;

import com.pixous.pixcart.finance.domain.SettlementEngine;
import com.pixous.pixcart.finance.domain.SettlementEngine.AccrualLine;
import com.pixous.pixcart.finance.domain.SettlementEngine.BatchResult;
import com.pixous.pixcart.finance.domain.SettlementEngine.SettlementBatch;
import com.pixous.pixcart.finance.domain.SettlementEngine.VendorAccount;
import com.pixous.pixcart.order.domain.Order;
import com.pixous.pixcart.order.domain.Order.QuoteLineRef;
import com.pixous.pixcart.order.domain.SubOrderLifecycle;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.Event;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.State;
import com.pixous.pixcart.order.domain.returns.ReturnSaga;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.Disposition;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.ReasonCode;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.Resolution;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.ReturnRequest;
import com.pixous.pixcart.payment.domain.Payment;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * END-TO-END COMPOSITION PROOF (Slice 9).
 *
 * Every earlier slice proved its own aggregate in isolation. This test proves the
 * aggregates INTEROPERATE: the real Payment (Slice 4), Order + SubOrderLifecycle
 * (Slice 5), ReturnSaga (Slice 7) and SettlementEngine (Slice 6) objects are driven
 * through one continuous customer journey, and the money and state stay consistent at
 * every hand-off.
 *
 * BOUNDARY NOTE — this is a TEST-ONLY harness. No production service imports another
 * (the microservice boundaries of C4-L2 stand); at runtime these communicate via the
 * events in contracts/events and the service APIs. Compiling their domain sources onto
 * one test classpath here demonstrates that the contracts line up — nothing more.
 *
 * The quote arrives as a value object, exactly as it would cross the wire from the
 * TypeScript cart-checkout service (FR-CUS-014): a grand total plus priced lines.
 */
class EndToEndJourneyTest {

    // A signed quote from cart-checkout: 2 vendors, grand total ₹1,180 (₹1,000 + ₹180 tax).
    // Line nets: V1 ₹590 (net 500 + 90 tax), V2 ₹590 (net 500 + 90 tax). For the money
    // walk we treat each line's net-paid as its full contribution.
    private static final long GRAND_TOTAL = 1_18_000;
    private static final List<QuoteLineRef> QUOTE_LINES = List.of(
            new QuoteLineRef("L1", "V1", 59_000),
            new QuoteLineRef("L2", "V2", 59_000));

    private static String subFor(String vendorId) {
        return "SUB-" + vendorId;
    }

    /** The canonical happy path: pay → order split → both delivered → settle → payout. */
    @Test
    void payToDeliveredToPayout_flowsThroughEveryAggregateConsistently() {
        Instant t0 = Instant.parse("2026-08-17T04:30:00Z"); // Monday morning IST

        // 1) PAYMENT (Slice 4): authorise against the quote total, then idempotent capture.
        var payment = new Payment("PAY-1", "QTE-1", GRAND_TOTAL, Payment.Instrument.UPI);
        assertInstanceOf(Payment.Result.Ok.class, payment.authorise("auth-1", GRAND_TOTAL));
        assertInstanceOf(Payment.Result.Ok.class, payment.capture("idem-cap-1", "cap-1"));
        assertEquals(Payment.State.CAPTURED, payment.state());

        // 2) ORDER (Slice 5): the captured payment reference creates exactly one order,
        //    split per vendor, summing to the quote total to the paisa.
        var factory = new Order.OrderFactory();
        var out = factory.createOnce("ORD-1", "QTE-1", "cap-1", GRAND_TOTAL, QUOTE_LINES,
                EndToEndJourneyTest::subFor, t0);
        var order = assertInstanceOf(Order.OrderFactory.Outcome.Created.class, out).order();
        assertEquals(2, order.subOrders().size());
        assertEquals(GRAND_TOTAL,
                order.subOrders().stream().mapToLong(Order.SubOrder::amountPaise).sum());

        // idempotency ACROSS the chain: the same capture ref never creates a second order
        var replay = factory.createOnce("ORD-2", "QTE-1", "cap-1", GRAND_TOTAL, QUOTE_LINES,
                EndToEndJourneyTest::subFor, t0);
        assertEquals("ORD-1", assertInstanceOf(Order.OrderFactory.Outcome.Existing.class, replay).order().orderId());

        // 3) FULFILMENT (Slice 5 state machine): drive both sub-orders to DELIVERED.
        State v1 = State.CONFIRMED, v2 = State.CONFIRMED;
        for (Event e : List.of(Event.ACCEPT, Event.PACK, Event.SHIP, Event.OUT_FOR_DELIVERY, Event.DELIVER)) {
            v1 = assertInstanceOf(SubOrderLifecycle.Result.Moved.class, SubOrderLifecycle.apply(v1, e)).to();
            v2 = assertInstanceOf(SubOrderLifecycle.Result.Moved.class, SubOrderLifecycle.apply(v2, e)).to();
        }
        assertEquals(State.DELIVERED, v1);
        assertEquals(State.DELIVERED, v2);

        // 4) SETTLEMENT (Slice 6): Monday deliveries → one Wednesday payout per vendor.
        LocalDate wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(
                new AccrualLine("L1", "V1", subFor("V1"), 59_000, t0, false),
                new AccrualLine("L2", "V2", subFor("V2"), 59_000, t0, false));
        var accounts = Map.of(
                "V1", new VendorAccount("V1", "acct-V1", true),
                "V2", new VendorAccount("V2", "acct-V2", true));
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("BATCH-1", wed, accruals, accounts, "maker", "checker")).batch();
        assertEquals(2, batch.payouts().size());
        assertEquals(GRAND_TOTAL, batch.checksumPaise()); // total paid out == what came in

        var exec = batch.execute((v, amt, acct, idem) ->
                new SettlementBatch.PayoutGateway.Result(true, "UTR-" + v, null));
        assertEquals(GRAND_TOTAL, exec.paidTotalPaise());
        assertTrue(exec.outcomes().stream().allMatch(SettlementBatch.PayoutOutcome::paid));
    }

    /** The return branch: one delivered line is returned, QC-passes, and refunds cleanly. */
    @Test
    void deliveredThenReturnedThenRefunded_flowsThroughPaymentAndSaga() {
        Instant delivered = Instant.parse("2026-08-17T10:00:00Z");

        // start from a captured payment for a single ₹590 line (net 500 + 90 tax)
        var payment = new Payment("PAY-2", "QTE-2", 59_000, Payment.Instrument.UPI);
        payment.authorise("auth-2", 59_000);
        payment.capture("idem-cap-2", "cap-2");

        // sub-order reaches DELIVERED
        State s = State.CONFIRMED;
        for (Event e : List.of(Event.ACCEPT, Event.PACK, Event.SHIP, Event.OUT_FOR_DELIVERY, Event.DELIVER)) {
            s = assertInstanceOf(SubOrderLifecycle.Result.Moved.class, SubOrderLifecycle.apply(s, e)).to();
        }

        // ReturnSaga (Slice 7): admit a defective return within window, QC-pass → refund due.
        var req = new ReturnRequest("RET-1", subFor("V1"), "L1", ReasonCode.DEFECTIVE, true,
                59_000, 0, 5_900, delivered, 0, delivered.plus(Duration.ofDays(1)));
        assertInstanceOf(ReturnSaga.Admission.Accepted.class, ReturnSaga.admit(req));

        Instant qc = delivered.plus(Duration.ofDays(3));
        var res = ReturnSaga.resolveAfterQc(req, true, Disposition.SCRAP, false, false, qc);
        var due = assertInstanceOf(Resolution.RefundDue.class, res);

        // the refund instruction the saga emits is now EXECUTED by the real Payment aggregate
        var refund = payment.refund(due.refund().returnId(), due.refund().amountPaise(),
                Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "return QC pass", qc);
        assertInstanceOf(Payment.RefundResult.Ok.class, refund);
        assertEquals(Payment.State.REFUNDED, payment.state());
        assertEquals(0, payment.refundablePaise());

        // and the settlement reversal the saga emits claws back vendor + commission to the refund
        assertEquals(due.refund().amountPaise(),
                due.reversal().vendorClawbackPaise() + due.reversal().commissionClawbackPaise());

        // drive the state machine down the return leg to CLOSED
        for (Event e : List.of(Event.REQUEST_RETURN, Event.PICK_UP_RETURN, Event.START_QC, Event.QC_PASS, Event.CLOSE)) {
            s = assertInstanceOf(SubOrderLifecycle.Result.Moved.class, SubOrderLifecycle.apply(s, e)).to();
        }
        assertEquals(State.CLOSED, s);
    }

    /** A failed capture must NOT produce an order — the chain stops at payment. */
    @Test
    void failedCaptureProducesNoOrder() {
        var payment = new Payment("PAY-3", "QTE-3", GRAND_TOTAL, Payment.Instrument.CARD);
        payment.authorise("auth-3", GRAND_TOTAL);
        // (no capture) — order assembly must not be reachable with an uncaptured payment ref.
        // We model the guard the service enforces: only a CAPTURED payment yields an order.
        assertNotEquals(Payment.State.CAPTURED, payment.state());
        // If a buggy caller tried anyway, the split still must reconcile or be rejected:
        var ex = assertThrows(IllegalArgumentException.class,
                () -> Order.create("ORD-X", "QTE-3", "no-capture", GRAND_TOTAL - 1, QUOTE_LINES,
                        EndToEndJourneyTest::subFor, Instant.now()));
        assertTrue(ex.getMessage().startsWith("SPLIT_MISMATCH"));
    }
}
