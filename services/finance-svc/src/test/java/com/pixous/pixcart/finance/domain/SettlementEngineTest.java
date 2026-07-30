package com.pixous.pixcart.finance.domain;

import com.pixous.pixcart.finance.domain.SettlementEngine.AccrualLine;
import com.pixous.pixcart.finance.domain.SettlementEngine.BatchResult;
import com.pixous.pixcart.finance.domain.SettlementEngine.Payout;
import com.pixous.pixcart.finance.domain.SettlementEngine.SettlementBatch;
import com.pixous.pixcart.finance.domain.SettlementEngine.VendorAccount;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** FR-FIN-004 acceptance & validation as tests, incl. the doc's Mon→Wed payout scenario. */
class SettlementEngineTest {

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    private static Instant delivered(LocalDate d) {
        return d.atStartOfDay(IST).toInstant().plusSeconds(3600);
    }

    private static Map<String, VendorAccount> verified(String... vendorIds) {
        var m = new java.util.LinkedHashMap<String, VendorAccount>();
        for (String v : vendorIds) m.put(v, new VendorAccount(v, "acct-" + v, true));
        return m;
    }

    // ------------------------------------------------- the acceptance scenario

    @Test
    void mondayDeliveriesOf100kPayOutExactlyOnceOnWednesday_withTraceableLines() {
        // Monday 2026-08-17; three Monday deliveries for vendor V1 summing to ₹1,00,000 net.
        LocalDate monday = LocalDate.of(2026, 8, 17);
        LocalDate wednesday = LocalDate.of(2026, 8, 19);   // T+2 business days
        var accruals = List.of(
                new AccrualLine("EVT-1", "V1", "SUB-1", 40_000_00, delivered(monday), false),
                new AccrualLine("EVT-2", "V1", "SUB-2", 35_000_00, delivered(monday), false),
                new AccrualLine("EVT-3", "V1", "SUB-3", 25_000_00, delivered(monday), false));

        var res = SettlementEngine.buildBatch("BATCH-W34", wednesday, accruals, verified("V1"), "maker-anu", "checker-bala");
        var batch = assertInstanceOf(BatchResult.Ok.class, res).batch();

        // exactly one payout, of exactly ₹1,00,000
        assertEquals(1, batch.payouts().size());
        Payout p = batch.payouts().get(0);
        assertEquals(1_00_000_00L, p.amountPaise());
        // statement line ids trace each order event
        assertEquals(List.of("EVT-1", "EVT-2", "EVT-3"), p.lineIds());
        // batch checksum = Σ payouts
        assertEquals(1_00_000_00L, batch.checksumPaise());

        // executing posts one payout with a UTR
        var exec = batch.execute((vendorId, amt, acct, idem) ->
                new SettlementBatch.PayoutGateway.Result(true, "UTR-" + idem, null));
        assertEquals(1, exec.outcomes().size());
        assertTrue(exec.outcomes().get(0).paid());
        assertEquals("UTR-BATCH-W34:V1", exec.outcomes().get(0).utr());
        assertEquals(1_00_000_00L, exec.paidTotalPaise());
    }

    // --------------------------------------------------------- BRU-09 timing

    @Test
    void tPlus2CountsBusinessDaysExcludingWeekend() {
        // Friday delivery settles Tuesday (Sat/Sun skipped), not Sunday.
        LocalDate friday = LocalDate.of(2026, 8, 14);
        var line = new AccrualLine("E", "V1", "S", 1000_00, delivered(friday), false);
        assertFalse(SettlementEngine.isEligible(line, LocalDate.of(2026, 8, 16)), "Sunday: 0 business days");
        assertFalse(SettlementEngine.isEligible(line, LocalDate.of(2026, 8, 17)), "Monday: 1 business day");
        assertTrue(SettlementEngine.isEligible(line, LocalDate.of(2026, 8, 18)), "Tuesday: 2 business days");
    }

    @Test
    void linesInsideTPlus2WindowAreNotYetEligible() {
        LocalDate mon = LocalDate.of(2026, 8, 17);
        var line = new AccrualLine("E", "V1", "S", 5000_00, delivered(mon), false);
        var res = SettlementEngine.buildBatch("B", LocalDate.of(2026, 8, 18), List.of(line),
                verified("V1"), "m", "c");                 // Tue = only 1 business day
        assertEquals(0, assertInstanceOf(BatchResult.Ok.class, res).batch().payouts().size());
    }

    // --------------------------------------------- validation & rule guards

    @Test
    void makerMustDifferFromChecker_sod() {
        var res = SettlementEngine.buildBatch("B", LocalDate.of(2026, 8, 19), List.of(), verified(), "same", "same");
        var inv = assertInstanceOf(BatchResult.Invalid.class, res);
        assertTrue(inv.reason().startsWith("SOD_VIOLATION"));
    }

