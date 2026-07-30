package com.pixous.pixcart.finance.domain;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Settlement engine — accrues vendor receivables from ledger events and batches T+2 payouts.
 *
 * Normative source: FR-FIN-004 (Settlement Engine & Vendor Payouts).
 *   DESC:        "accrue vendor receivables/payables on financial events, apply hold rules,
 *                 net fees/promos/recoveries, batch T+2 payouts through the gateway payout
 *                 API with maker-checker, and publish statements per cycle."
 *   RULES:       "BRU-09 timing; disputes freeze only disputed lines; failed payout retry
 *                 ×1 then hold with reason to vendor (FR-VEN-011)."
 *   ACCEPTANCE:  "Given Monday deliveries totalling ₹1,00,000 net for a vendor, When
 *                 Wednesday batch executes, Then one payout of exactly that amount posts
 *                 with UTR, and the statement's line ids trace each order event."
 *   VALIDATION:  "Batch total = Σ lines (checksum); payouts only to penny-drop-verified
 *                 accounts; maker ≠ checker (SoD)."
 *   BRU-09:      "Vendor payout hold: released T+2 after delivery confirmation or
 *                 return-window lapse for high-risk categories."
 *
 * Pure domain: ledger events arrive as facts (built by the Slice-4 PaymentLedger and
 * stored in fin_ledger_entry); the gateway payout call is a port. Amounts are integer paise.
 * "T+2" counts business days (Sat/Sun excluded) from the delivery-confirmation date, which
 * is the settlement clock the acceptance scenario uses (Mon delivery → Wed payout).
 */
public final class SettlementEngine {

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    /** A vendor receivable accrued from an order event, awaiting settlement. */
    public record AccrualLine(
            String lineId,          // traces back to the order/sub-order event (acceptance)
            String vendorId,
            String subOrderId,
            long netPayablePaise,   // vendor payable, already net of commission (FR-FIN-001)
            Instant deliveryConfirmedAt,
            boolean disputed) {     // disputes freeze only the disputed line (rules)
    }

    /** A vendor's bank account; payout is refused unless penny-drop verified (validation). */
    public record VendorAccount(String vendorId, String accountRef, boolean pennyDropVerified) {}

    /** One vendor's payout within a batch. */
    public record Payout(String vendorId, long amountPaise, List<String> lineIds, String accountRef) {}

    public sealed interface BatchResult {
        record Ok(SettlementBatch batch) implements BatchResult {}
        record Invalid(String reason) implements BatchResult {}
    }

    private SettlementEngine() {
    }

    /**
     * T+2 business-day eligibility (BRU-09). A line settles on batch day D only if at least
     * two business days have passed since delivery confirmation. Disputed lines are frozen.
     */
    public static boolean isEligible(AccrualLine line, LocalDate batchDate) {
        if (line.disputed()) return false;
        LocalDate delivered = LocalDate.ofInstant(line.deliveryConfirmedAt(), IST);
        return businessDaysBetween(delivered, batchDate) >= 2;
    }

    static long businessDaysBetween(LocalDate from, LocalDate to) {
        if (!to.isAfter(from)) return 0;
        long days = 0;
        LocalDate d = from;
        while (d.isBefore(to)) {
            d = d.plusDays(1);
            switch (d.getDayOfWeek()) {
                case SATURDAY, SUNDAY -> { /* not a business day */ }
                default -> days++;
            }
        }
        return days;
    }

