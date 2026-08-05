package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.audit.AuditChain;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import com.pixous.pixcart.identity.domain.vendor.VendorLifecycle;
import com.pixous.pixcart.identity.domain.vendor.VendorLifecycle.RejectTemplate;
import com.pixous.pixcart.identity.domain.vendor.VendorLifecycle.State;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-ADM-003 vendor lifecycle and FR-ADM-002 user management. The fraud-flagged approval
 * acceptance scenario is proven end to end against the REAL Slice-14 AuditChain, so "both
 * actions appear in audit" is demonstrated rather than asserted.
 */
class AdminGovernanceTest {

    private static final Instant NOW = Instant.parse("2026-08-15T10:00:00Z");

    // ==================================================== FR-ADM-003

    @Test
    void cleanApplicationIsActivatedByASingleAdmin() {
        var v = new VendorLifecycle("01VEND0001");
        var r = v.approve("01ADM1", false, true, null, false, NOW);
        assertEquals(new VendorLifecycle.Outcome.Ok(State.ACTIVE), r);
        assertFalse(v.listingsFrozen());
        assertFalse(v.payoutsFrozen());
    }

    @Test
    void fraudFlaggedApplicationNeedsTwoPeople_acceptanceScenario() {
        // "Given a fraud-flagged application, When A approves, Then state stays
        //  Pending-Second-Approval until SA confirms, and both actions appear in audit."
        var v = new VendorLifecycle("01VEND0002");
        var first = v.approve("01ADM1", /*isSuperAdmin*/ false, true, null, /*fraudFlagged*/ true, NOW);
        assertEquals(new VendorLifecycle.Outcome.Ok(State.PENDING_SECOND_APPROVAL), first);
        assertEquals(State.PENDING_SECOND_APPROVAL, v.state(), "one admin cannot activate it");

        var second = v.confirmSecondApproval("01SUPERADM", NOW.plusSeconds(3600));
        assertEquals(new VendorLifecycle.Outcome.Ok(State.ACTIVE), second);

        // both actions are present in the lifecycle trail...
        var actions = v.auditTrail().stream().map(VendorLifecycle.Action::action).toList();
        assertEquals(java.util.List.of("APPROVE_FIRST", "APPROVE_SECOND"), actions);

        // ...and both survive into the tamper-evident audit chain
        var chain = new AuditChain();
        int i = 0;
        for (var a : v.auditTrail()) {
            chain.append(new AuditChain.Record(
                    "01AUDVEND000000000000000" + (char) ('A' + i++), "STAFF", a.actorId(),
                    a.action(), "VENDOR", "01VEND0002000000000000AA", null, a.detail(), null,
                    a.at().toEpochMilli()));
        }
        assertEquals(2, chain.entries().size());
        assertInstanceOf(AuditChain.Verification.Valid.class, chain.verify());
        var recorded = chain.entries().stream().map(e -> e.record().action()).toList();
        assertTrue(recorded.containsAll(java.util.List.of("APPROVE_FIRST", "APPROVE_SECOND")));
    }

