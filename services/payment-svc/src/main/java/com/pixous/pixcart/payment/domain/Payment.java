package com.pixous.pixcart.payment.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Payment aggregate — the gateway-agnostic money state machine.
 *
 * Normative sources (Documentation Suite v1.0):
 *   FR-CUS-014 acceptance:  "When gateway capture succeeds, Then exactly one order is
 *                            created (idempotent on payment reference) matching the quote
 *                            to the paisa."
 *   FR-FIN-005/006:         payment records, refunds (auto+manual), instrument handling.
 *   BRU-06:                 "Refunds return to the original instrument by default; wallet
 *                            credit only with explicit customer consent."
 *   Vol.6 pay_payment:      uq_pay_idem (idempotency_key) — capture/refund are keyed.
 *   Vol.5 UML-STM (payment): CREATED → AUTHORISED → CAPTURED → (PARTIALLY_)REFUNDED;
 *                            AUTHORISED → VOIDED; capture/auth FAILED terminal.
 *
 * This aggregate is pure and gateway-neutral: a PaymentGatewayPort (authorise/capture/
 * refund/void) is the boundary; Razorpay/Cashfree/PhonePe adapters implement it later.
 * Idempotency is intrinsic — replaying a capture or refund with the same key returns the
 * prior result and never moves money twice. All amounts are integer paise (FR-FIN-001).
 */
public final class Payment {

    public enum State { CREATED, AUTHORISED, CAPTURED, PARTIALLY_REFUNDED, REFUNDED, VOIDED, FAILED }

    public enum Instrument { UPI, CARD, NETBANKING, WALLET, COD }

    /** BRU-06 refund destination. WALLET requires explicit consent (enforced below). */
    public enum RefundDestination { ORIGINAL_INSTRUMENT, WALLET }

    public record Refund(String refundId, long amountPaise, RefundDestination destination,
                         String reason, Instant at) {}

    public sealed interface Result {
        record Ok(State state) implements Result {}
        record Idempotent(State state, String note) implements Result {}
        record Rejected(String reason) implements Result {}
    }

    public sealed interface RefundResult {
        record Ok(Refund refund, State state) implements RefundResult {}
        record Idempotent(Refund refund, State state) implements RefundResult {}
        record Rejected(String reason) implements RefundResult {}
    }

    private final String paymentId;
    private final String quoteId;
    private final long amountPaise;          // must equal quote grand total (checked at authorise)
    private final Instrument instrument;

    private State state = State.CREATED;
    private String authRef;                  // gateway auth reference
    private String captureIdemKey;           // FR-CUS-014 idempotency key for capture
    private String captureRef;
    private long refundedPaise = 0;
    private final List<Refund> refunds = new ArrayList<>();
    private final List<String> seenRefundKeys = new ArrayList<>();

    public Payment(String paymentId, String quoteId, long amountPaise, Instrument instrument) {
        if (paymentId == null || paymentId.isBlank()) throw new IllegalArgumentException("paymentId");
        if (quoteId == null || quoteId.isBlank()) throw new IllegalArgumentException("quoteId");
        if (amountPaise <= 0) throw new IllegalArgumentException("amountPaise must be positive");
        this.paymentId = paymentId;
        this.quoteId = quoteId;
        this.amountPaise = amountPaise;
        this.instrument = instrument;
    }

    /** Authorise against the quote. quoteAmount must match to the paisa (FR-CUS-014). */
    public Result authorise(String gatewayAuthRef, long quoteAmountPaise) {
        if (state == State.AUTHORISED && gatewayAuthRef.equals(authRef)) {
            return new Result.Idempotent(state, "already authorised with this ref");
        }
        if (state != State.CREATED) return new Result.Rejected("cannot authorise from " + state);
        if (quoteAmountPaise != amountPaise) {
            return new Result.Rejected("AMOUNT_MISMATCH: quote " + quoteAmountPaise + " != payment " + amountPaise);
        }
        this.authRef = gatewayAuthRef;
        this.state = State.AUTHORISED;
        return new Result.Ok(state);
    }

