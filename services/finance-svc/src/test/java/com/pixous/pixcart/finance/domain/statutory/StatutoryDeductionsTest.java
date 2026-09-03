package com.pixous.pixcart.finance.domain.statutory;

import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.Adjustment;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.AdjustmentResult;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.ComputeResult;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.ConfigResult;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.DeductionLine;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.DeductionType;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.PeriodAggregate;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.RateConfig;
import com.pixous.pixcart.finance.domain.statutory.StatutoryDeductions.VendorTaxStatus;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-FIN-007. The rates used here are FIXTURES exercising the mechanism, not constants the
 * implementation depends on: every rate is effective-dated configuration with an advisor sign-off
 * reference, so when legislation moves, configuration moves and no code changes.
 */
class StatutoryDeductionsTest {

    private static final YearMonth AUG = YearMonth.of(2026, 8);
    private static final LocalDate AUG_1 = LocalDate.of(2026, 8, 1);
    private static final LocalDate AUG_31 = LocalDate.of(2026, 8, 31);

    /** 1% TCS and 1% TDS as configured fixtures, plus a 20% PAN-missing TDS rate. */
    private static StatutoryDeductions configured() {
        var s = new StatutoryDeductions();
        assertInstanceOf(ConfigResult.Ok.class, s.registerRate(
                new RateConfig(DeductionType.GST_TCS, 100, LocalDate.of(2025, 4, 1), "ADV-2025-01")));
        assertInstanceOf(ConfigResult.Ok.class, s.registerRate(
                new RateConfig(DeductionType.INCOME_TAX_TDS_194O, 100, LocalDate.of(2025, 4, 1), "ADV-2025-02")));
        assertInstanceOf(ConfigResult.Ok.class,
                s.setPanMissingRate(DeductionType.INCOME_TAX_TDS_194O, 2_000, "ADV-2025-03"));
        return s;
    }

    /** A vendor with ₹1,00,000 net taxable supplies and ₹1,18,000 gross sales for the month. */
    private static PeriodAggregate augustAggregate() {
        return new PeriodAggregate("V1", AUG_1, AUG_31, 1_00_000_00, 1_18_000_00);
    }

    private static List<DeductionLine> ok(ComputeResult r) {
        if (r instanceof ComputeResult.Rejected rej) throw new AssertionError("rejected: " + rej.violations());
        return ((ComputeResult.Ok) r).lines();
    }

    // ================================================= the two distinct bases