    @Test
    void unverifiedAccountIsHeldNotPaid() {
        LocalDate mon = LocalDate.of(2026, 8, 17), wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(new AccrualLine("E", "V1", "S", 50_000_00, delivered(mon), false));
        var accounts = Map.of("V1", new VendorAccount("V1", "acct-V1", false)); // NOT penny-drop verified
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("B", wed, accruals, accounts, "m", "c")).batch();
        assertEquals(0, batch.payouts().size());
        assertEquals(List.of("V1"), batch.heldVendors());
        assertEquals(0, batch.checksumPaise());
    }

    @Test
    void disputedLinesAreFrozenButOthersStillSettle() {
        LocalDate mon = LocalDate.of(2026, 8, 17), wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(
                new AccrualLine("E1", "V1", "S1", 30_000_00, delivered(mon), false),
                new AccrualLine("E2", "V1", "S2", 20_000_00, delivered(mon), true));   // disputed → frozen
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("B", wed, accruals, verified("V1"), "m", "c")).batch();
        assertEquals(1, batch.payouts().size());
        assertEquals(30_000_00L, batch.payouts().get(0).amountPaise());               // only the undisputed line
        assertEquals(List.of("E1"), batch.payouts().get(0).lineIds());
    }

    @Test
    void multiVendorBatchNetsPerVendorAndChecksums() {
        LocalDate mon = LocalDate.of(2026, 8, 17), wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(
                new AccrualLine("E1", "V1", "S1", 10_000_00, delivered(mon), false),
                new AccrualLine("E2", "V1", "S2", 5_000_00, delivered(mon), false),
                new AccrualLine("E3", "V2", "S3", 7_500_00, delivered(mon), false));
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("B", wed, accruals, verified("V1", "V2"), "m", "c")).batch();
        assertEquals(2, batch.payouts().size());
        assertEquals(15_000_00L, batch.payouts().get(0).amountPaise()); // V1 netted
        assertEquals(7_500_00L, batch.payouts().get(1).amountPaise());  // V2
        assertEquals(22_500_00L, batch.checksumPaise());
    }

    // -------------------------------------------------- execution: retry/hold

    @Test
    void failedPayoutRetriesOnceThenHoldsWithReason_frVen011() {
        LocalDate mon = LocalDate.of(2026, 8, 17), wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(new AccrualLine("E", "V1", "S", 40_000_00, delivered(mon), false));
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("B", wed, accruals, verified("V1"), "m", "c")).batch();

        int[] calls = {0};
        var exec = batch.execute((vendorId, amt, acct, idem) -> {
            calls[0]++;
            return new SettlementBatch.PayoutGateway.Result(false, null, "bank timeout");
        });
        assertEquals(2, calls[0], "one call + one retry");
        var out = exec.outcomes().get(0);
        assertFalse(out.paid());
        assertEquals(2, out.attempts());
        assertTrue(out.heldReason().startsWith("PAYOUT_FAILED_HELD"));
        assertEquals(40_000_00L, exec.heldTotalPaise());
        assertEquals(0, exec.paidTotalPaise());
    }

    @Test
    void payoutSucceedsOnRetryAfterOneFailure() {
        LocalDate mon = LocalDate.of(2026, 8, 17), wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(new AccrualLine("E", "V1", "S", 40_000_00, delivered(mon), false));
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("B", wed, accruals, verified("V1"), "m", "c")).batch();

        int[] calls = {0};
        var exec = batch.execute((vendorId, amt, acct, idem) -> {
            calls[0]++;
            return calls[0] == 1
                    ? new SettlementBatch.PayoutGateway.Result(false, null, "transient")
                    : new SettlementBatch.PayoutGateway.Result(true, "UTR-OK", null);
        });
        assertTrue(exec.outcomes().get(0).paid());
        assertEquals(2, exec.outcomes().get(0).attempts());
        assertEquals(40_000_00L, exec.paidTotalPaise());
    }

    @Test
    void executeIdempotencyKeyIsBatchPlusVendor() {
        LocalDate mon = LocalDate.of(2026, 8, 17), wed = LocalDate.of(2026, 8, 19);
        var accruals = List.of(new AccrualLine("E", "V7", "S", 1000_00, delivered(mon), false));
        var batch = assertInstanceOf(BatchResult.Ok.class,
                SettlementEngine.buildBatch("BATCH-42", wed, accruals, verified("V7"), "m", "c")).batch();
        String[] seenKey = {null};
        batch.execute((vendorId, amt, acct, idem) -> {
            seenKey[0] = idem;
            return new SettlementBatch.PayoutGateway.Result(true, "UTR", null);
        });
        assertEquals("BATCH-42:V7", seenKey[0]);
    }
}
