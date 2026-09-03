package com.pixous.pixcart.finance.domain.statements;

import com.pixous.pixcart.finance.domain.SettlementEngine;
import com.pixous.pixcart.finance.domain.SettlementEngine.AccrualLine;
import com.pixous.pixcart.finance.domain.SettlementEngine.BatchResult;
import com.pixous.pixcart.finance.domain.SettlementEngine.VendorAccount;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.ComponentType;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.DisputeResult;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.FeeScheduleChange;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.LedgerLine;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.NoticeResult;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.Result;
import com.pixous.pixcart.finance.domain.statements.VendorStatement.StatementState;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-VEN-010. The acceptance criterion has two halves and both are verified for real: the
 * component sum equals the net receivable, AND the same figure is produced independently by the
 * Slice-6 SettlementEngine from its own accrual inputs. Because both live in this module, that
 * second half is an actual cross-check between two code paths rather than an assertion about one.
 */
class VendorStatementTest {

    private static final Instant MON = Instant.parse("2026-08-17T04:30:00Z");   // Monday IST morning
    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    /**
     * A delivered order: ₹1,000 sale, less 10% commission, 2% payment fee, ₹50 logistics,
     * ₹30 platform-funded promo share and ₹10 TCS. Net receivable = 1000 − 100 − 20 − 50 − 30 − 10
     * = ₹790.
     */
    private static List<LedgerLine> orderLines() {
        return List.of(
                new LedgerLine("L1", "V1", "SUB-1", ComponentType.SALE_VALUE, 1_000_00, "FS-v3", MON),
                new LedgerLine("L2", "V1", "SUB-1", ComponentType.COMMISSION, -100_00, "FS-v3", MON),
                new LedgerLine("L3", "V1", "SUB-1", ComponentType.PAYMENT_FEE, -20_00, "FS-v3", MON),
                new LedgerLine("L4", "V1", "SUB-1", ComponentType.LOGISTICS_FEE, -50_00, "FS-v3", MON),
                new LedgerLine("L5", "V1", "SUB-1", ComponentType.PROMO_FUNDING, -30_00, "FS-v3", MON),
                new LedgerLine("L6", "V1", "SUB-1", ComponentType.TCS, -10_00, "FS-v3", MON));
    }

    private static VendorStatement ok(Result r) {
        if (r instanceof Result.Rejected rej) throw new AssertionError("rejected: " + rej.violations());
        return ((Result.Ok) r).statement();
    }

    // ==================================================== the acceptance criterion