    @Test
    void tcsUsesNetTaxableSuppliesAndTdsUsesGrossSales() {
        assertEquals(DeductionType.Base.NET_TAXABLE_SUPPLIES, DeductionType.GST_TCS.base());
        assertEquals(DeductionType.Base.GROSS_SALES, DeductionType.INCOME_TAX_TDS_194O.base());

        var s = configured();
        var status = new VendorTaxStatus("V1", true, true);

        var tcs = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), status));
        assertEquals(1, tcs.size());
        assertEquals(1_00_000_00, tcs.get(0).basePaise(), "TCS is on net taxable supplies");
        assertEquals(1_000_00, tcs.get(0).amountPaise(), "1% of Rs 1,00,000");

        var tds = ok(s.compute(DeductionType.INCOME_TAX_TDS_194O, augustAggregate(), status));
        assertEquals(1_18_000_00, tds.get(0).basePaise(), "TDS 194-O is on GROSS sales");
        assertEquals(1_180_00, tds.get(0).amountPaise(), "1% of Rs 1,18,000");

        assertNotEquals(tcs.get(0).basePaise(), tds.get(0).basePaise(),
                "conflating the two bases is the classic error this separation prevents");
    }

    // ================================================= rate configuration

    @Test
    void aRateWithoutAdvisorSignOffIsRefused() {
        var s = new StatutoryDeductions();
        var r = assertInstanceOf(ConfigResult.Rejected.class, s.registerRate(
                new RateConfig(DeductionType.GST_TCS, 100, AUG_1, "  ")));
        assertEquals("RATE_REQUIRES_ADVISOR_SIGN_OFF", r.reason());
        assertInstanceOf(ConfigResult.Rejected.class,
                s.setPanMissingRate(DeductionType.GST_TCS, 2_000, null));
    }

    @Test
    void anOutOfRangeRateIsRefused() {
        var s = new StatutoryDeductions();
        assertInstanceOf(ConfigResult.Rejected.class, s.registerRate(
                new RateConfig(DeductionType.GST_TCS, -1, AUG_1, "ADV-1")));
        assertInstanceOf(ConfigResult.Rejected.class, s.registerRate(
                new RateConfig(DeductionType.GST_TCS, 10_001, AUG_1, "ADV-1")));
    }

    @Test
    void theRateInForceIsTheLatestEffectiveOnOrBeforeTheDate() {
        var s = configured();
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 50, LocalDate.of(2026, 8, 16), "ADV-2026-09"));
        assertEquals(100, s.rateOn(DeductionType.GST_TCS, LocalDate.of(2026, 8, 15)).orElseThrow().rateBps());
        assertEquals(50, s.rateOn(DeductionType.GST_TCS, LocalDate.of(2026, 8, 16)).orElseThrow().rateBps());
        assertTrue(s.rateOn(DeductionType.GST_TCS, LocalDate.of(2024, 1, 1)).isEmpty());
    }

    @Test
    void computingWithNoRateInForceIsRefusedRatherThanAssumingZero() {
        var s = new StatutoryDeductions();
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 100, LocalDate.of(2027, 1, 1), "ADV-X"));
        var r = assertInstanceOf(ComputeResult.Rejected.class,
                s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", true, true)));
        assertTrue(r.violations().contains("NO_RATE_IN_FORCE_AT_PERIOD_START"));
    }

    // ================================================= split-period (ERRORS)

    @Test
    void aMidMonthRateChangeSplitsThePeriodAndShowsBothSegments() {
        var s = configured();
        // rate halves from 16 August
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 50, LocalDate.of(2026, 8, 16), "ADV-2026-09"));

        var lines = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", true, true)));
        assertEquals(2, lines.size(), "both segments must be shown, not a blended figure");

        assertEquals(AUG_1, lines.get(0).segmentFrom());
        assertEquals(LocalDate.of(2026, 8, 15), lines.get(0).segmentTo());
        assertEquals(100, lines.get(0).rateBps());
        assertEquals("ADV-2025-01", lines.get(0).rateSignOffRef());

        assertEquals(LocalDate.of(2026, 8, 16), lines.get(1).segmentFrom());
        assertEquals(AUG_31, lines.get(1).segmentTo());
        assertEquals(50, lines.get(1).rateBps());
        assertEquals("ADV-2026-09", lines.get(1).rateSignOffRef());
    }

    @Test
    void segmentBasesSumToExactlyThePeriodBase_noPaisaCreatedOrLost() {
        var s = configured();
        // an awkward base that does not divide evenly across a 31-day month, split three ways
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 90, LocalDate.of(2026, 8, 11), "ADV-A"));
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 80, LocalDate.of(2026, 8, 21), "ADV-B"));
        long awkward = 1_00_000_01L;
        var aggregate = new PeriodAggregate("V1", AUG_1, AUG_31, awkward, awkward);

        var lines = ok(s.compute(DeductionType.GST_TCS, aggregate, new VendorTaxStatus("V1", true, true)));
        assertEquals(3, lines.size());
        long summedBase = lines.stream().mapToLong(DeductionLine::basePaise).sum();
        assertEquals(awkward, summedBase, "segment bases must reconstruct the period base exactly");
        assertTrue(lines.stream().allMatch(l -> l.basePaise() > 0), "no empty segments");
    }

    @Test
    void withNoRateChangeThereIsExactlyOneSegmentCoveringTheWholePeriod() {
        var lines = ok(configured().compute(DeductionType.GST_TCS, augustAggregate(),
                new VendorTaxStatus("V1", true, true)));
        assertEquals(1, lines.size());
        assertEquals(AUG_1, lines.get(0).segmentFrom());
        assertEquals(AUG_31, lines.get(0).segmentTo());
        assertEquals(1_00_000_00, lines.get(0).basePaise());
    }

    // ================================================= PAN-missing rule

    @Test
    void panMissingAppliesTheHigherRateAndRaisesTheOnboardingBlock() {
        var s = configured();
        var noPan = new VendorTaxStatus("V2", false, true);
        assertFalse(s.isOnboardingBlocked("V2"));

        var lines = ok(s.compute(DeductionType.INCOME_TAX_TDS_194O,
                new PeriodAggregate("V2", AUG_1, AUG_31, 1_00_000_00, 1_00_000_00), noPan));
        assertEquals(2_000, lines.get(0).rateBps(), "the configured higher rate replaces the standard one");
        assertEquals(20_000_00, lines.get(0).amountPaise(), "20% of Rs 1,00,000");
        assertTrue(lines.get(0).higherRateApplied());

        // VALIDATION: the onboarding block flag is raised as a consequence
        assertTrue(s.isOnboardingBlocked("V2"));
    }

    @Test
    void aVendorWithPanIsNotFlaggedAndPaysTheStandardRate() {
        var s = configured();
        var lines = ok(s.compute(DeductionType.INCOME_TAX_TDS_194O, augustAggregate(),
                new VendorTaxStatus("V1", true, true)));
        assertEquals(100, lines.get(0).rateBps());
        assertFalse(lines.get(0).higherRateApplied());
        assertFalse(s.isOnboardingBlocked("V1"));
    }

    @Test
    void whenNoHigherRateIsConfiguredTheStandardRateIsUsedRatherThanGuessing() {
        var s = new StatutoryDeductions();
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 100, LocalDate.of(2025, 4, 1), "ADV-1"));
        // no PAN-missing rate configured for TCS
        var lines = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", false, true)));
        assertEquals(100, lines.get(0).rateBps(), "absent configuration, the standard rate applies");
        assertTrue(lines.get(0).higherRateApplied(), "but the fact is still recorded");
    }

    // ================================================= validation guards

    @Test
    void invalidInputsAreRefusedWithEveryReason() {
        var s = configured();
        var r = assertInstanceOf(ComputeResult.Rejected.class, s.compute(DeductionType.GST_TCS,
                new PeriodAggregate("V1", AUG_31, AUG_1, -1, -1), new VendorTaxStatus("V9", true, true)));
        assertTrue(r.violations().contains("PERIOD_INVERTED"));
        assertTrue(r.violations().contains("NEGATIVE_BASE"));
        assertTrue(r.violations().contains("STATUS_VENDOR_MISMATCH"));
    }

    // ================================================= the acceptance criterion

    @Test
    void registerTotalsTieOutToTheControlLedgerExactly() {
        // "Given month-end close, When registers generate, Then Σ vendor TCS = TCS control-ledger
        //  balance exactly."
        var s = configured();
        var status = new VendorTaxStatus("V1", true, true);
        var v1 = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), status));
        var v2 = ok(s.compute(DeductionType.GST_TCS,
                new PeriodAggregate("V2", AUG_1, AUG_31, 50_000_00, 59_000_00),
                new VendorTaxStatus("V2", true, true)));

        var all = new java.util.ArrayList<DeductionLine>();
        all.addAll(v1);
        all.addAll(v2);
        var register = StatutoryDeductions.buildRegister(AUG, DeductionType.GST_TCS, all);

        assertEquals(1_000_00 + 500_00, register.totalDeductionPaise());
        assertEquals(1_50_000_00, register.totalBasePaise());
        assertEquals(2, register.byVendor().size());
        assertEquals(1_000_00, register.byVendor().get("V1"));
        assertEquals(500_00, register.byVendor().get("V2"));

        long controlLedger = 1_500_00;
        assertEquals(0, StatutoryDeductions.controlLedgerDifference(register, controlLedger));
        assertTrue(StatutoryDeductions.tiesOutToControlLedger(register, controlLedger));
    }

    @Test
    void aRegisterThatDoesNotTieOutSurfacesTheDifference() {
        var s = configured();
        var lines = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", true, true)));
        var register = StatutoryDeductions.buildRegister(AUG, DeductionType.GST_TCS, lines);
        assertEquals(100, StatutoryDeductions.controlLedgerDifference(register, 1_000_00 - 100));
        assertFalse(StatutoryDeductions.tiesOutToControlLedger(register, 1_000_00 - 100),
                "a statutory register that does not tie out is a filing risk, not a rounding curiosity");
    }

    // ================================================= corrections

    @Test
    void correctionsMustApplyInASubsequentMonthWithATrace() {
        var sameMonth = assertInstanceOf(AdjustmentResult.Rejected.class,
                StatutoryDeductions.raiseAdjustment(AUG, AUG, "V1", DeductionType.GST_TCS, 500,
                        "under-deducted", "TRACE-1"));
        assertEquals("ADJUSTMENT_MUST_APPLY_IN_A_SUBSEQUENT_MONTH", sameMonth.reason());

        var backwards = assertInstanceOf(AdjustmentResult.Rejected.class,
                StatutoryDeductions.raiseAdjustment(AUG, YearMonth.of(2026, 7), "V1",
                        DeductionType.GST_TCS, 500, "under-deducted", "TRACE-1"));
        assertEquals("ADJUSTMENT_MUST_APPLY_IN_A_SUBSEQUENT_MONTH", backwards.reason());

        assertInstanceOf(AdjustmentResult.Rejected.class, StatutoryDeductions.raiseAdjustment(
                AUG, YearMonth.of(2026, 9), "V1", DeductionType.GST_TCS, 0, "no change", "TRACE-1"));
        assertInstanceOf(AdjustmentResult.Rejected.class, StatutoryDeductions.raiseAdjustment(
                AUG, YearMonth.of(2026, 9), "V1", DeductionType.GST_TCS, 500, "under-deducted", "  "));
        assertInstanceOf(AdjustmentResult.Rejected.class, StatutoryDeductions.raiseAdjustment(
                AUG, YearMonth.of(2026, 9), "V1", DeductionType.GST_TCS, 500, "x", "TRACE-1"));

        var okAdj = assertInstanceOf(AdjustmentResult.Ok.class, StatutoryDeductions.raiseAdjustment(
                AUG, YearMonth.of(2026, 9), "V1", DeductionType.GST_TCS, 500,
                "under-deducted on a late-posted order", "TRACE-AUG-001"));
        Adjustment a = okAdj.adjustment();
        assertEquals(AUG, a.correctedMonth());
        assertEquals(YearMonth.of(2026, 9), a.appliedInMonth());
        assertEquals("TRACE-AUG-001", a.traceRef());
    }

    // ================================================= exports & certificates

    @Test
    void exportsAreVersionedAccessScopedAndCarryEverySegment() {
        var s = configured();
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 50, LocalDate.of(2026, 8, 16), "ADV-2026-09"));
        var lines = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", true, true)));
        var register = StatutoryDeductions.buildRegister(AUG, DeductionType.GST_TCS, lines);

        var export = StatutoryDeductions.export(register, "GSTR8-v2", "FIN_ONLY");
        assertEquals("GSTR8-v2", export.schemaVersion());
        assertEquals("FIN_ONLY", export.accessScope());
        assertEquals(1 + 2, export.rows().size(), "a header plus one row per segment");
        assertTrue(export.rows().get(0).startsWith("vendor_id,levy,"));
        assertTrue(export.rows().get(1).contains("ADV-2025-01"), "the sign-off travels with the row");
        assertTrue(export.rows().get(2).contains("ADV-2026-09"));
    }

    @Test
    void certificatesAreTamperHashedAndDetectAlteration() {
        var s = configured();
        var lines = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", true, true)));
        var cert = StatutoryDeductions.certificate("V1", AUG, DeductionType.GST_TCS, lines);

        assertEquals(1_00_000_00, cert.basePaise());
        assertEquals(1_000_00, cert.deductionPaise());
        assertEquals(64, cert.tamperHash().length());
        assertTrue(StatutoryDeductions.isCertificateIntact(cert));

        // a certificate whose figures were altered but whose hash was kept no longer verifies
        var tampered = new StatutoryDeductions.Certificate(cert.vendorId(), cert.month(), cert.type(),
                cert.basePaise(), cert.deductionPaise() - 1, cert.tamperHash());
        assertFalse(StatutoryDeductions.isCertificateIntact(tampered));
    }

    @Test
    void aCertificateSpansEverySegmentOfASplitMonth() {
        var s = configured();
        s.registerRate(new RateConfig(DeductionType.GST_TCS, 50, LocalDate.of(2026, 8, 16), "ADV-2026-09"));
        var lines = ok(s.compute(DeductionType.GST_TCS, augustAggregate(), new VendorTaxStatus("V1", true, true)));
        var cert = StatutoryDeductions.certificate("V1", AUG, DeductionType.GST_TCS, lines);
        assertEquals(1_00_000_00, cert.basePaise(), "the full month's base, across both segments");
        assertEquals(lines.stream().mapToLong(DeductionLine::amountPaise).sum(), cert.deductionPaise());
    }

    @Test
    void proportionHelperIsExactAtTheEndsAndRoundsHalfUp() {
        assertEquals(0, StatutoryDeductions.proportion(1000, 31, 0));
        assertEquals(1000, StatutoryDeductions.proportion(1000, 31, 31));
        assertEquals(1000, StatutoryDeductions.proportion(1000, 31, 40), "n beyond the denominator is capped");
        // a full sweep of deltas reconstructs the total exactly
        long total = 1_000_001L;
        long allocated = 0;
        long sum = 0;
        for (int day = 1; day <= 31; day++) {
            long cumulative = StatutoryDeductions.proportion(total, 31, day);
            sum += cumulative - allocated;
            allocated = cumulative;
        }
        assertEquals(total, sum);
    }
}