    public Result failAuthorisation(String reason) {
        if (state == State.FAILED) return new Result.Idempotent(state, "already failed");
        if (state != State.CREATED && state != State.AUTHORISED) {
            return new Result.Rejected("cannot fail from " + state);
        }
        this.state = State.FAILED;
        return new Result.Ok(state);
    }

    /**
     * Capture. Idempotent on the key (Vol.6 uq_pay_idem): the same key replayed returns
     * the original outcome and captures nothing further — this is what makes
     * "exactly one order per payment reference" (FR-CUS-014) true under retries.
     */
    public Result capture(String idempotencyKey, String gatewayCaptureRef) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return new Result.Rejected("idempotencyKey required");
        }
        if (captureIdemKey != null) {
            if (captureIdemKey.equals(idempotencyKey)) {
                return new Result.Idempotent(state, "capture already applied for this key");
            }
            return new Result.Rejected("DIFFERENT_IDEMPOTENCY_KEY on an already-captured payment");
        }
        if (state != State.AUTHORISED) return new Result.Rejected("cannot capture from " + state);
        this.captureIdemKey = idempotencyKey;
        this.captureRef = gatewayCaptureRef;
        this.state = State.CAPTURED;
        return new Result.Ok(state);
    }

    /** Void an authorisation before capture (AUTHORISED → VOIDED). */
    public Result voidAuthorisation() {
        if (state == State.VOIDED) return new Result.Idempotent(state, "already voided");
        if (state != State.AUTHORISED) return new Result.Rejected("cannot void from " + state);
        this.state = State.VOIDED;
        return new Result.Ok(state);
    }

    /**
     * Refund (full or partial). Idempotent on refundKey. BRU-06: destination defaults to
     * ORIGINAL_INSTRUMENT; WALLET is only allowed with explicit consent (walletConsent).
     * COD refunds cannot go to the original instrument (there was none) — they require a
     * wallet/bank destination, surfaced as a rejection for the caller to re-route.
     */
    public RefundResult refund(String refundKey, long refundPaise, RefundDestination destination,
                               boolean walletConsent, String reason, Instant at) {
        if (refundKey == null || refundKey.isBlank()) return new RefundResult.Rejected("refundKey required");
        int seen = seenRefundKeys.indexOf(refundKey);
        if (seen >= 0) return new RefundResult.Idempotent(refunds.get(seen), state);

        if (state != State.CAPTURED && state != State.PARTIALLY_REFUNDED) {
            return new RefundResult.Rejected("cannot refund from " + state);
        }
        if (refundPaise <= 0) return new RefundResult.Rejected("refund amount must be positive");
        if (refundedPaise + refundPaise > amountPaise) {
            return new RefundResult.Rejected(
                    "REFUND_EXCEEDS_CAPTURED: " + (refundedPaise + refundPaise) + " > " + amountPaise);
        }
        if (destination == RefundDestination.WALLET && !walletConsent) {
            return new RefundResult.Rejected("WALLET_REFUND_NEEDS_CONSENT (BRU-06)");
        }
        if (destination == RefundDestination.ORIGINAL_INSTRUMENT && instrument == Instrument.COD) {
            return new RefundResult.Rejected("COD_HAS_NO_ORIGINAL_INSTRUMENT: choose wallet/bank with consent");
        }

        var refund = new Refund(refundKey, refundPaise, destination, reason, at);
        refunds.add(refund);
        seenRefundKeys.add(refundKey);
        refundedPaise += refundPaise;
        this.state = (refundedPaise == amountPaise) ? State.REFUNDED : State.PARTIALLY_REFUNDED;
        return new RefundResult.Ok(refund, state);
    }

    public State state()            { return state; }
    public long amountPaise()       { return amountPaise; }
    public long refundedPaise()     { return refundedPaise; }
    public long refundablePaise()   { return amountPaise - refundedPaise; }
    public List<Refund> refunds()   { return List.copyOf(refunds); }
    public Instrument instrument()  { return instrument; }
    public String paymentId()       { return paymentId; }
    public String quoteId()         { return quoteId; }
}
