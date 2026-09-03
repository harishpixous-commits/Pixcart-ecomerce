package com.pixous.pixcart.finance.domain.statements;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Vendor revenue & fee transparency — FR-VEN-010.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "show per-order and aggregate revenue statements itemising sale value,
 *                commission, payment fee, logistics fee, promo funding, TCS/TDS (as applicable)
 *                and net receivable, with drill-down to fee-schedule versions."
 *   VALIDATION: "All amounts derive from the finance ledger (single source); UI never recomputes
 *                fees."
 *   RULES:      "Fee-schedule changes are versioned and forward-effective with 15-day notice;
 *                disputes raise FIN cases referencing line ids."
 *   ERRORS:     "Ledger lag → 'settling' state, never blank; mismatch detection (should be zero)
 *                alarms FIN."
 *   SECURITY:   "Financial data vendor-scoped; downloads watermarked with vendor id + timestamp."
 *   ACCEPTANCE: "Given any delivered order, When vendor opens its breakdown, Then Σ(components)
 *                = net receivable exactly, and the same figures appear in the corresponding
 *                settlement statement."
 *
 * The design consequence of "UI never recomputes fees" is that this class is a PROJECTION, not a
 * calculator: it is constructed from posted ledger lines and exposes no method that takes a rate,
 * a basis-point figure or a fee schedule to compute from. The test suite asserts that absence by
 * reflection, so a future contributor cannot quietly add a recomputation path that would let the
 * vendor-facing number drift from the ledger.
 *
 * Three protections carry the reconciliation guarantee:
 *   - vendor scoping: a line belonging to another vendor is REFUSED, not filtered silently;
 *   - double-count guard: a repeated ledger line id is REFUSED, which is the actual mechanism by
 *     which a component would otherwise appear twice in a statement;
 *   - a completeness check: a statement with no sale value is not a statement, it is a bug.
 */
public final class VendorStatement {

    /** RULES: a fee-schedule change must be announced at least this far ahead. */
    public static final Duration FEE_SCHEDULE_NOTICE = Duration.ofDays(15);

    /**
     * The itemised components, exactly as the requirement enumerates them. Sign convention:
     * SALE_VALUE is positive; every deduction and reversal is negative, so the net receivable is
     * a plain sum and no component can be accidentally added when it should be subtracted.
     */
    public enum ComponentType {
        SALE_VALUE(true),
        COMMISSION(false),
        PAYMENT_FEE(false),
        LOGISTICS_FEE(false),
        PROMO_FUNDING(false),
        TCS(false),
        TDS(false),
        REFUND_REVERSAL(false);

        private final boolean credit;

        ComponentType(boolean credit) {
            this.credit = credit;
        }

        /** True for amounts owed TO the vendor, false for deductions. */
        public boolean isCredit() {
            return credit;
        }
    }

    /** A posted ledger line — the single source of truth for every figure shown. */
    public record LedgerLine(String lineId, String vendorId, String subOrderId, ComponentType type,
                             long amountPaise, String feeScheduleVersion, Instant postedAt) {
        public LedgerLine {
            if (lineId == null || lineId.isBlank()) throw new IllegalArgumentException("lineId");
            if (vendorId == null || vendorId.isBlank()) throw new IllegalArgumentException("vendorId");
            if (type == null) throw new IllegalArgumentException("type");
            if (type.isCredit() && amountPaise < 0) {
                throw new IllegalArgumentException(type + " must not be negative");
            }
            if (!type.isCredit() && amountPaise > 0) {
                throw new IllegalArgumentException(type + " is a deduction and must be <= 0");
            }
        }
    }

    public enum StatementState {
        /** ERRORS: ledger still catching up — shown as settling, never blank. */
        SETTLING,
        /** Every expected line has posted and the figures are final. */
        FINAL
    }

    public sealed interface Result {
        record Ok(VendorStatement statement) implements Result {}
        record Rejected(List<String> violations) implements Result {}
    }

    /** A FIN dispute case, which must reference the disputed ledger line ids (RULES). */
    public record DisputeCase(String caseId, String vendorId, List<String> lineIds, String reason,
                              Instant raisedAt) {}

