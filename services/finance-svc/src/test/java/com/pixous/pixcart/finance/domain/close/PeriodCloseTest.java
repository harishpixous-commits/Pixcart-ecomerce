package com.pixous.pixcart.finance.domain.close;

import com.pixous.pixcart.finance.domain.close.PeriodClose.ChecklistItem;
import com.pixous.pixcart.finance.domain.close.PeriodClose.CloseState;
import com.pixous.pixcart.finance.domain.close.PeriodClose.LedgerLine;
import com.pixous.pixcart.finance.domain.close.PeriodClose.Outcome;
import com.pixous.pixcart.finance.domain.close.PeriodClose.ReportStream;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** FR-FIN-008 financial reports and period close, with the back-dated-post acceptance criterion. */
class PeriodCloseTest {

    private static final YearMonth AUG = YearMonth.of(2026, 8);
    private static final LocalDate AUG_15 = LocalDate.of(2026, 8, 15);
    private static final LocalDate SEP_02 = LocalDate.of(2026, 9, 2);
    private static final LocalDate JUL_20 = LocalDate.of(2026, 7, 20);
    private static final Instant NOW = Instant.parse("2026-09-01T04:00:00Z");

    /** A balanced set of August lines: every control account nets to zero. */
    private static List<LedgerLine> balancedAugust() {
        return List.of(
                new LedgerLine("L1", "GATEWAY_CLEARING", ReportStream.REVENUE, 1_180_00, 0, AUG_15, false),
                new LedgerLine("L2", "GATEWAY_CLEARING", ReportStream.REVENUE, 0, 1_180_00, AUG_15, false),
                new LedgerLine("L3", "PLATFORM_COMMISSION", ReportStream.FEE_INCOME, 0, 100_00, AUG_15, false),
                new LedgerLine("L4", "PLATFORM_COMMISSION", ReportStream.FEE_INCOME, 100_00, 0, AUG_15, false));
    }

    private static PeriodClose readyToClose() {
        var pc = new PeriodClose(AUG);
        pc.completeChecklistItem(ChecklistItem.SETTLEMENT_BATCHES_CONFIRMED);
        pc.completeChecklistItem(ChecklistItem.TAX_REGISTERS_GENERATED);
        return pc;
    }

    private static PeriodClose locked() {
        var pc = readyToClose();
        assertInstanceOf(Outcome.Ok.class, pc.attemptClose(balancedAugust(), 0, 100, NOW));
        assertInstanceOf(Outcome.Ok.class, pc.lock("FIN-1", "SA-1", NOW));
        return pc;
    }

    // ================================================= checklist gating

    @Test
    void anIncompleteChecklistBlocksTheCloseAndListsEveryOutstandingItem() {
        var pc = new PeriodClose(AUG);
        var blocked = assertInstanceOf(Outcome.Blocked.class, pc.attemptClose(balancedAugust(), 0, 100, NOW));
        assertTrue(blocked.outstanding().contains(ChecklistItem.SETTLEMENT_BATCHES_CONFIRMED));
        assertTrue(blocked.outstanding().contains(ChecklistItem.TAX_REGISTERS_GENERATED));
        assertEquals("checklist incomplete", blocked.detail());
        assertEquals(CloseState.OPEN, pc.state());
    }

    @Test
    void reconciliationOutsideToleranceBlocksTheClose() {
        var pc = readyToClose();
        var blocked = assertInstanceOf(Outcome.Blocked.class, pc.attemptClose(balancedAugust(), 500, 100, NOW));
        assertTrue(blocked.outstanding().contains(ChecklistItem.RECONCILIATION_WITHIN_TOLERANCE));

        // within tolerance (in either direction) it clears
        assertInstanceOf(Outcome.Ok.class, readyToClose().attemptClose(balancedAugust(), 100, 100, NOW));
        assertInstanceOf(Outcome.Ok.class, readyToClose().attemptClose(balancedAugust(), -100, 100, NOW));
    }

    // ================================================= imbalance (ERRORS)

