package com.pixous.pixcart.payment.domain;

import java.util.ArrayList;
import java.util.List;

/**
 * Payment boundary + the ledger postings a payment lifecycle produces.
 *
 * {@link PaymentGatewayPort} is the hexagonal boundary the Razorpay / Cashfree / PhonePe
 * adapters implement (FR-CUS-014, FR-FIN-004 payout side later). The aggregate never
 * imports a vendor SDK.
 *
 * {@link LedgerPosting} builds double-entry journals for finance events (Vol.6 DDL-03
 * fin_ledger_entry). Every journal MUST balance — Σdebit == Σcredit — which is the exact
 * invariant already proven on the live database in V001 (the "balanced-journal" query
 * returns zero rows). Building the journal here, balanced by construction, means the
 * posting can never violate that invariant downstream. Amounts are integer paise.
 */
public final class PaymentLedger {

    private PaymentLedger() {
    }

    /** Gateway operations the aggregate delegates to; adapters supply real implementations. */
    public interface PaymentGatewayPort {
        AuthResult authorise(String paymentId, long amountPaise, Payment.Instrument instrument);
        CaptureResult capture(String authRef, long amountPaise, String idempotencyKey);
        RefundResult refund(String captureRef, long amountPaise, String idempotencyKey);
        void voidAuthorisation(String authRef);

        record AuthResult(boolean ok, String authRef, String failureReason) {}
        record CaptureResult(boolean ok, String captureRef, String failureReason) {}
        record RefundResult(boolean ok, String refundRef, String failureReason) {}
    }

    /** One leg of a double-entry journal. Exactly one of debit/credit is non-zero. */
    public record Leg(String accountCode, long debitPaise, long creditPaise, String refType, String refId) {
        public Leg {
            if ((debitPaise == 0) == (creditPaise == 0)) {
                throw new IllegalArgumentException("exactly one of debit/credit must be non-zero (ck_ledger_oneside)");
            }
            if (debitPaise < 0 || creditPaise < 0) throw new IllegalArgumentException("no negative legs");
        }
    }

    public record Journal(String journalId, String eventId, List<Leg> legs) {
        public Journal {
            long d = legs.stream().mapToLong(Leg::debitPaise).sum();
            long c = legs.stream().mapToLong(Leg::creditPaise).sum();
            if (d != c) throw new IllegalArgumentException("journal does not balance: debit " + d + " != credit " + c);
            if (legs.size() < 2) throw new IllegalArgumentException("a journal needs at least two legs");
            legs = List.copyOf(legs);
        }

        public long total() {
            return legs.stream().mapToLong(Leg::debitPaise).sum();
        }
    }

    /**
     * Capture posting: money enters the platform's gateway-clearing account and becomes a
     * payable to the vendor(s) plus platform commission (BRU-08). Splitting commission vs
     * payable per sub-order is FR-FIN-001's job; here we accept the already-computed split
     * and assemble a balanced journal.
     *
     * @param vendorPayable  paise owed to the vendor (net of commission)
     * @param commission     platform commission + fees (BRU-08)
     */
    public static Journal captureJournal(String journalId, String eventId, String subOrderId,
                                         long vendorPayable, long commission) {
        long gross = vendorPayable + commission;
        var legs = new ArrayList<Leg>(3);
        legs.add(new Leg("GATEWAY_CLEARING", gross, 0, "SUB_ORDER", subOrderId));      // debit: cash in
        legs.add(new Leg("VENDOR_PAYABLE", 0, vendorPayable, "SUB_ORDER", subOrderId)); // credit: owed to vendor
        legs.add(new Leg("PLATFORM_COMMISSION", 0, commission, "SUB_ORDER", subOrderId)); // credit: our revenue
        return new Journal(journalId, eventId, legs);
    }

    /**
     * Refund posting: reverse a portion. Vendor payable and platform commission are
     * clawed back pro-rata (FR-FIN-001 promo/commission reversal), returning cash out of
     * gateway clearing. The caller supplies the pro-rata split so rounding is decided once
     * (largest-remainder, upstream) and the journal stays balanced.
     */
    public static Journal refundJournal(String journalId, String eventId, String subOrderId,
                                        long vendorClawback, long commissionClawback) {
        long gross = vendorClawback + commissionClawback;
        var legs = new ArrayList<Leg>(3);
        legs.add(new Leg("VENDOR_PAYABLE", vendorClawback, 0, "REFUND", subOrderId));       // debit: reduce payable
        legs.add(new Leg("PLATFORM_COMMISSION", commissionClawback, 0, "REFUND", subOrderId)); // debit: reverse revenue
        legs.add(new Leg("GATEWAY_CLEARING", 0, gross, "REFUND", subOrderId));              // credit: cash out
        return new Journal(journalId, eventId, legs);
    }
}