    private final String vendorId;
    private final String subOrderId;              // null for an aggregate statement
    private final List<LedgerLine> lines;
    private final Map<ComponentType, Long> components;
    private final long netReceivablePaise;
    private final StatementState state;
    private final Set<String> feeScheduleVersions;
    private final List<DisputeCase> disputes = new ArrayList<>();

    private VendorStatement(String vendorId, String subOrderId, List<LedgerLine> lines,
                            Map<ComponentType, Long> components, long net, StatementState state,
                            Set<String> versions) {
        this.vendorId = vendorId;
        this.subOrderId = subOrderId;
        this.lines = List.copyOf(lines);
        this.components = Map.copyOf(components);
        this.netReceivablePaise = net;
        this.state = state;
        this.feeScheduleVersions = Set.copyOf(versions);
    }

    /**
     * Build a per-order statement from posted ledger lines.
     *
     * @param expectedLineCount how many lines the order is expected to produce once fully
     *                          posted; fewer means the ledger is still catching up and the
     *                          statement is SETTLING rather than blank or wrong
     */
    public static Result forOrder(String vendorId, String subOrderId, List<LedgerLine> ledgerLines,
                                  int expectedLineCount) {
        return build(vendorId, subOrderId, ledgerLines, expectedLineCount, true);
    }

    /** Build an aggregate (period) statement across many sub-orders. */
    public static Result aggregate(String vendorId, List<LedgerLine> ledgerLines) {
        return build(vendorId, null, ledgerLines, ledgerLines.size(), false);
    }

    private static Result build(String vendorId, String subOrderId, List<LedgerLine> ledgerLines,
                                int expectedLineCount, boolean requireSaleValue) {
        var violations = new ArrayList<String>();
        if (vendorId == null || vendorId.isBlank()) violations.add("VENDOR_REQUIRED");
        if (ledgerLines == null || ledgerLines.isEmpty()) violations.add("NO_LEDGER_LINES");

        var seenIds = new LinkedHashSet<String>();
        var components = new EnumMap<ComponentType, Long>(ComponentType.class);
        var versions = new LinkedHashSet<String>();

        if (ledgerLines != null) {
            for (LedgerLine l : ledgerLines) {
                // SECURITY: financial data is vendor-scoped. Another vendor's line is a REFUSAL,
                // not something to filter away quietly — silently dropping it would hide a
                // posting bug behind a plausible-looking statement.
                if (!l.vendorId().equals(vendorId)) {
                    violations.add("LINE_BELONGS_TO_ANOTHER_VENDOR: " + l.lineId() + " -> " + l.vendorId());
                    continue;
                }
                if (subOrderId != null && !subOrderId.equals(l.subOrderId())) {
                    violations.add("LINE_BELONGS_TO_ANOTHER_SUB_ORDER: " + l.lineId());
                    continue;
                }
                // the actual double-count mechanism: the same posted line supplied twice
                if (!seenIds.add(l.lineId())) {
                    violations.add("DUPLICATE_LEDGER_LINE: " + l.lineId());
                    continue;
                }
                components.merge(l.type(), l.amountPaise(), Long::sum);
                if (l.feeScheduleVersion() != null && !l.feeScheduleVersion().isBlank()) {
                    versions.add(l.feeScheduleVersion());
                }
            }
        }

        if (requireSaleValue && !components.containsKey(ComponentType.SALE_VALUE)) {
            violations.add("STATEMENT_HAS_NO_SALE_VALUE");
        }
        if (!violations.isEmpty()) return new Result.Rejected(List.copyOf(violations));

        long net = components.values().stream().mapToLong(Long::longValue).sum();
        StatementState state = seenIds.size() < expectedLineCount ? StatementState.SETTLING : StatementState.FINAL;

        return new Result.Ok(new VendorStatement(vendorId, subOrderId,
                ledgerLines, components, net, state, versions));
    }

    /**
     * ACCEPTANCE, first half: Σ(components) = net receivable exactly. This holds by construction,
     * and the method exists so the assertion can be made explicitly at the boundary — a display
     * layer that renders a subset of components can call this to prove it rendered all of them.
     */
    public boolean reconciles() {
        long sum = components.values().stream().mapToLong(Long::longValue).sum();
        return sum == netReceivablePaise;
    }

    /**
     * Whether the components actually rendered by a caller add up to the stated net. This is the
     * check that catches a display omitting TCS or double-listing a fee.
     */
    public boolean rendersCompletely(Map<ComponentType, Long> rendered) {
        long sum = rendered.values().stream().mapToLong(Long::longValue).sum();
        return sum == netReceivablePaise && rendered.keySet().equals(components.keySet());
    }

