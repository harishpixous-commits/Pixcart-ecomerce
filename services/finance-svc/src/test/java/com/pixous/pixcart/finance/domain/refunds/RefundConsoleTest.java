package com.pixous.pixcart.finance.domain.refunds;

import com.pixous.pixcart.finance.domain.refunds.RefundConsole.Destination;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.InitiatorRole;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.LineFacts;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.Origin;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.Reason;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.RejectCode;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.Remediation;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.Request;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.Result;
import com.pixous.pixcart.finance.domain.refunds.RefundConsole.State;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** FR-FIN-006 refund operations console. */
class RefundConsoleTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");

    /** A prepaid line: ₹5,000 captured, nothing refunded yet. */
    private static LineFacts prepaid() {
        return new LineFacts("L1", 5_000 * 100, 0, false);
    }

    private static Request req(long amountPaise, Reason reason, Origin origin, InitiatorRole role,
                               String initiatorId) {
        return new Request("RF-1", "SUB-1", "L1", amountPaise, reason, origin,
                Destination.ORIGINAL_INSTRUMENT, initiatorId, role, false, null, T0);
    }

    private static RefundConsole.Refund ok(Result r) {
        if (r instanceof Result.Rejected rej) throw new AssertionError("rejected: " + rej.violations());
        return ((Result.Ok) r).refund();
    }

    // ==================================================== amount caps

    @Test
    void refundCannotExceedWhatWasCaptured() {
        var c = new RefundConsole();
        var over = assertInstanceOf(Result.Rejected.class,
                c.initiate(req(5_000 * 100 + 1, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"),
                        prepaid()));
        assertTrue(over.violations().stream().anyMatch(v -> v.startsWith("AMOUNT_EXCEEDS_REFUNDABLE")));
        assertInstanceOf(Result.Ok.class,
                c.initiate(req(5_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"),
                        prepaid()));
    }

    @Test
    void priorRefundsReduceTheRefundableAmount() {
        var c = new RefundConsole();
        var partlyRefunded = new LineFacts("L1", 5_000 * 100, 4_000 * 100, false);
        var over = assertInstanceOf(Result.Rejected.class,
                c.initiate(req(1_001 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"),
                        partlyRefunded));
        assertTrue(over.violations().stream().anyMatch(v -> v.contains("100000")));
        assertInstanceOf(Result.Ok.class,
                c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"),
                        partlyRefunded));
    }

    @Test
    void nonPositiveAmountsAreRefused() {
        var c = new RefundConsole();
        assertInstanceOf(Result.Rejected.class,
                c.initiate(req(0, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
    }

    // ==================================================== duplicate guard

    @Test
    void aSecondRefundOnTheSameLineIsBlockedWhileTheFirstIsLive() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));

        var second = new Request("RF-2", "SUB-1", "L1", 1_000 * 100, Reason.QC_PASS_RETURN,
                Origin.AUTO_RETURN, Destination.ORIGINAL_INSTRUMENT, "SYS", InitiatorRole.SYSTEM, false, null, T0);
        var dup = assertInstanceOf(Result.Rejected.class, c.initiate(second, prepaid()));
        assertTrue(dup.violations().stream().anyMatch(v -> v.startsWith("DUPLICATE_REFUND_FOR_LINE")));
    }

    @Test
    void afterAFailureOrCancellationAFreshRefundOnTheLineIsAllowed() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        c.sendToGateway("RF-1", T0);
        c.recordFailure("RF-1", RejectCode.GATEWAY_TECHNICAL, T0.plusSeconds(10));

        var retry = new Request("RF-2", "SUB-1", "L1", 1_000 * 100, Reason.QC_PASS_RETURN,
                Origin.AUTO_RETURN, Destination.ORIGINAL_INSTRUMENT, "SYS", InitiatorRole.SYSTEM, false, null, T0);
        assertInstanceOf(Result.Ok.class, c.initiate(retry, prepaid()),
                "a failed refund must not permanently block the line");
    }

    // ==================================================== support policy matrix

    @Test
    void supportIsBoundedByAmountAndReason() {
        var c = new RefundConsole();
        // over the ₹2,000 cap
        var overCap = assertInstanceOf(Result.Rejected.class, c.initiate(
                req(2_000 * 100 + 1, Reason.DAMAGED_ON_DELIVERY, Origin.MANUAL_SUP, InitiatorRole.SUPPORT, "SUP-1"),
                prepaid()));
        assertTrue(overCap.violations().stream().anyMatch(v -> v.startsWith("SUPPORT_CAP_EXCEEDED")));

        // a reason outside the delivered-issue matrix
        var badReason = assertInstanceOf(Result.Rejected.class, c.initiate(
                req(500 * 100, Reason.PRICE_ADJUSTMENT, Origin.MANUAL_SUP, InitiatorRole.SUPPORT, "SUP-1"),
                prepaid()));
        assertTrue(badReason.violations().stream().anyMatch(v -> v.startsWith("SUPPORT_REASON_NOT_IN_POLICY_MATRIX")));

        // within both bounds
        assertInstanceOf(Result.Ok.class, c.initiate(
                req(2_000 * 100, Reason.WRONG_ITEM_DELIVERED, Origin.MANUAL_SUP, InitiatorRole.SUPPORT, "SUP-1"),
                prepaid()));
    }

    @Test
    void financeIsNotBoundedByTheSupportCap() {
        var c = new RefundConsole();
        var f = ok(c.initiate(
                req(4_000 * 100, Reason.PRICE_ADJUSTMENT, Origin.MANUAL_FIN, InitiatorRole.FINANCE, "FIN-1"),
                prepaid()));
        assertEquals(State.INITIATED, f.state(), "below the checker threshold, no second person needed");
    }

    @Test
    void everyDeliveredIssueReasonIsInTheSupportMatrixAndOthersAreNot() {
        assertTrue(Reason.DAMAGED_ON_DELIVERY.isDeliveredIssue());
        assertTrue(Reason.WRONG_ITEM_DELIVERED.isDeliveredIssue());
        assertTrue(Reason.MISSING_ITEM.isDeliveredIssue());
        assertTrue(Reason.NOT_AS_DESCRIBED.isDeliveredIssue());
        assertFalse(Reason.GOODWILL.isDeliveredIssue());
        assertFalse(Reason.PRICE_ADJUSTMENT.isDeliveredIssue());
        assertFalse(Reason.QC_PASS_RETURN.isDeliveredIssue());
    }

    // ==================================================== maker-checker

    @Test
    void aManualRefundAboveTenThousandWaitsForADifferentChecker() {
        var c = new RefundConsole();
        var facts = new LineFacts("L1", 50_000 * 100, 0, false);
        var f = ok(c.initiate(new Request("RF-1", "SUB-1", "L1", 10_000 * 100 + 1, Reason.PRICE_ADJUSTMENT,
                Origin.MANUAL_FIN, Destination.ORIGINAL_INSTRUMENT, "FIN-1", InitiatorRole.FINANCE, false, null, T0),
                facts));
        assertEquals(State.PENDING_CHECKER, f.state());

        // it cannot skip straight to the gateway
        assertInstanceOf(Result.Rejected.class, c.sendToGateway("RF-1", T0));

        // the maker cannot approve their own refund
        var selfApprove = assertInstanceOf(Result.Rejected.class, c.approve("RF-1", "FIN-1", T0));
        assertTrue(selfApprove.violations().contains("SOD_VIOLATION_CHECKER_EQUALS_MAKER"));

        var approved = ok(c.approve("RF-1", "FIN-2", T0.plusSeconds(60)));
        assertEquals(State.INITIATED, approved.state());
        assertEquals("FIN-2", approved.checkerId());
        assertInstanceOf(Result.Ok.class, c.sendToGateway("RF-1", T0.plusSeconds(70)));
    }

    @Test
    void exactlyAtTheThresholdNoCheckerIsRequired() {
        var c = new RefundConsole();
        var facts = new LineFacts("L1", 50_000 * 100, 0, false);
        var f = ok(c.initiate(new Request("RF-1", "SUB-1", "L1", 10_000 * 100, Reason.PRICE_ADJUSTMENT,
                Origin.MANUAL_FIN, Destination.ORIGINAL_INSTRUMENT, "FIN-1", InitiatorRole.FINANCE, false, null, T0),
                facts));
        assertEquals(State.INITIATED, f.state(), "the rule is ABOVE Rs 10,000, not at it");
    }

    @Test
    void anAutomaticReturnRefundNeedsNoCheckerAtAnyAmount() {
        var c = new RefundConsole();
        var facts = new LineFacts("L1", 50_000 * 100, 0, false);
        var f = ok(c.initiate(new Request("RF-1", "SUB-1", "L1", 40_000 * 100, Reason.QC_PASS_RETURN,
                Origin.AUTO_RETURN, Destination.ORIGINAL_INSTRUMENT, "SYS", InitiatorRole.SYSTEM, false, null, T0),
                facts));
        assertEquals(State.INITIATED, f.state(), "the return saga already decided this one is owed");
    }

    // ==================================================== COD & goodwill

    @Test
    void codRefundsRequireAVerifiedBeneficiaryAndCannotTargetTheOriginalInstrument() {
        var c = new RefundConsole();
        var cod = new LineFacts("L1", 3_000 * 100, 0, true);

        var toInstrument = assertInstanceOf(Result.Rejected.class, c.initiate(
                new Request("RF-1", "SUB-1", "L1", 1_000 * 100, Reason.DAMAGED_ON_DELIVERY, Origin.MANUAL_FIN,
                        Destination.ORIGINAL_INSTRUMENT, "FIN-1", InitiatorRole.FINANCE, false, null, T0), cod));
        assertTrue(toInstrument.violations().contains("COD_HAS_NO_ORIGINAL_INSTRUMENT"));
        assertTrue(toInstrument.violations().contains("COD_REFUND_REQUIRES_VERIFIED_BENEFICIARY"));

        var unverified = assertInstanceOf(Result.Rejected.class, c.initiate(
                new Request("RF-2", "SUB-1", "L1", 1_000 * 100, Reason.DAMAGED_ON_DELIVERY, Origin.MANUAL_FIN,
                        Destination.BANK_TRANSFER, "FIN-1", InitiatorRole.FINANCE, false, null, T0), cod));
        assertTrue(unverified.violations().contains("COD_REFUND_REQUIRES_VERIFIED_BENEFICIARY"));

        assertInstanceOf(Result.Ok.class, c.initiate(
                new Request("RF-3", "SUB-1", "L1", 1_000 * 100, Reason.DAMAGED_ON_DELIVERY, Origin.MANUAL_FIN,
                        Destination.BANK_TRANSFER, "FIN-1", InitiatorRole.FINANCE, true, null, T0), cod));
    }

    @Test
    void goodwillRefundsRequireEvidenceAndAreTaggedSeparately() {
        var c = new RefundConsole();
        var noEvidence = assertInstanceOf(Result.Rejected.class, c.initiate(
                new Request("RF-1", "SUB-1", "L1", 500 * 100, Reason.GOODWILL, Origin.GOODWILL,
                        Destination.WALLET, "FIN-1", InitiatorRole.FINANCE, false, null, T0), prepaid()));
        assertTrue(noEvidence.violations().contains("GOODWILL_REFUND_REQUIRES_EVIDENCE"));

        var f = ok(c.initiate(new Request("RF-2", "SUB-1", "L1", 500 * 100, Reason.GOODWILL, Origin.GOODWILL,
                Destination.WALLET, "FIN-1", InitiatorRole.FINANCE, false, "ticket://SUP-9912", T0), prepaid()));
        assertTrue(f.isGoodwill());
    }

    // ==================================================== gateway lifecycle

    @Test
    void aSuccessRequiresAnArnOrUtrProof() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        c.sendToGateway("RF-1", T0);
        assertInstanceOf(Result.Rejected.class, c.recordSuccess("RF-1", "  ", T0.plusSeconds(5)));
        var done = ok(c.recordSuccess("RF-1", "ARN-7734992001", T0.plusSeconds(5)));
        assertEquals(State.SUCCEEDED, done.state());
        assertEquals("ARN-7734992001", done.proofRef());
        // and a succeeded refund cannot be cancelled
        assertInstanceOf(Result.Rejected.class, c.cancel("RF-1", "FIN-1", "changed mind", T0.plusSeconds(60)));
    }

    @Test
    void rejectCodesMapToTheDocumentedRemediations() {
        assertEquals(Remediation.COLLECT_NEW_INSTRUMENT_DETAILS, RefundConsole.remediationFor(RejectCode.EXPIRED_INSTRUMENT));
        assertEquals(Remediation.COLLECT_NEW_INSTRUMENT_DETAILS, RefundConsole.remediationFor(RejectCode.ACCOUNT_CLOSED));
        assertEquals(Remediation.ROUTE_TO_WALLET_WITH_CONSENT, RefundConsole.remediationFor(RejectCode.INSTRUMENT_BLOCKED));
        assertEquals(Remediation.RETRY, RefundConsole.remediationFor(RejectCode.GATEWAY_TECHNICAL));
        assertEquals(Remediation.MANUAL_INVESTIGATION, RefundConsole.remediationFor(RejectCode.LIMIT_EXCEEDED));
        // every code has a mapping — an unmapped code would silently return null
        for (RejectCode code : RejectCode.values()) {
            assertNotNull(RefundConsole.remediationFor(code), code.name());
        }
    }

    @Test
    void aFailureRecordsItsCodeAndRemediationAndPermitsARetry() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        c.sendToGateway("RF-1", T0);
        var failed = ok(c.recordFailure("RF-1", RejectCode.EXPIRED_INSTRUMENT, T0.plusSeconds(10)));
        assertEquals(State.FAILED, failed.state());
        assertEquals(RejectCode.EXPIRED_INSTRUMENT, failed.lastRejectCode());
        assertTrue(failed.trail().stream().anyMatch(t -> t.contains("COLLECT_NEW_INSTRUMENT_DETAILS")));

        // a failed refund may be sent again, and the attempt count advances
        assertInstanceOf(Result.Ok.class, c.sendToGateway("RF-1", T0.plusSeconds(20)));
        assertEquals(2, c.refund("RF-1").orElseThrow().attempts());
    }

    @Test
    void gatewayTransitionsAreOrderedAndCannotBeSkipped() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        assertInstanceOf(Result.Rejected.class, c.recordSuccess("RF-1", "ARN-1", T0), "not sent yet");
        assertInstanceOf(Result.Rejected.class, c.recordFailure("RF-1", RejectCode.GATEWAY_TECHNICAL, T0));
        assertInstanceOf(Result.Rejected.class, c.approve("RF-1", "FIN-2", T0), "not pending a checker");
        assertInstanceOf(Result.Rejected.class, c.sendToGateway("NOPE", T0));
    }

    // ==================================================== SLA & escalation

    @Test
    void aRefundStuckBeyondSevenDaysEscalatesWithACustomerNotice() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        c.sendToGateway("RF-1", T0);

        assertFalse(c.isStuck("RF-1", T0.plus(Duration.ofDays(7))));
        assertTrue(c.isStuck("RF-1", T0.plus(Duration.ofDays(7)).plusSeconds(1)));
        assertInstanceOf(Result.Rejected.class, c.escalate("RF-1", T0.plus(Duration.ofDays(6))));

        var escalated = ok(c.escalate("RF-1", T0.plus(Duration.ofDays(8))));
        assertEquals(State.ESCALATED, escalated.state());
        assertTrue(escalated.trail().stream().anyMatch(t -> t.contains("customer notice")));
        assertFalse(c.isStuck("RF-1", T0.plus(Duration.ofDays(30))), "already escalated");
    }

    @Test
    void aSucceededRefundIsNeverStuck() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        c.sendToGateway("RF-1", T0);
        c.recordSuccess("RF-1", "ARN-1", T0.plusSeconds(5));
        assertFalse(c.isStuck("RF-1", T0.plus(Duration.ofDays(90))));
    }

    @Test
    void theTwentyFourHourInitiationSlaIsTrackedFromQcPass() {
        var c = new RefundConsole();
        ok(c.initiate(req(1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN, InitiatorRole.SYSTEM, "SYS"), prepaid()));
        assertFalse(c.isInitiationSlaBreached("RF-1", T0, T0.plus(Duration.ofHours(24))));
        assertTrue(c.isInitiationSlaBreached("RF-1", T0, T0.plus(Duration.ofHours(25))));
        // once sent to the gateway the initiation SLA no longer applies
        c.sendToGateway("RF-1", T0.plus(Duration.ofHours(2)));
        assertFalse(c.isInitiationSlaBreached("RF-1", T0, T0.plus(Duration.ofHours(48))));
    }

    // ==================================================== analytics

    @Test
    void analyticsSeparateGoodwillAndMeasureLeakage() {
        var c = new RefundConsole();
        var facts = new LineFacts("L1", 50_000 * 100, 0, false);

        // a return-driven refund: not leakage
        ok(c.initiate(new Request("RF-1", "SUB-1", "L1", 1_000 * 100, Reason.QC_PASS_RETURN, Origin.AUTO_RETURN,
                Destination.ORIGINAL_INSTRUMENT, "SYS", InitiatorRole.SYSTEM, false, null, T0), facts));
        c.sendToGateway("RF-1", T0);
        c.recordSuccess("RF-1", "ARN-1", T0);

        // a goodwill refund on another line: leakage, and separately tagged
        var facts2 = new LineFacts("L2", 50_000 * 100, 0, false);
        ok(c.initiate(new Request("RF-2", "SUB-1", "L2", 300 * 100, Reason.GOODWILL, Origin.GOODWILL,
                Destination.WALLET, "FIN-1", InitiatorRole.FINANCE, false, "ticket://X", T0), facts2));
        c.sendToGateway("RF-2", T0);
        c.recordSuccess("RF-2", "UTR-2", T0);

        // a damaged-on-delivery refund on a third line: leakage but not goodwill
        var facts3 = new LineFacts("L3", 50_000 * 100, 0, false);
        ok(c.initiate(new Request("RF-3", "SUB-1", "L3", 700 * 100, Reason.DAMAGED_ON_DELIVERY, Origin.MANUAL_SUP,
                Destination.ORIGINAL_INSTRUMENT, "SUP-1", InitiatorRole.SUPPORT, false, null, T0), facts3));
        c.sendToGateway("RF-3", T0);
        c.recordSuccess("RF-3", "ARN-3", T0);

        assertEquals(300 * 100, c.goodwillTotalPaise());
        assertEquals(1_000 * 100, c.leakagePaise(), "goodwill 300 + damaged 700, excluding the return");
        var byReason = c.succeededTotalsByReason();
        assertEquals(1_000 * 100, byReason.get(Reason.QC_PASS_RETURN));
        assertEquals(300 * 100, byReason.get(Reason.GOODWILL));
        assertEquals(700 * 100, byReason.get(Reason.DAMAGED_ON_DELIVERY));
    }

    @Test
    void queuesAreFilterableByState() {
        var c = new RefundConsole();
        var facts = new LineFacts("L1", 50_000 * 100, 0, false);
        ok(c.initiate(new Request("RF-1", "SUB-1", "L1", 20_000 * 100, Reason.PRICE_ADJUSTMENT, Origin.MANUAL_FIN,
                Destination.ORIGINAL_INSTRUMENT, "FIN-1", InitiatorRole.FINANCE, false, null, T0), facts));
        assertEquals(List.of("RF-1"), c.queue(State.PENDING_CHECKER).stream()
                .map(f -> f.request().refundId()).toList());
        assertTrue(c.queue(State.SUCCEEDED).isEmpty());
    }
}
