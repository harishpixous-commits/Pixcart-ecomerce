package com.pixous.pixcart.order.domain.returns;

import com.pixous.pixcart.order.domain.SubOrderLifecycle;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.Event;
import com.pixous.pixcart.order.domain.SubOrderLifecycle.State;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.Admission;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.Disposition;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.ReasonCode;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.Resolution;
import com.pixous.pixcart.order.domain.returns.ReturnSaga.ReturnRequest;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-CUS-017/018, BRU-06/07, FR-LOG-005 as tests. Also proves the saga's money is
 * consistent with the Slice-4 capture split (refund + clawbacks reconcile) and that its
 * state path is legal under the Slice-5 SubOrderLifecycle.
 */
class ReturnSagaTest {

    private static final Instant DELIVERED = Instant.parse("2026-08-15T10:00:00Z");

    private static ReturnRequest req(ReasonCode reason, boolean photo, int windowDays, Instant requestedAt) {
        // line: net paid ₹900 = ₹1000 list − ₹100 promo; commission booked ₹90.
        return new ReturnRequest("RET-1", "SUB-1", "L1", reason, photo,
                90_000, 10_000, 9_000, DELIVERED, windowDays, requestedAt);
    }

    // ---------------------------------------------------- BRU-07 admission

    @Test
    void withinDefaultSevenDayWindowIsAccepted() {
        var r = req(ReasonCode.SIZE_FIT, false, 0, DELIVERED.plus(Duration.ofDays(7)));
        assertInstanceOf(Admission.Accepted.class, ReturnSaga.admit(r));
    }

    @Test
    void afterWindowIsRefused() {
        var r = req(ReasonCode.SIZE_FIT, false, 0, DELIVERED.plus(Duration.ofDays(7)).plusMillis(1));
        var refused = assertInstanceOf(Admission.Refused.class, ReturnSaga.admit(r));
        assertEquals("RETURN_WINDOW_EXPIRED", refused.reason());
    }

    @Test
    void categoryWindowOverridesDefault() {
        var three = req(ReasonCode.CHANGED_MIND, false, 3, DELIVERED.plus(Duration.ofDays(4)));
        assertInstanceOf(Admission.Refused.class, ReturnSaga.admit(three));   // 4 > 3-day window
        var ten = req(ReasonCode.CHANGED_MIND, false, 10, DELIVERED.plus(Duration.ofDays(9)));
        assertInstanceOf(Admission.Accepted.class, ReturnSaga.admit(ten));
    }

    @Test
    void nonReturnableCategoryIsRefused_bru07() {
        var r = req(ReasonCode.CHANGED_MIND, false, -1, DELIVERED.plus(Duration.ofDays(1)));
        var refused = assertInstanceOf(Admission.Refused.class, ReturnSaga.admit(r));
        assertEquals("NON_RETURNABLE_CATEGORY", refused.reason());
    }

    @Test
    void damageAndWrongItemNeedPhotoEvidence_frCus017() {
        for (ReasonCode reason : new ReasonCode[]{ReasonCode.DAMAGED, ReasonCode.WRONG_ITEM}) {
            var noPhoto = req(reason, false, 0, DELIVERED.plus(Duration.ofDays(1)));
            var refused = assertInstanceOf(Admission.Refused.class, ReturnSaga.admit(noPhoto));
            assertTrue(refused.reason().startsWith("PHOTO_EVIDENCE_REQUIRED"));
            var withPhoto = req(reason, true, 0, DELIVERED.plus(Duration.ofDays(1)));
            assertInstanceOf(Admission.Accepted.class, ReturnSaga.admit(withPhoto));
        }
    }

    @Test
    void changedMindNeedsNoEvidence() {
        var r = req(ReasonCode.CHANGED_MIND, false, 0, DELIVERED.plus(Duration.ofDays(2)));
        assertInstanceOf(Admission.Accepted.class, ReturnSaga.admit(r));
    }

    // ------------------------------------------------- QC resolution & money