    @Test
    void theSamePersonCannotBeBothApprovers() {
        var v = new VendorLifecycle("01VEND0003");
        v.approve("01ADM1", false, true, null, true, NOW);
        var same = assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                v.confirmSecondApproval("01ADM1", NOW.plusSeconds(60)));
        assertTrue(same.reason().contains("SOD_VIOLATION_SAME_APPROVER"));
        assertEquals(State.PENDING_SECOND_APPROVAL, v.state());
    }

    @Test
    void aSuperAdminMayApproveAFraudFlaggedApplicationOutright() {
        var v = new VendorLifecycle("01VEND0004");
        assertEquals(new VendorLifecycle.Outcome.Ok(State.ACTIVE),
                v.approve("01SUPERADM", true, true, null, true, NOW));
    }

    @Test
    void kycNotGreenNeedsADocumentedSuperAdminOverride() {
        var noOverride = new VendorLifecycle("01VEND0005");
        assertTrue(assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                noOverride.approve("01ADM1", false, false, null, false, NOW)).reason()
                .contains("KYC_NOT_GREEN_AND_NO_OVERRIDE"));

        var adminOverride = new VendorLifecycle("01VEND0006");
        assertTrue(assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                adminOverride.approve("01ADM1", false, false, "OVR-1", false, NOW)).reason()
                .contains("KYC_OVERRIDE_REQUIRES_SUPER_ADMIN"));

        var saOverride = new VendorLifecycle("01VEND0007");
        assertEquals(new VendorLifecycle.Outcome.Ok(State.ACTIVE),
                saOverride.approve("01SUPERADM", true, false, "OVR-1", false, NOW));
        assertTrue(saOverride.auditTrail().get(0).detail().contains("override=OVR-1"));
    }

    @Test
    void rejectionRequiresATemplateAndFraudRejectStartsA30DayCooldown() {
        var v = new VendorLifecycle("01VEND0008");
        assertTrue(assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                v.reject("01ADM1", null, "no", NOW)).reason().contains("REJECT_TEMPLATE_REQUIRED"));

        assertEquals(new VendorLifecycle.Outcome.Ok(State.REJECTED),
                v.reject("01ADM1", RejectTemplate.FRAUD_SIGNALS, "linked to a blocked account", NOW));
        assertFalse(v.mayReapply(NOW.plus(Duration.ofDays(29))));
        assertTrue(v.mayReapply(NOW.plus(Duration.ofDays(30))));

        // a non-fraud rejection carries no cooldown
        var w = new VendorLifecycle("01VEND0009");
        w.reject("01ADM1", RejectTemplate.KYC_DOCUMENTS_ILLEGIBLE, "rescan the GST certificate", NOW);
        assertTrue(w.mayReapply(NOW));
    }

    @Test
    void suspensionFreezesListingsAndPayoutsButPreservesOrderServicing() {
        var v = new VendorLifecycle("01VEND0010");
        v.approve("01ADM1", false, true, null, false, NOW);
        assertTrue(assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                v.suspend("01ADM1", "", NOW)).reason().contains("SUSPENSION_REASON_REQUIRED"));

        assertEquals(new VendorLifecycle.Outcome.Ok(State.SUSPENDED),
                v.suspend("01ADM1", "counterfeit complaints", NOW));
        assertTrue(v.listingsFrozen());
        assertTrue(v.payoutsFrozen());
        assertTrue(v.orderServicingRequired(), "the duty to service placed orders survives suspension");
    }

    @Test
    void restrictionFreezesListingsButNotPayouts() {
        var v = new VendorLifecycle("01VEND0011");
        v.approve("01ADM1", false, true, null, false, NOW);
        v.restrict("01ADM1", "late dispatch rate", NOW);
        assertEquals(State.RESTRICTED, v.state());
        assertTrue(v.listingsFrozen());
        assertFalse(v.payoutsFrozen());
        // and reinstatement clears both
        v.reinstate("01ADM1", NOW.plusSeconds(60));
        assertEquals(State.ACTIVE, v.state());
        assertFalse(v.listingsFrozen());
    }

    @Test
    void offBoardingIsRefusedWhileAnyObligationRemains() {
        var v = new VendorLifecycle("01VEND0012");
        v.approve("01ADM1", false, true, null, false, NOW);

        var openOrders = assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                v.offBoard("01ADM1", 0, 0, 3, NOW));
        assertTrue(openOrders.reason().contains("OPEN_ORDERS=3"));

        var payable = assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                v.offBoard("01ADM1", 50_000, 0, 0, NOW));
        assertTrue(payable.reason().contains("UNSETTLED_PAYABLE"));

        var recovery = assertInstanceOf(VendorLifecycle.Outcome.Rejected.class,
                v.offBoard("01ADM1", 0, 12_000, 0, NOW));
        assertTrue(recovery.reason().contains("UNRECOVERED_BALANCE"));

        // financially clear and nothing to service → off-board succeeds
        assertEquals(new VendorLifecycle.Outcome.Ok(State.OFF_BOARDED), v.offBoard("01ADM1", 0, 0, 0, NOW));
        assertFalse(v.orderServicingRequired());
    }

    @Test
    void aRejectedApplicationCannotBeOffBoardedOrSuspended() {
        var v = new VendorLifecycle("01VEND0013");
        v.reject("01ADM1", RejectTemplate.DUPLICATE_APPLICATION, null, NOW);
        assertInstanceOf(VendorLifecycle.Outcome.Rejected.class, v.offBoard("01ADM1", 0, 0, 0, NOW));
        assertInstanceOf(VendorLifecycle.Outcome.Rejected.class, v.suspend("01ADM1", "reason", NOW));
    }

    // ==================================================== FR-ADM-002

    @Test
    void piiIsMaskedByDefault() {
        assertEquals("h*****@pixoustech.com", UserAdministration.maskEmail("harish@pixoustech.com"));
        assertEquals("***@x.com", UserAdministration.maskEmail("@x.com"));
        assertEquals("***", UserAdministration.maskEmail("not-an-email"));
        String masked = UserAdministration.maskMobile("+919876543210");
        assertTrue(masked.startsWith("+91") && masked.endsWith("10"));
        assertFalse(masked.contains("98765"), "the middle digits must not survive masking");
    }

    @Test
    void revealRequiresAdminCapabilityAndAJustification() {
        var wrongRole = UserAdministration.revealPii(Rbac.Role.MARKETING, "01MKT", "01CUS",
                "email", "harish@pixoustech.com", "support escalation 12345");
        assertTrue(assertInstanceOf(UserAdministration.Outcome.Rejected.class, wrongRole).reason()
                .contains("ROLE_MAY_NOT_ADMINISTER_USERS"));

        var noReason = UserAdministration.revealPii(Rbac.Role.SUPER_ADMIN, "01SA", "01CUS",
                "email", "harish@pixoustech.com", "n/a");
        assertTrue(assertInstanceOf(UserAdministration.Outcome.Rejected.class, noReason).reason()
                .contains("REVEAL_JUSTIFICATION_REQUIRED"));

        var ok = assertInstanceOf(UserAdministration.Outcome.Ok.class,
                UserAdministration.revealPii(Rbac.Role.SUPER_ADMIN, "01SA", "01CUS",
                        "email", "harish@pixoustech.com", "fraud case FR-9021 verification"));
        // the reveal carries its own audit entry — an unaudited reveal is not expressible
        assertTrue(ok.detail().contains("audit=PII_REVEAL"));
        assertTrue(ok.detail().contains("reason=fraud case FR-9021 verification"));
    }

    @Test
    void adHocCustomerDeletionIsForbidden() {
        var r = assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.deleteCustomerAdHoc("01CUS"));
        assertTrue(r.reason().contains("USE_PRIVACY_WORKFLOW"));
    }

    @Test
    void suspensionAndMfaResetHaveMandatoryGuards() {
        assertInstanceOf(UserAdministration.Outcome.Rejected.class, UserAdministration.suspendUser("01CUS", ""));
        assertInstanceOf(UserAdministration.Outcome.Ok.class,
                UserAdministration.suspendUser("01CUS", "chargeback abuse"));

        assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.resetMfa("01STF", false, "01SA"));
        assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.resetMfa("01STF", true, null));
        assertInstanceOf(UserAdministration.Outcome.Ok.class,
                UserAdministration.resetMfa("01STF", true, "01SA"));
    }

    @Test
    void staffEmailMustBeOnTheDomainAllowList() {
        Set<String> allowed = Set.of("pixoustech.com");
        assertInstanceOf(UserAdministration.Outcome.Ok.class,
                UserAdministration.createStaff("ops@pixoustech.com", Rbac.Role.SUPPORT, allowed));
        assertTrue(assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.createStaff("ops@gmail.com", Rbac.Role.SUPPORT, allowed)).reason()
                .contains("EMAIL_DOMAIN_NOT_ALLOWED"));
        assertTrue(assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.createStaff("cust@pixoustech.com", Rbac.Role.CUSTOMER, allowed)).reason()
                .contains("NOT_A_STAFF_ROLE"));
    }

    @Test
    void staffDormantSixtyDaysAreAutoDisabled() {
        assertFalse(UserAdministration.isDormant(NOW.minus(Duration.ofDays(59)), NOW));
        assertTrue(UserAdministration.isDormant(NOW.minus(Duration.ofDays(61)), NOW));
        assertTrue(UserAdministration.isDormant(null, NOW), "never logged in counts as dormant");
        assertEquals(UserAdministration.UserState.DISABLED, UserAdministration.applyDormancy(
                UserAdministration.UserState.ACTIVE, NOW.minus(Duration.ofDays(61)), NOW));
        assertEquals(UserAdministration.UserState.ACTIVE, UserAdministration.applyDormancy(
                UserAdministration.UserState.ACTIVE, NOW.minus(Duration.ofDays(10)), NOW));
        // a suspended account is not silently promoted to DISABLED semantics
        assertEquals(UserAdministration.UserState.SUSPENDED, UserAdministration.applyDormancy(
                UserAdministration.UserState.SUSPENDED, NOW.minus(Duration.ofDays(90)), NOW));
    }

    @Test
    void separationOfDutiesBlocksSettlementApproverPlusRefundInitiator() {
        // FINANCE holds FULL settlement payouts AND full refund initiation per Vol.2 §2.4,
        // so it is self-conflicting — the console must surface that.
        assertTrue(UserAdministration.selfConflictingRoles().contains(Rbac.Role.FINANCE));

        // combining a settlement approver with a refund initiator is refused
        assertTrue(assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.assignRoles("01STF", Set.of(Rbac.Role.FINANCE, Rbac.Role.SUPPORT))).reason()
                .contains("SOD_CONFLICT"));

        // a role set with neither settlement-approval nor refunds is fine
        assertInstanceOf(UserAdministration.Outcome.Ok.class,
                UserAdministration.assignRoles("01STF", Set.of(Rbac.Role.WAREHOUSE)));
        assertInstanceOf(UserAdministration.Outcome.Rejected.class,
                UserAdministration.assignRoles("01STF", Set.of()));
    }
}
