package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.identity.domain.admin.SecurityAdministration.BreakGlassResult;
import com.pixous.pixcart.identity.domain.admin.SecurityAdministration.Decision;
import com.pixous.pixcart.identity.domain.admin.SystemSettings.KeySpec;
import com.pixous.pixcart.identity.domain.admin.SystemSettings.Outcome;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** FR-ADM-014 system settings and FR-ADM-017 security administration. */
class PlatformAdministrationTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");
    private static final Map<String, Object> DEPS = Map.of("otherEnabledPaymentMethods", 2);

    private static SystemSettings settings() {
        return new SystemSettings()
                .register(KeySpec.intKey("fashion.return.window.days", true, 0, 90))
                .register(KeySpec.intKey("checkout.cod.cap.paise", true, 0, null))
                .register(KeySpec.flag("feature.voice.search"))
                .register(KeySpec.listKey("payment.methods.enabled", true))
                .register(new KeySpec("payment.method.upi.enabled", SystemSettings.ValueType.BOOLEAN,
                        true, false, null, null));
    }

    // ==================================================== FR-ADM-014

    @Test
    void returnWindowChangeAcceptanceScenario() {
        // "Given return-window changed 7->10 days for Fashion, When saved, Then new orders show
        //  10 days while existing orders keep their originally promised window."
        var s = settings();
        assertInstanceOf(Outcome.Ok.class, s.set("fashion.return.window.days", 7, T0,
                "initial fashion policy", "01ADM1", "01ADM2", true, DEPS));

        Instant changeAt = T0.plus(Duration.ofDays(30));
        assertInstanceOf(Outcome.Ok.class, s.set("fashion.return.window.days", 10, changeAt,
                "extend fashion returns to 10 days", "01ADM1", "01ADM2", true, DEPS));

        // an order placed BEFORE the change resolves 7 — its promise is intact for ever
        Instant existingOrderPlacedAt = T0.plus(Duration.ofDays(5));
        assertEquals(7, s.intAt("fashion.return.window.days", existingOrderPlacedAt).orElseThrow());

        // an order placed after the change resolves 10
        Instant newOrderPlacedAt = changeAt.plus(Duration.ofMinutes(1));
        assertEquals(10, s.intAt("fashion.return.window.days", newOrderPlacedAt).orElseThrow());

        // and nothing mutated the historical answer: re-asking later still yields 7
        assertEquals(7, s.intAt("fashion.return.window.days", existingOrderPlacedAt).orElseThrow());
    }

    @Test
    void criticalKeysRequireAChangeNoteAndASecondPersonInProduction() {
        var s = settings();
        var noNote = assertInstanceOf(Outcome.Rejected.class, s.set("fashion.return.window.days", 10, T0,
                "x", "01ADM1", "01ADM2", true, DEPS));
        assertTrue(noNote.violations().contains("CHANGE_NOTE_REQUIRED"));

        var noReviewer = assertInstanceOf(Outcome.Rejected.class, s.set("fashion.return.window.days", 10, T0,
                "extend window", "01ADM1", null, true, DEPS));
        assertTrue(noReviewer.violations().contains("CRITICAL_KEY_REQUIRES_SECOND_PERSON_REVIEW"));

        var selfReview = assertInstanceOf(Outcome.Rejected.class, s.set("fashion.return.window.days", 10, T0,
                "extend window", "01ADM1", "01ADM1", true, DEPS));
        assertTrue(selfReview.violations().contains("REVIEWER_MUST_DIFFER_FROM_AUTHOR"));

        // outside production the second person is not demanded
        assertInstanceOf(Outcome.Ok.class, s.set("fashion.return.window.days", 10, T0,
                "extend window in staging", "01ADM1", null, false, DEPS));
    }

    @Test
    void featureFlagsDefaultOffOnCreate() {
        var s = settings();
        assertFalse(s.flagAt("feature.voice.search", T0), "a newly created flag must be off");
        assertInstanceOf(Outcome.Ok.class, s.set("feature.voice.search", Boolean.TRUE, T0,
                "enable voice search pilot", "01ADM1", null, true, DEPS));
        assertTrue(s.flagAt("feature.voice.search", T0.plusSeconds(1)));
    }

    @Test
    void guardRulesAreEnforcedAtSave() {
        var s = settings();
        var codTooHigh = assertInstanceOf(Outcome.Rejected.class, s.set("checkout.cod.cap.paise",
                50_001 * 100, T0, "raise cod cap", "01ADM1", "01ADM2", true, DEPS));
        assertTrue(codTooHigh.violations().stream().anyMatch(x -> x.startsWith("COD_CAP_EXCEEDS_50K")));
        assertInstanceOf(Outcome.Ok.class, s.set("checkout.cod.cap.paise", 50_000 * 100, T0,
                "set cod cap at the ceiling", "01ADM1", "01ADM2", true, DEPS));

        var windowTooLong = assertInstanceOf(Outcome.Rejected.class, s.set("fashion.return.window.days",
                120, T0, "very long window", "01ADM1", "01ADM2", true, DEPS));
        // both the schema max and the guard rule fire — the operator sees every reason
        assertTrue(windowTooLong.violations().stream().anyMatch(x -> x.startsWith("ABOVE_MAX")));
        assertTrue(windowTooLong.violations().stream().anyMatch(x -> x.contains("RETURN_WINDOW_EXCEEDS_90_DAYS")));
    }

    @Test
    void typeMismatchIsRejected() {
        var s = settings();
        var bad = assertInstanceOf(Outcome.Rejected.class, s.set("fashion.return.window.days",
                "ten", T0, "wrong type on purpose", "01ADM1", "01ADM2", true, DEPS));
        assertTrue(bad.violations().stream().anyMatch(x -> x.startsWith("TYPE_MISMATCH")));
        assertInstanceOf(Outcome.Rejected.class, s.set("no.such.key", 1, T0, "note here",
                "01ADM1", "01ADM2", true, DEPS));
    }

    @Test
    void dependencyChecksBlockDisablingTheLastPaymentMethod() {
        var s = settings();
        var emptyList = assertInstanceOf(Outcome.Rejected.class, s.set("payment.methods.enabled",
                List.of(), T0, "disable everything", "01ADM1", "01ADM2", true, DEPS));
        assertTrue(emptyList.violations().contains("CANNOT_DISABLE_ALL_PAYMENT_METHODS"));

        var lastOne = assertInstanceOf(Outcome.Rejected.class, s.set("payment.method.upi.enabled",
                Boolean.FALSE, T0, "disable upi", "01ADM1", "01ADM2", true,
                Map.of("otherEnabledPaymentMethods", 0)));
        assertTrue(lastOne.violations().contains("CANNOT_DISABLE_LAST_PAYMENT_METHOD"));

        // with another method still live, disabling one is fine
        assertInstanceOf(Outcome.Ok.class, s.set("payment.method.upi.enabled", Boolean.FALSE, T0,
                "disable upi temporarily", "01ADM1", "01ADM2", true, Map.of("otherEnabledPaymentMethods", 3)));
    }

    @Test
    void rollbackReAssertsAPriorValueAsANewVersion() {
        var s = settings();
        s.set("fashion.return.window.days", 7, T0, "initial policy", "01ADM1", "01ADM2", true, DEPS);
        s.set("fashion.return.window.days", 10, T0.plus(Duration.ofDays(1)), "extend", "01ADM1", "01ADM2", true, DEPS);
        assertEquals(2, s.history("fashion.return.window.days").size());

        assertInstanceOf(Outcome.Ok.class, s.rollbackTo("fashion.return.window.days", 0,
                T0.plus(Duration.ofDays(2)), "01ADM1", "01ADM2", true));
        assertEquals(3, s.history("fashion.return.window.days").size(), "history is append-only");
        assertEquals(7, s.intAt("fashion.return.window.days", T0.plus(Duration.ofDays(3))).orElseThrow());
        // the intermediate value is still resolvable at its own moment in time
        assertEquals(10, s.intAt("fashion.return.window.days", T0.plus(Duration.ofDays(1))).orElseThrow());
    }

    // ==================================================== FR-ADM-017

    @Test
    void cidrMatchingIsCorrect() {
        assertTrue(SecurityAdministration.cidrContains("203.0.113.0/24", "203.0.113.45"));
        assertFalse(SecurityAdministration.cidrContains("203.0.113.0/24", "203.0.114.45"));
        assertTrue(SecurityAdministration.cidrContains("10.0.0.0/8", "10.255.255.254"));
        assertTrue(SecurityAdministration.cidrContains("0.0.0.0/0", "8.8.8.8"));
        assertTrue(SecurityAdministration.cidrContains("192.168.1.7/32", "192.168.1.7"));
        assertFalse(SecurityAdministration.cidrContains("192.168.1.7/32", "192.168.1.8"));
        assertFalse(SecurityAdministration.cidrContains("not-a-cidr", "1.2.3.4"));
        assertFalse(SecurityAdministration.cidrContains("10.0.0.0/8", "999.1.1.1"));
    }

    @Test
    void consoleAccessNeedsBothAllowListedCidrAndMfa() {
        var allow = List.of("203.0.113.0/24", "10.0.0.0/8");

        assertInstanceOf(Decision.Allowed.class,
                SecurityAdministration.mayAccessConsole("203.0.113.9", allow, true));

        var offNet = assertInstanceOf(Decision.Denied.class,
                SecurityAdministration.mayAccessConsole("198.51.100.7", allow, true));
        assertTrue(offNet.reason().startsWith("SOURCE_IP_NOT_ALLOW_LISTED"));

        var noMfa = assertInstanceOf(Decision.Denied.class,
                SecurityAdministration.mayAccessConsole("203.0.113.9", allow, false));
        assertEquals("MFA_REQUIRED_FOR_CONSOLE", noMfa.reason());

        // neither condition alone is sufficient
        assertInstanceOf(Decision.Denied.class,
                SecurityAdministration.mayAccessConsole("198.51.100.7", allow, false));
    }

    @Test
    void privilegedRolesCannotOptOutOfMfa() {
        Set<Rbac.Role> optional = Set.of(Rbac.Role.SUPER_ADMIN, Rbac.Role.ADMIN, Rbac.Role.FINANCE, Rbac.Role.SUPPORT);
        assertTrue(SecurityAdministration.mfaRequiredFor(Rbac.Role.SUPER_ADMIN, optional));
        assertTrue(SecurityAdministration.mfaRequiredFor(Rbac.Role.ADMIN, optional));
        assertTrue(SecurityAdministration.mfaRequiredFor(Rbac.Role.FINANCE, optional));
        // a non-privileged role may be exempted by configuration
        assertFalse(SecurityAdministration.mfaRequiredFor(Rbac.Role.SUPPORT, optional));
        assertTrue(SecurityAdministration.mfaRequiredFor(Rbac.Role.SUPPORT, Set.of()));
    }

    @Test
    void breakGlassRequiresTwoDistinctCustodiansAndSchedulesItsOwnReview() {
        assertTrue(assertInstanceOf(BreakGlassResult.Refused.class, SecurityAdministration.openBreakGlass(
                "BG-1", "01SA1", null, "production outage recovery", T0)).reason()
                .contains("DUAL_CUSTODY_REQUIRES_TWO_CUSTODIANS"));

        assertTrue(assertInstanceOf(BreakGlassResult.Refused.class, SecurityAdministration.openBreakGlass(
                "BG-1", "01SA1", "01SA1", "production outage recovery", T0)).reason()
                .contains("CUSTODIANS_MUST_BE_DISTINCT"));

        assertTrue(assertInstanceOf(BreakGlassResult.Refused.class, SecurityAdministration.openBreakGlass(
                "BG-1", "01SA1", "01SA2", "oops", T0)).reason().contains("JUSTIFICATION_REQUIRED"));

        var opened = assertInstanceOf(BreakGlassResult.Opened.class, SecurityAdministration.openBreakGlass(
                "BG-1", "01SA1", "01SA2", "payment gateway outage, manual settlement required", T0));
        var session = opened.session();
        assertEquals(T0.plus(Duration.ofHours(24)), session.autoReviewDueAt());
        assertFalse(SecurityAdministration.isBreakGlassReviewOverdue(session, T0.plus(Duration.ofHours(23))));
        assertTrue(SecurityAdministration.isBreakGlassReviewOverdue(session, T0.plus(Duration.ofHours(25))));
    }

    @Test
    void permissionChangePreviewsItsBlastRadius() {
        var preview = SecurityAdministration.previewPermissionChange(
                Rbac.Role.FINANCE, Rbac.Capability.SETTLEMENT_PAYOUTS, Rbac.Access.NONE, 14);
        assertEquals(Rbac.Access.FULL, preview.from());
        assertEquals(Rbac.Access.NONE, preview.to());
        assertEquals(14, preview.affectedUsers());
        assertTrue(preview.removesAccess());

        var grant = SecurityAdministration.previewPermissionChange(
                Rbac.Role.SUPPORT, Rbac.Capability.AUDIT_LOG_VIEW, Rbac.Access.READ, 30);
        assertEquals(Rbac.Access.NONE, grant.from());
        assertFalse(grant.removesAccess());
    }

    @Test
    void theLastSuperAdminCannotBeRemoved() {
        assertInstanceOf(Decision.Denied.class, SecurityAdministration.mayRemoveSuperAdmin(1));
        assertInstanceOf(Decision.Denied.class, SecurityAdministration.mayRemoveSuperAdmin(0));
        assertInstanceOf(Decision.Allowed.class, SecurityAdministration.mayRemoveSuperAdmin(2));
    }

    @Test
    void sodRulesetIsVersionedAndDetectsConflicts() {
        var ruleset = SecurityAdministration.defaultRuleset(T0);
        assertEquals(1, ruleset.version());
        assertEquals(2, ruleset.rules().size());

        // FINANCE holds settlement payouts and refund initiation → SOD-01 fires
        assertTrue(ruleset.conflictsFor(Set.of(Rbac.Role.FINANCE)).contains("SOD-01"));
        // WAREHOUSE holds neither half of either rule
        assertTrue(ruleset.conflictsFor(Set.of(Rbac.Role.WAREHOUSE)).isEmpty());
        // SUPER_ADMIN holds everything, so both rules fire — visible rather than hidden
        assertEquals(2, ruleset.conflictsFor(Set.of(Rbac.Role.SUPER_ADMIN)).size());
    }
}