    /**
     * Build a settlement batch for a cycle. Groups eligible accruals per vendor, nets to a
     * single payout each, computes the checksum, and enforces separation of duties and
     * penny-drop before the batch is allowed to exist.
     */
    public static BatchResult buildBatch(String batchId, LocalDate batchDate,
                                         List<AccrualLine> accruals, Map<String, VendorAccount> accounts,
                                         String makerId, String checkerId) {
        if (makerId == null || makerId.isBlank()) return new BatchResult.Invalid("MAKER_REQUIRED");
        if (checkerId == null || checkerId.isBlank()) return new BatchResult.Invalid("CHECKER_REQUIRED");
        if (makerId.equals(checkerId)) return new BatchResult.Invalid("SOD_VIOLATION: maker must differ from checker");

        // preserve first-seen vendor order for deterministic, traceable statements
        Map<String, List<AccrualLine>> byVendor = new LinkedHashMap<>();
        for (AccrualLine a : accruals) {
            if (!isEligible(a, batchDate)) continue;
            byVendor.computeIfAbsent(a.vendorId(), v -> new ArrayList<>()).add(a);
        }

        List<Payout> payouts = new ArrayList<>();
        List<String> heldVendors = new ArrayList<>();
        for (var e : byVendor.entrySet()) {
            String vendorId = e.getKey();
            long amount = e.getValue().stream().mapToLong(AccrualLine::netPayablePaise).sum();
            if (amount <= 0) continue;                 // fully-netted-to-zero vendors skip
            VendorAccount acct = accounts.get(vendorId);
            if (acct == null || !acct.pennyDropVerified()) {
                heldVendors.add(vendorId);             // validation: verified accounts only
                continue;
            }
            payouts.add(new Payout(vendorId, amount,
                    e.getValue().stream().map(AccrualLine::lineId).toList(), acct.accountRef()));
        }

        long checksum = payouts.stream().mapToLong(Payout::amountPaise).sum();
        return new BatchResult.Ok(new SettlementBatch(batchId, batchDate, payouts, heldVendors, checksum));
    }

    /**
     * A built, checksummed batch. Executing it drives each payout through the gateway with
     * one retry, then holds with a reason (FR-VEN-011). The batch is immutable; execution
     * returns a result record.
     */
    public static final class SettlementBatch {
        private final String batchId;
        private final LocalDate batchDate;
        private final List<Payout> payouts;
        private final List<String> heldVendors;      // held pre-execution (unverified account)
        private final long checksumPaise;

        SettlementBatch(String batchId, LocalDate batchDate, List<Payout> payouts,
                        List<String> heldVendors, long checksumPaise) {
            this.batchId = batchId;
            this.batchDate = batchDate;
            this.payouts = List.copyOf(payouts);
            this.heldVendors = List.copyOf(heldVendors);
            this.checksumPaise = checksumPaise;
            long sum = payouts.stream().mapToLong(Payout::amountPaise).sum();
            if (sum != checksumPaise) {
                throw new IllegalStateException("CHECKSUM_MISMATCH: " + sum + " != " + checksumPaise);
            }
        }

        /** Gateway payout boundary (FR-FIN-004 "gateway payout API"); adapter supplies UTR. */
        public interface PayoutGateway {
            Result pay(String vendorId, long amountPaise, String accountRef, String idempotencyKey);
            record Result(boolean ok, String utr, String failureReason) {}
        }

        public record PayoutOutcome(String vendorId, long amountPaise, boolean paid,
                                    String utr, int attempts, String heldReason) {}

        public record ExecutionResult(List<PayoutOutcome> outcomes, long paidTotalPaise, long heldTotalPaise) {}

        /**
         * Execute payouts. Each is idempotency-keyed on (batchId, vendorId) so a re-run
         * never double-pays. On gateway failure: retry once; if it still fails, hold with
         * the gateway reason (FR-VEN-011) rather than silently dropping.
         */
        public ExecutionResult execute(PayoutGateway gateway) {
            var outcomes = new ArrayList<PayoutOutcome>();
            long paid = 0, held = 0;
            for (Payout p : payouts) {
                String idemKey = batchId + ":" + p.vendorId();
                var r = gateway.pay(p.vendorId(), p.amountPaise(), p.accountRef(), idemKey);
                int attempts = 1;
                if (!r.ok()) {                          // failed payout retry ×1
                    r = gateway.pay(p.vendorId(), p.amountPaise(), p.accountRef(), idemKey);
                    attempts = 2;
                }
                if (r.ok()) {
                    paid += p.amountPaise();
                    outcomes.add(new PayoutOutcome(p.vendorId(), p.amountPaise(), true, r.utr(), attempts, null));
                } else {
                    held += p.amountPaise();
                    outcomes.add(new PayoutOutcome(p.vendorId(), p.amountPaise(), false, null, attempts,
                            "PAYOUT_FAILED_HELD: " + r.failureReason()));
                }
            }
            return new ExecutionResult(List.copyOf(outcomes), paid, held);
        }

        public String batchId()            { return batchId; }
        public LocalDate batchDate()       { return batchDate; }
        public List<Payout> payouts()      { return payouts; }
        public List<String> heldVendors()  { return heldVendors; }
        public long checksumPaise()        { return checksumPaise; }
    }
}