    @Test
    void aControlAccountImbalanceBlocksTheCloseAndAutoGeneratesTheReport() {
        var pc = readyToClose();
        var lines = new ArrayList<>(balancedAugust());
        lines.add(new LedgerLine("L9", "VENDOR_PAYABLE", ReportStream.SETTLEMENT_LIABILITY, 0, 250_00, AUG_15, false));

        var blocked = assertInstanceOf(Outcome.Blocked.class, pc.attemptClose(lines, 0, 100, NOW));
        assertTrue(blocked.detail().contains("control-account imbalance"));
        assertEquals(CloseState.OPEN, pc.state());

        var report = pc.lastImbalance().orElseThrow();
        assertEquals(AUG, report.period());
        assertEquals(1, report.imbalancedAccounts().size());
        assertEquals(-250_00, report.imbalancedAccounts().get("VENDOR_PAYABLE"));
        assertEquals(250_00, report.totalAbsoluteImbalancePaise());
        assertEquals(NOW, report.generatedAt());
    }

    @Test
    void balancedAccountsProduceNoImbalanceReport() {
        assertTrue(new PeriodClose(AUG).detectImbalances(balancedAugust(), NOW).isEmpty());
    }

    @Test
    void linesOutsideThePeriodAreIgnoredByImbalanceDetection() {
        var pc = new PeriodClose(AUG);
        var lines = new ArrayList<>(balancedAugust());
        // a lone unbalanced September line must not implicate August
        lines.add(new LedgerLine("L9", "WALLET", ReportStream.WALLET_FLOAT, 500_00, 0, SEP_02, false));
        assertTrue(pc.detectImbalances(lines, NOW).isEmpty());
    }

    // ================================================= the dual lock

    @Test
    void theLockRequiresTwoDifferentPeopleFromFinanceAndSuperAdmin() {
        var pc = readyToClose();
        pc.attemptClose(balancedAugust(), 0, 100, NOW);

        assertInstanceOf(Outcome.Rejected.class, pc.lock("", "SA-1", NOW));
        assertInstanceOf(Outcome.Rejected.class, pc.lock("FIN-1", "  ", NOW));
        var same = assertInstanceOf(Outcome.Rejected.class, pc.lock("FIN-1", "FIN-1", NOW));
        assertEquals("DUAL_LOCK_REQUIRES_TWO_PEOPLE", same.reason());

        assertInstanceOf(Outcome.Ok.class, pc.lock("FIN-1", "SA-1", NOW));
        assertEquals(CloseState.LOCKED, pc.state());
        assertEquals("FIN-1", pc.lockedByFinance());
        assertEquals("SA-1", pc.lockedBySuperAdmin());
        assertEquals(NOW, pc.lockedAt());
    }

    @Test
    void aPeriodCannotBeLockedWithoutAttemptingCloseOrLockedTwice() {
        var pc = readyToClose();
        var notAttempted = assertInstanceOf(Outcome.Rejected.class, pc.lock("FIN-1", "SA-1", NOW));
        assertEquals("CLOSE_NOT_ATTEMPTED_OR_BLOCKED", notAttempted.reason());

        pc.attemptClose(balancedAugust(), 0, 100, NOW);
        pc.lock("FIN-1", "SA-1", NOW);
        assertInstanceOf(Outcome.Rejected.class, pc.lock("FIN-2", "SA-2", NOW));
        assertInstanceOf(Outcome.Rejected.class, pc.attemptClose(balancedAugust(), 0, 100, NOW));
    }

    @Test
    void aBlockedCloseCannotBeLocked() {
        var pc = new PeriodClose(AUG);                       // checklist incomplete
        pc.attemptClose(balancedAugust(), 0, 100, NOW);
        assertInstanceOf(Outcome.Rejected.class, pc.lock("FIN-1", "SA-1", NOW));
    }

    // ================================================= THE ACCEPTANCE CRITERION