    @Test
    void qcPassRefundsNetToOriginalInstrumentWithin24h_frCus018() {
        var r = req(ReasonCode.DEFECTIVE, true, 0, DELIVERED.plus(Duration.ofDays(1)));
        Instant qc = DELIVERED.plus(Duration.ofDays(3));
        var res = ReturnSaga.resolveAfterQc(r, true, Disposition.SCRAP, false, false, qc);
        var due = assertInstanceOf(Resolution.RefundDue.class, res);

        assertEquals(90_000, due.refund().amountPaise());        // the NET paid, not the list price
        assertFalse(due.refund().toWallet());                    // BRU-06 default = original instrument
        assertEquals(qc.plus(ReturnSaga.QC_PASS_REFUND_SLA), due.refund().mustInitiateBy()); // ≤24 h
    }

    @Test
    void refundPlusClawbacksReconcileToTheCaptureSplit() {
        // Capture split (Slice 4): net 90,000 = vendor payable 81,000 + commission 9,000.
        var r = req(ReasonCode.DEFECTIVE, true, 0, DELIVERED.plus(Duration.ofDays(1)));
        var due = assertInstanceOf(Resolution.RefundDue.class,
                ReturnSaga.resolveAfterQc(r, true, Disposition.RESTOCK, false, false,
                        DELIVERED.plus(Duration.ofDays(2))));
        long vendorClawback = due.reversal().vendorClawbackPaise();
        long commissionClawback = due.reversal().commissionClawbackPaise();
        // the two clawbacks sum EXACTLY to the customer refund → the reversal journal balances
        assertEquals(due.refund().amountPaise(), vendorClawback + commissionClawback);
        assertEquals(81_000, vendorClawback);
        assertEquals(9_000, commissionClawback);
    }

    @Test
    void qcFailIsRejectedNoRefund() {
        var r = req(ReasonCode.DAMAGED, true, 0, DELIVERED.plus(Duration.ofDays(1)));
        var res = ReturnSaga.resolveAfterQc(r, false, Disposition.SCRAP, false, false,
                DELIVERED.plus(Duration.ofDays(3)));
        assertInstanceOf(Resolution.Rejected.class, res);
    }

    @Test
    void walletRefundRequiresConsent_bru06() {
        var r = req(ReasonCode.SIZE_FIT, false, 0, DELIVERED.plus(Duration.ofDays(1)));
        Instant qc = DELIVERED.plus(Duration.ofDays(2));
        var refused = ReturnSaga.resolveAfterQc(r, true, Disposition.RESTOCK, true, false, qc);
        assertInstanceOf(Resolution.Rejected.class, refused);
        var ok = ReturnSaga.resolveAfterQc(r, true, Disposition.RESTOCK, true, true, qc);
        var due = assertInstanceOf(Resolution.RefundDue.class, ok);
        assertTrue(due.refund().toWallet());
        assertTrue(due.refund().walletConsent());
    }

    // ------------------------------------- integration with the state machine

    @Test
    void sagaStatePathIsLegalUnderSubOrderLifecycle() {
        // DELIVERED → RETURN_REQUESTED → RETURN_PICKED_UP → QC → REFUNDED → CLOSED
        State s = State.DELIVERED;
        for (Event e : new Event[]{Event.REQUEST_RETURN, Event.PICK_UP_RETURN, Event.START_QC,
                Event.QC_PASS, Event.CLOSE}) {
            s = assertInstanceOf(SubOrderLifecycle.Result.Moved.class,
                    SubOrderLifecycle.apply(s, e)).to();
        }
        assertEquals(State.CLOSED, s);
    }

    @Test
    void qcFailStatePathLeadsToReturnRejected() {
        State s = State.QC;
        s = assertInstanceOf(SubOrderLifecycle.Result.Moved.class,
                SubOrderLifecycle.apply(s, Event.QC_FAIL)).to();
        assertEquals(State.RETURN_REJECTED, s);
        assertEquals(ReturnSaga.returnLegStates().get(0), "DELIVERED");
    }
}
