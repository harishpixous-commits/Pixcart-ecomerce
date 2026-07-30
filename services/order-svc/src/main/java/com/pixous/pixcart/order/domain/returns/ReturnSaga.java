package com.pixous.pixcart.order.domain.returns;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Returns & refund orchestration — the saga that runs a return from request to money.
 *
 * Normative sources (Documentation Suite v1.0):
 *   FR-CUS-017:  return/replacement within the category window, reason codes, photo
 *                evidence for damage/wrong-item, reverse-pickup, QC-driven resolution.
 *   FR-CUS-018:  refund to original instrument (default) / wallet (consented); triggered
 *                by cancellation, returns-QC-pass, or adjustment; visible status + SLA.
 *   FR-CUS-018 rules:  "QC-pass ≤ 24 h" refund-initiation SLA; BRU-06 destination;
 *                       "partial refunds itemised on the credit note."
 *   FR-LOG-005:  reverse pickup, QC checklist at receipt, disposition, refund linkage.
 *   BRU-06:      original instrument by default; wallet only with explicit consent.
 *   BRU-07:      return window category-configurable (default 7 days from delivery);
 *                non-returnable categories flagged pre-purchase.
 *
 * This saga sits over three already-built, tested pieces and coordinates them:
 *   - SubOrderLifecycle (Slice 5) — the return-leg states are the only legal moves;
 *   - Payment.refund (Slice 4) — executes the money movement under BRU-06;
 *   - the promotion allocation map (Slice 0) — gives the exact discount to claw back so
 *     the refund is on the NET the customer paid, and the settlement reversal matches.
 *
 * Pure and deterministic: clocks arrive as Instants, money as integer paise. It emits a
 * RefundInstruction (what the Payment aggregate must do) and a SettlementReversal (what
 * the ledger must post) rather than performing I/O itself.
 */
public final class ReturnSaga {

    /** QC-pass refund must be INITIATED within this SLA (FR-CUS-018 rules). */
    public static final Duration QC_PASS_REFUND_SLA = Duration.ofHours(24);
    /** Default return window when the category does not override it (BRU-07). */
    public static final int DEFAULT_RETURN_WINDOW_DAYS = 7;

    public enum ReasonCode { DAMAGED, WRONG_ITEM, NOT_AS_DESCRIBED, SIZE_FIT, CHANGED_MIND, DEFECTIVE }

    public enum Disposition { RESTOCK, REFURB, SCRAP }   // FR-LOG-005 QC disposition

    /** A return request against one delivered order line. */
    public record ReturnRequest(
            String returnId,
            String subOrderId,
            String lineId,
            ReasonCode reason,
            boolean hasPhotoEvidence,       // required for DAMAGED / WRONG_ITEM (FR-CUS-017)
            long lineNetPaidPaise,          // what the customer actually paid for this line (net)
            long lineDiscountAllocatedPaise,// promo allocated to this line (Slice-0 map)
            long commissionOnLinePaise,     // platform commission booked on this line
            Instant deliveredAt,
            int categoryReturnWindowDays,   // 0 ⇒ use default; negative ⇒ non-returnable
            Instant requestedAt) {
    }

    /** Non-returnable / window-expired / evidence-missing requests are refused up front. */
    public sealed interface Admission {
        record Accepted() implements Admission {}
        record Refused(String reason) implements Admission {}
    }

    /** Outcome of QC → money. On pass: a refund + a settlement reversal; on fail: reject. */
    public sealed interface Resolution {
        record RefundDue(RefundInstruction refund, SettlementReversal reversal) implements Resolution {}
        record Rejected(String reason) implements Resolution {}
    }

    /** What Payment.refund must execute (BRU-06 destination carried through). */
    public record RefundInstruction(String returnId, String subOrderId, String lineId,
                                    long amountPaise, boolean toWallet, boolean walletConsent,
                                    Instant mustInitiateBy) {}

    /** What the ledger must post to reverse the vendor payable + platform commission. */
    public record SettlementReversal(String subOrderId, long vendorClawbackPaise,
                                     long commissionClawbackPaise) {}

    private ReturnSaga() {
    }

    /**
     * FR-CUS-017 / BRU-07 admission. A request is accepted only if the category is
     * returnable, it is within the window, and damage/wrong-item claims carry photo
     * evidence. The window is inclusive of the last day.
     */
    public static Admission admit(ReturnRequest r) {
        if (r.categoryReturnWindowDays() < 0) {
            return new Admission.Refused("NON_RETURNABLE_CATEGORY");
        }
        int windowDays = r.categoryReturnWindowDays() == 0
                ? DEFAULT_RETURN_WINDOW_DAYS : r.categoryReturnWindowDays();
        Instant deadline = r.deliveredAt().plus(Duration.ofDays(windowDays));
        if (r.requestedAt().isAfter(deadline)) {
            return new Admission.Refused("RETURN_WINDOW_EXPIRED");
        }
        boolean evidenceRequired = r.reason() == ReasonCode.DAMAGED || r.reason() == ReasonCode.WRONG_ITEM;
        if (evidenceRequired && !r.hasPhotoEvidence()) {
            return new Admission.Refused("PHOTO_EVIDENCE_REQUIRED for " + r.reason());
        }
        return new Admission.Accepted();
    }

    /**
     * Resolve a return after QC (FR-LOG-005 / FR-CUS-018). QC-pass produces a refund of the
     * exact NET the customer paid for the line, routed per BRU-06, with the ≤24 h
     * initiation deadline set from the QC time; and a settlement reversal that claws back
     * the vendor payable and platform commission for that line so the books stay balanced.
     * QC-fail rejects with the recorded reason (dispute path noted downstream).
     *
     * @param toWallet       true if the customer chose wallet credit
     * @param walletConsent  explicit consent flag (BRU-06); wallet refund without it is rejected
     */
    public static Resolution resolveAfterQc(ReturnRequest r, boolean qcPassed, Disposition disposition,
                                            boolean toWallet, boolean walletConsent, Instant qcCompletedAt) {
        if (!qcPassed) {
            return new Resolution.Rejected("QC_FAILED disposition=" + disposition);
        }
        if (toWallet && !walletConsent) {
            return new Resolution.Rejected("WALLET_REFUND_NEEDS_CONSENT (BRU-06)");
        }
        long refundAmount = r.lineNetPaidPaise();                 // refund the net actually paid
        long vendorClawback = r.lineNetPaidPaise() - r.commissionOnLinePaise();
        // commission clawback is the commission booked on the line; the two sum to the net,
        // so the reversal journal balances against the original capture split.
        long commissionClawback = r.commissionOnLinePaise();

        var refund = new RefundInstruction(
                r.returnId(), r.subOrderId(), r.lineId(), refundAmount,
                toWallet, walletConsent, qcCompletedAt.plus(QC_PASS_REFUND_SLA));
        var reversal = new SettlementReversal(r.subOrderId(), vendorClawback, commissionClawback);
        return new Resolution.RefundDue(refund, reversal);
    }

    /**
     * The legal state path this saga drives on the sub-order (checked against
     * SubOrderLifecycle in tests): a convenience list for the service layer.
     */
    public static List<String> returnLegStates() {
        return List.of("DELIVERED", "RETURN_REQUESTED", "RETURN_PICKED_UP", "QC",
                "REFUNDED", "RETURN_REJECTED", "CLOSED");
    }
}
