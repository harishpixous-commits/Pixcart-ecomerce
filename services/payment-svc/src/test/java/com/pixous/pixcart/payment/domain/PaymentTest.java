package com.pixous.pixcart.payment.domain;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Payment lifecycle acceptance (FR-CUS-014 idempotency, BRU-06 refund destination,
 * FR-FIN-005/006) and ledger balance (Vol.6 DDL-03 invariant). Money in integer paise.
 */
class PaymentTest {

    private static final Instant NOW = Instant.parse("2026-08-15T10:00:00Z");

    private static Payment authorised(long amt, Payment.Instrument inst) {
        var p = new Payment("01PAY0", "01QTE0", amt, inst);
        assertInstanceOf(Payment.Result.Ok.class, p.authorise("auth-ref-1", amt));
        return p;
    }

    private static Payment captured(long amt, Payment.Instrument inst) {
        var p = authorised(amt, inst);
        assertInstanceOf(Payment.Result.Ok.class, p.capture("cap-key-1", "cap-ref-1"));
        return p;
    }

    @Test
    void authoriseRequiresQuoteAmountToMatchToThePaisa() {
        var p = new Payment("01PAY0", "01QTE0", 199_900, Payment.Instrument.UPI);
        var bad = p.authorise("ref", 199_901);
        assertInstanceOf(Payment.Result.Rejected.class, bad);
        assertTrue(((Payment.Result.Rejected) bad).reason().startsWith("AMOUNT_MISMATCH"));
        assertEquals(Payment.State.CREATED, p.state());
    }

    @Test
    void captureIsIdempotentOnKey_exactlyOnce_frCus014() {
        var p = authorised(199_900, Payment.Instrument.UPI);
        var first = p.capture("idem-A", "cap-ref-1");
        assertInstanceOf(Payment.Result.Ok.class, first);
        assertEquals(Payment.State.CAPTURED, p.state());

        // same key replayed → idempotent, no state change, no second capture
        var replay = p.capture("idem-A", "cap-ref-1");
        assertInstanceOf(Payment.Result.Idempotent.class, replay);
        assertEquals(Payment.State.CAPTURED, p.state());

        // a DIFFERENT key on an already-captured payment is rejected (double-charge guard)
        var second = p.capture("idem-B", "cap-ref-2");
        assertInstanceOf(Payment.Result.Rejected.class, second);
    }

    @Test
    void cannotCaptureWithoutAuthorisation() {
        var p = new Payment("01PAY0", "01QTE0", 5_000, Payment.Instrument.CARD);
        assertInstanceOf(Payment.Result.Rejected.class, p.capture("k", "r"));
    }

    @Test
    void voidOnlyFromAuthorised() {
        var p = authorised(5_000, Payment.Instrument.CARD);
        assertInstanceOf(Payment.Result.Ok.class, p.voidAuthorisation());
        assertEquals(Payment.State.VOIDED, p.state());
        assertInstanceOf(Payment.Result.Idempotent.class, p.voidAuthorisation());
        // cannot capture a voided auth
        assertInstanceOf(Payment.Result.Rejected.class, p.capture("k", "r"));
    }

    @Test
    void refundDefaultsToOriginalInstrument_bru06() {
        var p = captured(100_000, Payment.Instrument.UPI);
        var r = p.refund("rk-1", 100_000, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "return", NOW);
        var ok = assertInstanceOf(Payment.RefundResult.Ok.class, r);
        assertEquals(Payment.RefundDestination.ORIGINAL_INSTRUMENT, ok.refund().destination());
        assertEquals(Payment.State.REFUNDED, p.state());
        assertEquals(0, p.refundablePaise());
    }

    @Test
    void walletRefundRequiresConsent_bru06() {
        var p = captured(100_000, Payment.Instrument.UPI);
        var refused = p.refund("rk-1", 50_000, Payment.RefundDestination.WALLET, false, "goodwill", NOW);
        var rej = assertInstanceOf(Payment.RefundResult.Rejected.class, refused);
        assertTrue(rej.reason().contains("CONSENT"));
        // with consent it proceeds
        var ok = p.refund("rk-2", 50_000, Payment.RefundDestination.WALLET, true, "goodwill", NOW);
        assertInstanceOf(Payment.RefundResult.Ok.class, ok);
        assertEquals(Payment.State.PARTIALLY_REFUNDED, p.state());
    }