    /**
     * ACCEPTANCE, second half: the same figures appear in the corresponding settlement statement.
     * The settlement engine computes a vendor's payable independently from accrual lines; this
     * compares the two. A non-zero delta is the "mismatch detection (should be zero)" the
     * requirement demands, and it is surfaced rather than absorbed.
     */
    public long settlementDeltaPaise(long settlementNetPayablePaise) {
        return netReceivablePaise - settlementNetPayablePaise;
    }

    public boolean reconcilesWithSettlement(long settlementNetPayablePaise) {
        return settlementDeltaPaise(settlementNetPayablePaise) == 0;
    }

    /** ERRORS: a non-zero mismatch alarms FIN. */
    public boolean requiresFinanceAlarm(long settlementNetPayablePaise) {
        return !reconcilesWithSettlement(settlementNetPayablePaise);
    }

    /** RULES: a dispute must reference line ids that are actually on this statement. */
    public sealed interface DisputeResult {
        record Ok(DisputeCase dispute) implements DisputeResult {}
        record Rejected(String reason) implements DisputeResult {}
    }

    public DisputeResult raiseDispute(String caseId, List<String> lineIds, String reason, Instant now) {
        if (lineIds == null || lineIds.isEmpty()) return new DisputeResult.Rejected("DISPUTE_MUST_REFERENCE_LINE_IDS");
        if (reason == null || reason.trim().length() < 5) return new DisputeResult.Rejected("DISPUTE_REASON_REQUIRED");
        var known = lines.stream().map(LedgerLine::lineId).collect(java.util.stream.Collectors.toSet());
        var unknown = lineIds.stream().filter(id -> !known.contains(id)).toList();
        if (!unknown.isEmpty()) return new DisputeResult.Rejected("LINE_NOT_ON_STATEMENT: " + String.join(",", unknown));
        var dispute = new DisputeCase(caseId, vendorId, List.copyOf(lineIds), reason, now);
        disputes.add(dispute);
        return new DisputeResult.Ok(dispute);
    }

    /** SECURITY: downloads are watermarked with vendor id and timestamp. */
    public String downloadWatermark(Instant at) {
        return "vendor=" + vendorId + " generated=" + at + (subOrderId == null ? "" : " subOrder=" + subOrderId);
    }

    public long componentPaise(ComponentType type) {
        return components.getOrDefault(type, 0L);
    }

    public Map<ComponentType, Long> breakdown()      { return components; }
    public long netReceivablePaise()                 { return netReceivablePaise; }
    public StatementState state()                    { return state; }
    public Set<String> feeScheduleVersions()         { return feeScheduleVersions; }
    public String vendorId()                         { return vendorId; }
    public String subOrderId()                       { return subOrderId; }
    public List<LedgerLine> sourceLines()            { return lines; }
    public List<DisputeCase> disputes()              { return List.copyOf(disputes); }

    // ------------------------------------------------------ fee-schedule notice

    /** A versioned, forward-effective fee-schedule change (RULES). */
    public record FeeScheduleChange(String version, Instant announcedAt, Instant effectiveFrom) {}

    public sealed interface NoticeResult {
        record Ok() implements NoticeResult {}
        record Rejected(String reason) implements NoticeResult {}
    }

    /**
     * RULES: fee-schedule changes are forward-effective with 15 days' notice. A change effective
     * sooner than that, or retroactively, is refused — a vendor must never discover that the
     * commission on an order they already shipped has moved.
     */
    public static NoticeResult validateFeeScheduleChange(FeeScheduleChange change) {
        if (change.effectiveFrom().isBefore(change.announcedAt())) {
            return new NoticeResult.Rejected("FEE_SCHEDULE_CHANGE_CANNOT_BE_RETROACTIVE");
        }
        Duration notice = Duration.between(change.announcedAt(), change.effectiveFrom());
        if (notice.compareTo(FEE_SCHEDULE_NOTICE) < 0) {
            return new NoticeResult.Rejected("FEE_SCHEDULE_NOTICE_BELOW_15_DAYS: " + notice.toDays() + "d");
        }
        return new NoticeResult.Ok();
    }
}