    @Test
    void aBackDatedPostIntoALockedPeriodIsRejected_acceptanceScenario() {
        // "Given period locked, When any service attempts a back-dated ledger post, Then the post
        //  is rejected with a period-locked error."
        var pc = locked();

        var intoLockedMonth = assertInstanceOf(Outcome.Rejected.class, pc.canPost(AUG_15, false));
        assertTrue(intoLockedMonth.reason().startsWith("PERIOD_LOCKED_2026-08"));
        assertTrue(intoLockedMonth.reason().contains("PRIOR_PERIOD_ADJUSTMENT"),
                "the refusal must name the sanctioned correction path");

        // an even earlier period is equally refused
        assertInstanceOf(Outcome.Rejected.class, pc.canPost(JUL_20, false));

        // and claiming to be a prior-period adjustment does NOT unlock the locked month itself
        assertInstanceOf(Outcome.Rejected.class, pc.canPost(AUG_15, true));

        // a posting into a later, open period is fine
        assertInstanceOf(Outcome.Ok.class, pc.canPost(SEP_02, false));
    }

    @Test
    void beforeLockPostingIntoThePeriodIsPermitted() {
        var pc = readyToClose();
        assertInstanceOf(Outcome.Ok.class, pc.canPost(AUG_15, false));
        pc.attemptClose(balancedAugust(), 0, 100, NOW);
        assertInstanceOf(Outcome.Ok.class, pc.canPost(AUG_15, false), "CLOSING is not yet LOCKED");
    }

    // ================================================= prior-period adjustments

    @Test
    void theOnlyPostLockCorrectionIsAFlaggedJournalInALaterPeriod() {
        var pc = locked();

        var unflagged = new LedgerLine("A1", "PLATFORM_COMMISSION", ReportStream.FEE_INCOME,
                50_00, 0, SEP_02, false);
        var notFlagged = assertInstanceOf(Outcome.Rejected.class, pc.postPriorPeriodAdjustment(unflagged));
        assertEquals("JOURNAL_NOT_FLAGGED_PRIOR_PERIOD_ADJUSTMENT", notFlagged.reason());

        var intoLocked = new LedgerLine("A2", "PLATFORM_COMMISSION", ReportStream.FEE_INCOME,
                50_00, 0, AUG_15, true);
        var wrongPeriod = assertInstanceOf(Outcome.Rejected.class, pc.postPriorPeriodAdjustment(intoLocked));
        assertEquals("ADJUSTMENT_MUST_POST_IN_A_LATER_PERIOD_NOT_THE_LOCKED_ONE", wrongPeriod.reason());

        var correct = new LedgerLine("A3", "PLATFORM_COMMISSION", ReportStream.FEE_INCOME,
                50_00, 0, SEP_02, true);
        assertInstanceOf(Outcome.Ok.class, pc.postPriorPeriodAdjustment(correct));
    }

    @Test
    void aPriorPeriodAdjustmentIsMeaninglessBeforeTheLock() {
        var pc = readyToClose();
        var line = new LedgerLine("A1", "X", ReportStream.FEE_INCOME, 50_00, 0, SEP_02, true);
        var r = assertInstanceOf(Outcome.Rejected.class, pc.postPriorPeriodAdjustment(line));
        assertEquals("PERIOD_NOT_LOCKED_POST_NORMALLY", r.reason());
    }

    // ================================================= reports

    @Test
    void everyDocumentedStreamIsReportedAndDerivedFromTheLedger() {
        var pc = new PeriodClose(AUG);
        var lines = List.of(
                new LedgerLine("R1", "REV", ReportStream.REVENUE, 0, 10_000_00, AUG_15, false),
                new LedgerLine("R2", "FEE", ReportStream.FEE_INCOME, 0, 1_000_00, AUG_15, false),
                new LedgerLine("R3", "REF", ReportStream.REFUNDS_LEAKAGE, 300_00, 0, AUG_15, false),
                new LedgerLine("R4", "SET", ReportStream.SETTLEMENT_LIABILITY, 0, 8_700_00, AUG_15, false),
                new LedgerLine("R5", "WAL", ReportStream.WALLET_FLOAT, 0, 500_00, AUG_15, false),
                new LedgerLine("R6", "COD", ReportStream.COD_IN_TRANSIT, 2_000_00, 0, AUG_15, false),
                new LedgerLine("R7", "TAX", ReportStream.TAX_LIABILITY, 0, 1_800_00, AUG_15, false));

        var pack = pc.reportPack(lines);
        assertEquals(ReportStream.values().length, pack.size(), "every stream appears, even at zero");
        assertEquals(-10_000_00, pack.get(ReportStream.REVENUE));
        assertEquals(-1_000_00, pack.get(ReportStream.FEE_INCOME));
        assertEquals(300_00, pack.get(ReportStream.REFUNDS_LEAKAGE));
        assertEquals(-8_700_00, pack.get(ReportStream.SETTLEMENT_LIABILITY));
        assertEquals(-500_00, pack.get(ReportStream.WALLET_FLOAT));
        assertEquals(2_000_00, pack.get(ReportStream.COD_IN_TRANSIT));
        assertEquals(-1_800_00, pack.get(ReportStream.TAX_LIABILITY));
    }