    @Test
    void componentsSumToNetReceivableExactly() {
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6));
        assertEquals(790_00, s.netReceivablePaise());
        assertTrue(s.reconciles());

        // every itemised component the requirement names is present and correctly signed
        assertEquals(1_000_00, s.componentPaise(ComponentType.SALE_VALUE));
        assertEquals(-100_00, s.componentPaise(ComponentType.COMMISSION));
        assertEquals(-20_00, s.componentPaise(ComponentType.PAYMENT_FEE));
        assertEquals(-50_00, s.componentPaise(ComponentType.LOGISTICS_FEE));
        assertEquals(-30_00, s.componentPaise(ComponentType.PROMO_FUNDING));
        assertEquals(-10_00, s.componentPaise(ComponentType.TCS));
        assertEquals(0, s.componentPaise(ComponentType.TDS), "TDS not applicable on this order");
    }

    @Test
    void theSameFigureIsProducedIndependentlyByTheSettlementEngine() {
        // Statement side: derived from ledger lines.
        var statement = ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6));

        // Settlement side: the Slice-6 engine, from its own accrual input, on a Wednesday batch.
        var accruals = List.of(new AccrualLine("L1", "V1", "SUB-1", statement.netReceivablePaise(), MON, false));
        var accounts = Map.of("V1", new VendorAccount("V1", "acct-V1", true));
        LocalDate wed = LocalDate.of(2026, 8, 19);
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("BATCH-1", wed, accruals, accounts, "maker", "checker")).batch();

        assertEquals(1, batch.payouts().size());
        long settlementNet = batch.payouts().get(0).amountPaise();

        // ACCEPTANCE: the statement figure and the settlement figure agree exactly
        assertEquals(790_00, settlementNet);
        assertEquals(0, statement.settlementDeltaPaise(settlementNet));
        assertTrue(statement.reconcilesWithSettlement(settlementNet));
        assertFalse(statement.requiresFinanceAlarm(settlementNet));
        assertEquals(settlementNet, batch.checksumPaise());
    }

    @Test
    void aMismatchIsSurfacedAsADeltaAndAlarmsFinance() {
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6));
        long wrongSettlement = 780_00;                       // ₹10 short
        assertEquals(10_00, s.settlementDeltaPaise(wrongSettlement));
        assertFalse(s.reconcilesWithSettlement(wrongSettlement));
        assertTrue(s.requiresFinanceAlarm(wrongSettlement), "a non-zero mismatch must alarm, not absorb");
    }

    @Test
    void aRefundReversalNetsDownTheReceivableRatherThanBeingOmitted() {
        var lines = new ArrayList<>(orderLines());
        lines.add(new LedgerLine("L7", "V1", "SUB-1", ComponentType.REFUND_REVERSAL, -200_00, "FS-v3", MON));
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", lines, 7));
        assertEquals(590_00, s.netReceivablePaise(), "790 − 200 reversal");
        assertTrue(s.reconciles());
        assertEquals(-200_00, s.componentPaise(ComponentType.REFUND_REVERSAL));
    }

    // ==================================================== single-source discipline

    @Test
    void theStatementExposesNoFeeRecomputationSurface() {
        // VALIDATION: "UI never recomputes fees". A projection must offer no way to compute one,
        // so a future contributor cannot introduce a path that drifts from the ledger.
        var suspicious = java.util.Arrays.stream(VendorStatement.class.getMethods())
                .filter(m -> {
                    String n = m.getName().toLowerCase();
                    boolean namedLikeACalculator = n.contains("computefee") || n.contains("calculate")
                            || n.contains("applyrate") || n.contains("recompute");
                    boolean takesARate = java.util.Arrays.stream(m.getParameterTypes())
                            .anyMatch(t -> t.getSimpleName().toLowerCase().contains("schedule"))
                            && !m.getName().equals("validateFeeScheduleChange");
                    return namedLikeACalculator || takesARate;
                })
                .map(java.lang.reflect.Method::getName)
                .toList();
        assertTrue(suspicious.isEmpty(), "statement must not recompute fees, found: " + suspicious);
    }

    @Test
    void componentSignsAreEnforcedAtConstruction() {
        // a deduction supplied as a positive number is a posting bug and is refused outright
        assertThrows(IllegalArgumentException.class,
                () -> new LedgerLine("X", "V1", "SUB-1", ComponentType.COMMISSION, 100_00, "FS-v3", MON));
        assertThrows(IllegalArgumentException.class,
                () -> new LedgerLine("X", "V1", "SUB-1", ComponentType.SALE_VALUE, -100_00, "FS-v3", MON));
        // zero is acceptable on either side (a fee that happened not to apply)
        assertDoesNotThrow(() -> new LedgerLine("X", "V1", "SUB-1", ComponentType.TDS, 0, "FS-v3", MON));
    }

    @Test
    void anotherVendorsLineIsRefusedRatherThanSilentlyFiltered() {
        var lines = new ArrayList<>(orderLines());
        lines.add(new LedgerLine("L9", "V2", "SUB-1", ComponentType.COMMISSION, -5_00, "FS-v3", MON));
        var r = VendorStatement.forOrder("V1", "SUB-1", lines, 7);
        var rejected = assertInstanceOf(Result.Rejected.class, r);
        assertTrue(rejected.violations().stream().anyMatch(v -> v.startsWith("LINE_BELONGS_TO_ANOTHER_VENDOR")),
                "quietly dropping it would hide a posting bug behind a plausible statement");
    }

    @Test
    void anotherSubOrdersLineIsRefusedOnAPerOrderStatement() {
        var lines = new ArrayList<>(orderLines());
        lines.add(new LedgerLine("L9", "V1", "SUB-2", ComponentType.COMMISSION, -5_00, "FS-v3", MON));
        var rejected = assertInstanceOf(Result.Rejected.class, VendorStatement.forOrder("V1", "SUB-1", lines, 7));
        assertTrue(rejected.violations().stream().anyMatch(v -> v.startsWith("LINE_BELONGS_TO_ANOTHER_SUB_ORDER")));
    }

    @Test
    void aRepeatedLedgerLineIsRefused_theActualDoubleCountMechanism() {
        var lines = new ArrayList<>(orderLines());
        lines.add(orderLines().get(1));                       // commission posted twice
        var rejected = assertInstanceOf(Result.Rejected.class, VendorStatement.forOrder("V1", "SUB-1", lines, 7));
        assertTrue(rejected.violations().stream().anyMatch(v -> v.startsWith("DUPLICATE_LEDGER_LINE")));
    }

    @Test
    void aStatementWithoutSaleValueIsRefused() {
        var deductionsOnly = orderLines().subList(1, 6);
        var rejected = assertInstanceOf(Result.Rejected.class,
                VendorStatement.forOrder("V1", "SUB-1", deductionsOnly, 5));
        assertTrue(rejected.violations().contains("STATEMENT_HAS_NO_SALE_VALUE"));
        assertInstanceOf(Result.Rejected.class, VendorStatement.forOrder("V1", "SUB-1", List.of(), 0));
    }

    // ==================================================== settling state

    @Test
    void anIncompleteLedgerShowsSettlingNeverBlank() {
        var partial = orderLines().subList(0, 3);             // 3 of the 6 expected lines posted
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", partial, 6));
        assertEquals(StatementState.SETTLING, s.state());
        // and it still shows real figures rather than nothing
        assertEquals(880_00, s.netReceivablePaise());
        assertTrue(s.reconciles());
        assertFalse(s.breakdown().isEmpty(), "settling must never render blank");
    }

    @Test
    void aCompleteLedgerIsFinal() {
        assertEquals(StatementState.FINAL, ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6)).state());
    }

    // ==================================================== rendering completeness

    @Test
    void renderingASubsetOfComponentsIsDetected() {
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6));
        assertTrue(s.rendersCompletely(s.breakdown()));

        // a display that forgets TCS does not reconcile
        var missingTcs = new EnumMap<ComponentType, Long>(s.breakdown());
        missingTcs.remove(ComponentType.TCS);
        assertFalse(s.rendersCompletely(missingTcs));

        // nor does one that double-lists the commission
        var doubled = new EnumMap<ComponentType, Long>(s.breakdown());
        doubled.put(ComponentType.COMMISSION, -200_00L);
        assertFalse(s.rendersCompletely(doubled));
    }

    // ==================================================== aggregate & drill-down

    @Test
    void anAggregateStatementSpansSubOrdersAndSumsCorrectly() {
        var lines = new ArrayList<>(orderLines());
        lines.add(new LedgerLine("M1", "V1", "SUB-2", ComponentType.SALE_VALUE, 500_00, "FS-v4", MON));
        lines.add(new LedgerLine("M2", "V1", "SUB-2", ComponentType.COMMISSION, -75_00, "FS-v4", MON));
        var s = ok(VendorStatement.aggregate("V1", lines));
        assertNull(s.subOrderId());
        assertEquals(790_00 + 425_00, s.netReceivablePaise());
        assertTrue(s.reconciles());
    }

    @Test
    void feeScheduleVersionsAreExposedForDrillDown() {
        var lines = new ArrayList<>(orderLines());
        lines.add(new LedgerLine("M1", "V1", "SUB-2", ComponentType.SALE_VALUE, 500_00, "FS-v4", MON));
        var s = ok(VendorStatement.aggregate("V1", lines));
        assertEquals(java.util.Set.of("FS-v3", "FS-v4"), s.feeScheduleVersions());
    }

    // ==================================================== disputes & watermark

    @Test
    void aDisputeMustReferenceLineIdsThatAreOnTheStatement() {
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6));
        assertInstanceOf(DisputeResult.Rejected.class, s.raiseDispute("D1", List.of(), "commission looks wrong", MON));
        assertInstanceOf(DisputeResult.Rejected.class, s.raiseDispute("D1", List.of("L2"), "no", MON));
        var unknown = assertInstanceOf(DisputeResult.Rejected.class,
                s.raiseDispute("D1", List.of("L2", "L99"), "commission rate looks wrong", MON));
        assertTrue(unknown.reason().contains("L99"));

        var okCase = assertInstanceOf(DisputeResult.Ok.class,
                s.raiseDispute("D1", List.of("L2", "L3"), "commission rate looks wrong for this category", MON));
        assertEquals(List.of("L2", "L3"), okCase.dispute().lineIds());
        assertEquals("V1", okCase.dispute().vendorId());
        assertEquals(1, s.disputes().size());
    }

    @Test
    void downloadsAreWatermarkedWithVendorAndTimestamp() {
        var s = ok(VendorStatement.forOrder("V1", "SUB-1", orderLines(), 6));
        String w = s.downloadWatermark(MON);
        assertTrue(w.contains("vendor=V1"));
        assertTrue(w.contains("generated=" + MON));
        assertTrue(w.contains("subOrder=SUB-1"));
        assertFalse(ok(VendorStatement.aggregate("V1", orderLines())).downloadWatermark(MON).contains("subOrder="));
    }

    // ==================================================== fee-schedule notice

    @Test
    void feeScheduleChangesRequireFifteenDaysForwardNotice() {
        assertInstanceOf(NoticeResult.Ok.class, VendorStatement.validateFeeScheduleChange(
                new FeeScheduleChange("FS-v5", MON, MON.plus(Duration.ofDays(15)))));

        var tooSoon = assertInstanceOf(NoticeResult.Rejected.class, VendorStatement.validateFeeScheduleChange(
                new FeeScheduleChange("FS-v5", MON, MON.plus(Duration.ofDays(14)))));
        assertTrue(tooSoon.reason().startsWith("FEE_SCHEDULE_NOTICE_BELOW_15_DAYS"));

        var retro = assertInstanceOf(NoticeResult.Rejected.class, VendorStatement.validateFeeScheduleChange(
                new FeeScheduleChange("FS-v5", MON, MON.minus(Duration.ofDays(1)))));
        assertEquals("FEE_SCHEDULE_CHANGE_CANNOT_BE_RETROACTIVE", retro.reason());
    }
}