    @Test
    void codRefundCannotUseOriginalInstrument() {
        var p = captured(50_000, Payment.Instrument.COD);
        var refused = p.refund("rk-1", 50_000, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "return", NOW);
        assertInstanceOf(Payment.RefundResult.Rejected.class, refused);
        // COD refunds route to wallet with consent
        var ok = p.refund("rk-2", 50_000, Payment.RefundDestination.WALLET, true, "return", NOW);
        assertInstanceOf(Payment.RefundResult.Ok.class, ok);
    }

    @Test
    void partialRefundsAccumulateAndCannotExceedCaptured() {
        var p = captured(100_000, Payment.Instrument.UPI);
        assertInstanceOf(Payment.RefundResult.Ok.class,
                p.refund("rk-1", 30_000, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "partial", NOW));
        assertEquals(Payment.State.PARTIALLY_REFUNDED, p.state());
        assertEquals(70_000, p.refundablePaise());

        // overshoot rejected
        var over = p.refund("rk-2", 70_001, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "x", NOW);
        var rej = assertInstanceOf(Payment.RefundResult.Rejected.class, over);
        assertTrue(rej.reason().startsWith("REFUND_EXCEEDS_CAPTURED"));

        // exact remainder settles to REFUNDED
        assertInstanceOf(Payment.RefundResult.Ok.class,
                p.refund("rk-3", 70_000, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "rest", NOW));
        assertEquals(Payment.State.REFUNDED, p.state());
    }

    @Test
    void refundIsIdempotentOnKey() {
        var p = captured(100_000, Payment.Instrument.UPI);
        var first = p.refund("rk-DUP", 40_000, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "r", NOW);
        var again = p.refund("rk-DUP", 40_000, Payment.RefundDestination.ORIGINAL_INSTRUMENT, false, "r", NOW);
        assertInstanceOf(Payment.RefundResult.Ok.class, first);
        assertInstanceOf(Payment.RefundResult.Idempotent.class, again);
        assertEquals(40_000, p.refundedPaise(), "the duplicate must not refund twice");
    }

    // ------------------------------------------------------------- ledger

    @Test
    void captureJournalBalancesAndSplitsCommission() {
        var j = PaymentLedger.captureJournal("01JRN0", "01EVT0", "01SUB0", 90_000, 10_000);
        assertEquals(100_000, j.total());
        long debit = j.legs().stream().mapToLong(PaymentLedger.Leg::debitPaise).sum();
        long credit = j.legs().stream().mapToLong(PaymentLedger.Leg::creditPaise).sum();
        assertEquals(debit, credit, "capture journal must balance (Vol.6 invariant)");
    }

    @Test
    void refundJournalBalances() {
        var j = PaymentLedger.refundJournal("01JRN1", "01EVT1", "01SUB0", 45_000, 5_000);
        assertEquals(50_000, j.total());
        assertEquals(
                j.legs().stream().mapToLong(PaymentLedger.Leg::debitPaise).sum(),
                j.legs().stream().mapToLong(PaymentLedger.Leg::creditPaise).sum());
    }

    @Test
    void aLegWithBothOrNeitherSidesIsRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> new PaymentLedger.Leg("X", 10, 10, "T", "R"));     // both
        assertThrows(IllegalArgumentException.class,
                () -> new PaymentLedger.Leg("X", 0, 0, "T", "R"));       // neither
    }

    @Test
    void anUnbalancedJournalCannotBeConstructed() {
        var legs = java.util.List.of(
                new PaymentLedger.Leg("GATEWAY_CLEARING", 100_000, 0, "SUB_ORDER", "01SUB0"),
                new PaymentLedger.Leg("VENDOR_PAYABLE", 0, 90_000, "SUB_ORDER", "01SUB0")); // 10k short
        assertThrows(IllegalArgumentException.class, () -> new PaymentLedger.Journal("J", "E", legs));
    }
}
