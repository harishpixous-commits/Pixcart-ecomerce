package com.pixous.pixcart.finance.domain.close;

import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Financial reports & period close — FR-FIN-008.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "produce finance reports — revenue by stream, fee income, refunds/leakage,
 *                settlement liability, wallet float, COD in-transit, tax liability — and support
 *                a monthly close checklist with lock (no back-dated postings after lock)."
 *   VALIDATION: "Close requires: recon zero-open > tolerance, settlement batches confirmed, tax
 *                registers generated; else blocked with checklist."
 *   RULES:      "Post-lock corrections only via next-period journals flagged
 *                prior-period-adjustment; all reports ledger-derived (no side calculations)."
 *   ERRORS:     "Any control-account imbalance → close blocked, imbalance report auto-generated."
 *   SECURITY:   "Lock action SA+FIN dual; auditor workspace read-only with its own audit trail."
 *   ACCEPTANCE: "Given period locked, When any service attempts a back-dated ledger post, Then
 *                the post is rejected with period[-locked error]."
 *
 * The lock is the point of this requirement, and it is enforced as a GATE every posting must pass
 * rather than as a flag services are trusted to consult: {@link #canPost} is the only sanctioned
 * route, it refuses a posting dated into a locked period, and the correction path it points to —
 * a next-period journal flagged as a prior-period adjustment — is the only way to fix a locked
 * month. Reports are derived from ledger lines with no side calculations, the same discipline the
 * FR-VEN-010 statement follows, and asserted the same way.
 */
public final class PeriodClose {

    /** VALIDATION: the checklist gates a close must clear. */
    public enum ChecklistItem {
        RECONCILIATION_WITHIN_TOLERANCE,
        SETTLEMENT_BATCHES_CONFIRMED,
        TAX_REGISTERS_GENERATED,
        CONTROL_ACCOUNTS_BALANCED
    }

    public enum CloseState { OPEN, CLOSING, LOCKED }

    /** The report streams the requirement enumerates. */
    public enum ReportStream {
        REVENUE, FEE_INCOME, REFUNDS_LEAKAGE, SETTLEMENT_LIABILITY,
        WALLET_FLOAT, COD_IN_TRANSIT, TAX_LIABILITY
    }

    /** A ledger line, the sole input to every report (RULES: no side calculations). */
    public record LedgerLine(String lineId, String controlAccount, ReportStream stream,
                             long debitPaise, long creditPaise, LocalDate postingDate,
                             boolean priorPeriodAdjustment) {
        public LedgerLine {
            if ((debitPaise == 0) == (creditPaise == 0)) {
                throw new IllegalArgumentException("exactly one of debit/credit must be non-zero");
            }
            if (debitPaise < 0 || creditPaise < 0) throw new IllegalArgumentException("no negative legs");
        }

        public long signedPaise() {
            return debitPaise - creditPaise;
        }
    }

    public sealed interface Outcome {
        record Ok() implements Outcome {}
        record Blocked(List<ChecklistItem> outstanding, String detail) implements Outcome {}
        record Rejected(String reason) implements Outcome {}
    }

    /** ERRORS: an imbalance report is generated automatically when close is blocked by one. */
    public record ImbalanceReport(YearMonth period, Map<String, Long> imbalancedAccounts,
                                 long totalAbsoluteImbalancePaise, Instant generatedAt) {}

    public record AuditorAccess(String auditorId, Instant grantedAt, boolean readOnly) {}

    public record AuditTrailEntry(Instant at, String actorId, String action, String detail) {}

    private final YearMonth period;
    private final Set<ChecklistItem> completed = EnumSet.noneOf(ChecklistItem.class);
    private CloseState state = CloseState.OPEN;
    private String lockedByFinance;
    private String lockedBySuperAdmin;
    private Instant lockedAt;
    private ImbalanceReport lastImbalanceReport;
    private final List<AuditTrailEntry> auditorTrail = new ArrayList<>();
    private final Map<String, AuditorAccess> auditors = new LinkedHashMap<>();

    public PeriodClose(YearMonth period) {
        this.period = period;
    }

    public void completeChecklistItem(ChecklistItem item) {
        completed.add(item);
    }

    public Set<ChecklistItem> outstandingChecklist() {
        var out = EnumSet.allOf(ChecklistItem.class);
        out.removeAll(completed);
        return out;
    }

    /**
     * ERRORS: any control-account imbalance blocks the close and auto-generates the report. An
     * account is imbalanced when its debits and credits within the period do not net to zero.
     */
    public Optional<ImbalanceReport> detectImbalances(List<LedgerLine> lines, Instant now) {
        var byAccount = new LinkedHashMap<String, Long>();
        for (LedgerLine l : lines) {
            if (!YearMonth.from(l.postingDate()).equals(period)) continue;
            byAccount.merge(l.controlAccount(), l.signedPaise(), Long::sum);
        }
        var imbalanced = new LinkedHashMap<String, Long>();
        long absolute = 0;
        for (var e : byAccount.entrySet()) {
            if (e.getValue() != 0) {
                imbalanced.put(e.getKey(), e.getValue());
                absolute += Math.abs(e.getValue());
            }
        }
        if (imbalanced.isEmpty()) return Optional.empty();
        var report = new ImbalanceReport(period, Map.copyOf(imbalanced), absolute, now);
        this.lastImbalanceReport = report;
        return Optional.of(report);
    }

    /**
     * Attempt the close. VALIDATION: every checklist gate must be clear, and ERRORS: a control
     * imbalance blocks it with the report attached. A blocked close returns the OUTSTANDING items
     * so the operator sees the whole list rather than discovering them one at a time.
     */
    public Outcome attemptClose(List<LedgerLine> lines, long reconciliationOpenPaise,
                                long tolerancePaise, Instant now) {
        if (state == CloseState.LOCKED) return new Outcome.Rejected("PERIOD_ALREADY_LOCKED");

        if (Math.abs(reconciliationOpenPaise) <= tolerancePaise) {
            completed.add(ChecklistItem.RECONCILIATION_WITHIN_TOLERANCE);
        } else {
            completed.remove(ChecklistItem.RECONCILIATION_WITHIN_TOLERANCE);
        }

        var imbalance = detectImbalances(lines, now);
        if (imbalance.isPresent()) {
            completed.remove(ChecklistItem.CONTROL_ACCOUNTS_BALANCED);
            return new Outcome.Blocked(List.copyOf(outstandingChecklist()),
                    "control-account imbalance of " + imbalance.get().totalAbsoluteImbalancePaise()
                            + " paise across " + imbalance.get().imbalancedAccounts().size() + " account(s)");
        }
        completed.add(ChecklistItem.CONTROL_ACCOUNTS_BALANCED);

        var outstanding = outstandingChecklist();
        if (!outstanding.isEmpty()) {
            return new Outcome.Blocked(List.copyOf(outstanding), "checklist incomplete");
        }
        state = CloseState.CLOSING;
        return new Outcome.Ok();
    }

    /**
     * SECURITY: the lock is a dual action — Finance and a Super Admin, who must be different
     * people. A single seat cannot seal a period.
     */
    public Outcome lock(String financeId, String superAdminId, Instant now) {
        if (state == CloseState.LOCKED) return new Outcome.Rejected("PERIOD_ALREADY_LOCKED");
        if (state != CloseState.CLOSING) return new Outcome.Rejected("CLOSE_NOT_ATTEMPTED_OR_BLOCKED");
        if (financeId == null || financeId.isBlank()) return new Outcome.Rejected("FINANCE_APPROVER_REQUIRED");
        if (superAdminId == null || superAdminId.isBlank()) return new Outcome.Rejected("SUPER_ADMIN_APPROVER_REQUIRED");
        if (financeId.equals(superAdminId)) return new Outcome.Rejected("DUAL_LOCK_REQUIRES_TWO_PEOPLE");
        state = CloseState.LOCKED;
        lockedByFinance = financeId;
        lockedBySuperAdmin = superAdminId;
        lockedAt = now;
        return new Outcome.Ok();
    }

    /**
     * ACCEPTANCE: the posting gate. A posting dated into a locked period is REJECTED, whichever
     * service attempts it — which is why this is the sanctioned route rather than a flag callers
     * are trusted to check. The refusal names the correction path.
     */
    public Outcome canPost(LocalDate postingDate, boolean flaggedPriorPeriodAdjustment) {
        if (state != CloseState.LOCKED) return new Outcome.Ok();
        YearMonth postingPeriod = YearMonth.from(postingDate);
        // A posting into a LATER period is always fine; the flag matters only to
        // postPriorPeriodAdjustment, which is what routes a correction there.
        if (postingPeriod.isAfter(period)) return new Outcome.Ok();
        // Equal or earlier than the locked period: refused, whatever it claims to be.
        return new Outcome.Rejected("PERIOD_LOCKED_" + period
                + "_USE_NEXT_PERIOD_JOURNAL_FLAGGED_PRIOR_PERIOD_ADJUSTMENT");
    }

    /**
     * RULES: the only sanctioned correction after lock — a journal posted in a LATER period and
     * flagged as a prior-period adjustment. A correction dated into the locked period itself is
     * refused however it is flagged, because that would rewrite a filed month.
     */
    public Outcome postPriorPeriodAdjustment(LedgerLine line) {
        if (state != CloseState.LOCKED) return new Outcome.Rejected("PERIOD_NOT_LOCKED_POST_NORMALLY");
        if (!line.priorPeriodAdjustment()) return new Outcome.Rejected("JOURNAL_NOT_FLAGGED_PRIOR_PERIOD_ADJUSTMENT");
        YearMonth postingPeriod = YearMonth.from(line.postingDate());
        if (!postingPeriod.isAfter(period)) {
            return new Outcome.Rejected("ADJUSTMENT_MUST_POST_IN_A_LATER_PERIOD_NOT_THE_LOCKED_ONE");
        }
        return new Outcome.Ok();
    }

    // ------------------------------------------------------------- reports

    /**
     * RULES: reports are ledger-derived. Each stream's figure is the net of its lines within the
     * period — there is no parameter here by which a caller could inject a computed total.
     */
    public Map<ReportStream, Long> reportPack(List<LedgerLine> lines) {
        var out = new EnumMap<ReportStream, Long>(ReportStream.class);
        for (ReportStream s : ReportStream.values()) out.put(s, 0L);
        for (LedgerLine l : lines) {
            if (!YearMonth.from(l.postingDate()).equals(period)) continue;
            out.merge(l.stream(), l.signedPaise(), Long::sum);
        }
        return out;
    }

    /** Drill-through: the ledger lines behind a reported figure. */
    public List<LedgerLine> drillThrough(List<LedgerLine> lines, ReportStream stream) {
        return lines.stream()
                .filter(l -> YearMonth.from(l.postingDate()).equals(period) && l.stream() == stream)
                .toList();
    }

    // ------------------------------------------------------------- auditor

    /** SECURITY: the auditor workspace is read-only and keeps its own audit trail. */
    public Outcome grantAuditorAccess(String auditorId, Instant now) {
        if (auditorId == null || auditorId.isBlank()) return new Outcome.Rejected("AUDITOR_REQUIRED");
        auditors.put(auditorId, new AuditorAccess(auditorId, now, true));
        auditorTrail.add(new AuditTrailEntry(now, auditorId, "ACCESS_GRANTED", "read-only workspace for " + period));
        return new Outcome.Ok();
    }

    public Outcome auditorRead(String auditorId, ReportStream stream, Instant now) {
        AuditorAccess a = auditors.get(auditorId);
        if (a == null) return new Outcome.Rejected("AUDITOR_NOT_GRANTED");
        auditorTrail.add(new AuditTrailEntry(now, auditorId, "READ", stream.name()));
        return new Outcome.Ok();
    }

    /** Every auditor mutation attempt is refused: the workspace is read-only by construction. */
    public Outcome auditorAttemptWrite(String auditorId, Instant now) {
        auditorTrail.add(new AuditTrailEntry(now, auditorId, "WRITE_REFUSED", "workspace is read-only"));
        return new Outcome.Rejected("AUDITOR_WORKSPACE_IS_READ_ONLY");
    }

    public List<AuditTrailEntry> auditorTrail() {
        return List.copyOf(auditorTrail);
    }

    public YearMonth period()                       { return period; }
    public CloseState state()                       { return state; }
    public String lockedByFinance()                 { return lockedByFinance; }
    public String lockedBySuperAdmin()              { return lockedBySuperAdmin; }
    public Instant lockedAt()                       { return lockedAt; }
    public Optional<ImbalanceReport> lastImbalance() { return Optional.ofNullable(lastImbalanceReport); }
}