    @Test
    void reportsExcludeOtherPeriodsAndSupportDrillThrough() {
        var pc = new PeriodClose(AUG);
        var lines = List.of(
                new LedgerLine("R1", "REV", ReportStream.REVENUE, 0, 10_000_00, AUG_15, false),
                new LedgerLine("R2", "REV", ReportStream.REVENUE, 0, 99_999_00, SEP_02, false));
        assertEquals(-10_000_00, pc.reportPack(lines).get(ReportStream.REVENUE),
                "a September line must not inflate August");

        var drill = pc.drillThrough(lines, ReportStream.REVENUE);
        assertEquals(1, drill.size());
        assertEquals("R1", drill.get(0).lineId());
    }

    @Test
    void theReportPackExposesNoSideCalculationSurface() {
        // RULES: "all reports ledger-derived (no side calculations)". There must be no method by
        // which a caller injects a pre-computed total, so the pack cannot diverge from the ledger.
        var suspicious = java.util.Arrays.stream(PeriodClose.class.getMethods())
                .filter(m -> {
                    String n = m.getName().toLowerCase();
                    return n.contains("settotal") || n.contains("override") || n.contains("adjustreport")
                            || n.contains("setreport");
                })
                .map(java.lang.reflect.Method::getName)
                .toList();
        assertTrue(suspicious.isEmpty(), "reports must stay ledger-derived, found: " + suspicious);
    }

    @Test
    void aLedgerLineWithBothOrNeitherSideIsUnconstructible() {
        assertThrows(IllegalArgumentException.class,
                () -> new LedgerLine("X", "A", ReportStream.REVENUE, 10, 10, AUG_15, false));
        assertThrows(IllegalArgumentException.class,
                () -> new LedgerLine("X", "A", ReportStream.REVENUE, 0, 0, AUG_15, false));
        assertThrows(IllegalArgumentException.class,
                () -> new LedgerLine("X", "A", ReportStream.REVENUE, -10, 0, AUG_15, false));
    }

    // ================================================= auditor workspace

    @Test
    void theAuditorWorkspaceIsReadOnlyAndKeepsItsOwnTrail() {
        var pc = locked();
        assertInstanceOf(Outcome.Rejected.class, pc.auditorRead("AUD-1", ReportStream.REVENUE, NOW),
                "an ungranted auditor cannot read");

        assertInstanceOf(Outcome.Ok.class, pc.grantAuditorAccess("AUD-1", NOW));
        assertInstanceOf(Outcome.Ok.class, pc.auditorRead("AUD-1", ReportStream.REVENUE, NOW.plusSeconds(60)));

        var write = assertInstanceOf(Outcome.Rejected.class, pc.auditorAttemptWrite("AUD-1", NOW.plusSeconds(90)));
        assertEquals("AUDITOR_WORKSPACE_IS_READ_ONLY", write.reason());

        var trail = pc.auditorTrail();
        assertEquals(3, trail.size());
        assertEquals("ACCESS_GRANTED", trail.get(0).action());
        assertEquals("READ", trail.get(1).action());
        assertEquals("WRITE_REFUSED", trail.get(2).action(), "even the refused attempt is recorded");
        assertTrue(trail.stream().allMatch(e -> e.actorId().equals("AUD-1")));
    }

    @Test
    void grantingAccessToAnUnnamedAuditorIsRefused() {
        assertInstanceOf(Outcome.Rejected.class, new PeriodClose(AUG).grantAuditorAccess("  ", NOW));
    }
}
