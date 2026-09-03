package com.pixous.pixcart.identity.domain.auth;

import com.pixous.pixcart.identity.domain.auth.LoginPolicy.AccountState;
import com.pixous.pixcart.identity.domain.auth.LoginPolicy.Result;
import com.pixous.pixcart.identity.domain.auth.SessionRegistry.SensitiveAction;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-CUS-002 login/session and FR-CUS-003 MFA.
 *
 * The TOTP implementation is verified against the PUBLISHED TEST VECTORS in RFC 6238 Appendix B,
 * not against fixtures of our own. If the implementation drifts from the standard these tests
 * fail, which is the assurance a primitive guarding payout-account edits deserves.
 */
class AuthTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");

    // ================================================= RFC 6238 vectors

    /** RFC 6238 Appendix B seed for HMAC-SHA1: ASCII "12345678901234567890". */
    private static final String RFC_SECRET_BASE32 =
            Totp.encodeBase32("12345678901234567890".getBytes(java.nio.charset.StandardCharsets.US_ASCII));

    @Test
    void totpMatchesRfc6238AppendixBVectors() {
        // time (s) -> expected 8-digit SHA1 TOTP, straight from the RFC's table
        long[][] vectors = {
                {59L, 94287082L},
                {1111111109L, 7081804L},
                {1111111111L, 14050471L},
                {1234567890L, 89005924L},
                {2000000000L, 69279037L},
                {20000000000L, 65353130L},
        };
        for (long[] v : vectors) {
            String expected = String.format("%08d", v[1]);
            String actual = Totp.codeAt(RFC_SECRET_BASE32, Instant.ofEpochSecond(v[0]), 8, Duration.ofSeconds(30));
            assertEquals(expected, actual, "RFC 6238 vector at T=" + v[0]);
        }
    }

    @Test
    void sixDigitCodesAreTheLowSixDigitsOfTheRfcVectors() {
        // 94287082 -> 287082 ; the truncation modulus is the only difference
        assertEquals("287082", Totp.codeAt(RFC_SECRET_BASE32, Instant.ofEpochSecond(59)));
        assertEquals("081804", Totp.codeAt(RFC_SECRET_BASE32, Instant.ofEpochSecond(1111111109L)));
    }

    @Test
    void base32RoundTripsAndRejectsRubbish() {
        byte[] key = "12345678901234567890".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        assertArrayEquals(key, Totp.decodeBase32(Totp.encodeBase32(key)));
        assertEquals("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", RFC_SECRET_BASE32);
        assertThrows(IllegalArgumentException.class, () -> Totp.decodeBase32("0189!"));
    }

    @Test
    void verificationToleratesExactlyOneStepOfDrift() {
        String secret = Totp.newSecretBase32();
        Instant now = Instant.ofEpochSecond(1_780_000_000L);
        String current = Totp.codeAt(secret, now);
        String previous = Totp.codeAt(secret, now.minusSeconds(30));
        String next = Totp.codeAt(secret, now.plusSeconds(30));
        String twoBack = Totp.codeAt(secret, now.minusSeconds(60));

        assertTrue(Totp.verify(secret, current, now));
        assertTrue(Totp.verify(secret, previous, now), "one step behind is accepted");
        assertTrue(Totp.verify(secret, next, now), "one step ahead is accepted");
        assertFalse(Totp.verify(secret, twoBack, now), "two steps is outside the documented window");
    }

    @Test
    void malformedCodesAreRejectedWithoutThrowing() {
        String secret = Totp.newSecretBase32();
        assertFalse(Totp.verify(secret, null, T0));
        assertFalse(Totp.verify(secret, "12345", T0));
        assertFalse(Totp.verify(secret, "1234567", T0));
        assertFalse(Totp.verify(secret, "abcdef", T0));
    }

    @Test
    void provisioningUriCarriesTheEnrolmentParameters() {
        String uri = Totp.provisioningUri("Pixous PixCart", "harish@pixoustech.com", RFC_SECRET_BASE32);
        assertTrue(uri.startsWith("otpauth://totp/"));
        assertTrue(uri.contains("secret=" + RFC_SECRET_BASE32));
        assertTrue(uri.contains("digits=6"));
        assertTrue(uri.contains("period=30"));
        assertTrue(uri.contains("algorithm=SHA1"));
    }

    @Test
    void freshSecretsAre160BitAndDistinct() {
        String a = Totp.newSecretBase32();
        String b = Totp.newSecretBase32();
        assertNotEquals(a, b);
        assertEquals(20, Totp.decodeBase32(a).length);
    }

    // ================================================= FR-CUS-002 lockout

    @Test
    void progressiveLockoutDoublesAndCapsAtTwentyFourHours() {
        assertEquals(Duration.ofMinutes(15), LoginPolicy.lockDurationFor(1));
        assertEquals(Duration.ofMinutes(30), LoginPolicy.lockDurationFor(2));
        assertEquals(Duration.ofMinutes(60), LoginPolicy.lockDurationFor(3));
        assertEquals(Duration.ofMinutes(120), LoginPolicy.lockDurationFor(4));
        assertEquals(Duration.ofMinutes(240), LoginPolicy.lockDurationFor(5));
        assertEquals(Duration.ofMinutes(480), LoginPolicy.lockDurationFor(6));
        assertEquals(Duration.ofMinutes(960), LoginPolicy.lockDurationFor(7));
        assertEquals(Duration.ofHours(24), LoginPolicy.lockDurationFor(8), "capped");
        assertEquals(Duration.ofHours(24), LoginPolicy.lockDurationFor(50), "still capped");
        assertEquals(Duration.ZERO, LoginPolicy.lockDurationFor(0));
    }

    @Test
    void fiveFailuresLockForFifteenMinutesAndTheNextLockDoubles() {
        var p = new LoginPolicy();
        for (int i = 1; i <= 4; i++) {
            var r = assertInstanceOf(Result.BadCredentials.class,
                    p.attempt("harish@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", T0));
            assertEquals("E-AUTH-002", r.code());
            assertEquals(5 - i, r.attemptsRemaining());
        }
        var locked = assertInstanceOf(Result.Locked.class,
                p.attempt("harish@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", T0));
        assertEquals("E-AUTH-003", locked.code());
        assertEquals(T0.plus(Duration.ofMinutes(15)), locked.unlockAt());
        assertEquals("/auth/password/reset", locked.resetPath());

        // even a CORRECT credential is refused while the lock stands
        assertInstanceOf(Result.Locked.class,
                p.attempt("harish@pixoustech.com", true, AccountState.ACTIVE, true, false, "S1",
                        T0.plus(Duration.ofMinutes(5))));

        // after the lock lapses, five more failures produce a 30-minute lock
        Instant after = T0.plus(Duration.ofMinutes(16));
        for (int i = 0; i < 4; i++) {
            p.attempt("harish@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", after);
        }
        var second = assertInstanceOf(Result.Locked.class,
                p.attempt("harish@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", after));
        assertEquals(after.plus(Duration.ofMinutes(30)), second.unlockAt());
        assertEquals(2, p.lockCount("harish@pixoustech.com"));
    }

    @Test
    void unknownAccountAndWrongPasswordAreIndistinguishable_noEnumeration() {
        var p = new LoginPolicy();
        var unknown = p.attempt("nobody@example.com", false, AccountState.ACTIVE, false, false, "S1", T0);
        var wrongPw = p.attempt("harish@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", T0);

        var u = assertInstanceOf(Result.BadCredentials.class, unknown);
        var w = assertInstanceOf(Result.BadCredentials.class, wrongPw);
        assertEquals(u.code(), w.code(), "the same code must be returned");
        assertEquals(u.attemptsRemaining(), w.attemptsRemaining(), "and the same detail");
        assertEquals(u, w, "the two responses are wholly indistinguishable");
    }

    @Test
    void suspendedAndDeletedAccountsAreRefusedEvenWithCorrectCredentials() {
        var p = new LoginPolicy();
        var s = assertInstanceOf(Result.Suspended.class,
                p.attempt("x@pixoustech.com", true, AccountState.SUSPENDED, true, false, "S1", T0));
        assertEquals("E-AUTH-004", s.code());
        assertTrue(s.supportUrl().startsWith("https://support."));
        assertInstanceOf(Result.Suspended.class,
                p.attempt("y@pixoustech.com", true, AccountState.DELETED, true, false, "S1", T0));
    }

    @Test
    void successfulLoginClearsTheFailureStreakAndMfaInterceptsWhenEnabled() {
        var p = new LoginPolicy();
        p.attempt("a@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", T0);
        p.attempt("a@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", T0);
        assertEquals(new Result.Success("S1"),
                p.attempt("a@pixoustech.com", true, AccountState.ACTIVE, true, false, "S1", T0));
        // streak cleared: a fresh failure reports four remaining, not two
        var again = assertInstanceOf(Result.BadCredentials.class,
                p.attempt("a@pixoustech.com", true, AccountState.ACTIVE, false, false, "S1", T0));
        assertEquals(4, again.attemptsRemaining());

        var mfa = assertInstanceOf(Result.MfaRequired.class,
                p.attempt("b@pixoustech.com", true, AccountState.ACTIVE, true, true, "S9", T0));
        assertEquals("MFA-S9", mfa.challengeId());
    }

    @Test
    void clockSkewToleranceIsSixtySeconds() {
        assertTrue(LoginPolicy.isTimestampAcceptable(T0.minusSeconds(60), T0));
        assertTrue(LoginPolicy.isTimestampAcceptable(T0.plusSeconds(60), T0));
        assertFalse(LoginPolicy.isTimestampAcceptable(T0.minusSeconds(61), T0));
        assertFalse(LoginPolicy.isTimestampAcceptable(T0.plusSeconds(61), T0));
    }

    // ================================================= sessions

    @Test
    void concurrentSessionsAreCappedAtEightWithTheOldestEvicted() {
        var r = new SessionRegistry();
        for (int i = 1; i <= 8; i++) {
            var reg = r.register("CUS-1", "S" + i, "dev-" + i, "Device " + i, "1.2.3.4", "TN",
                    T0.plusSeconds(i));
            assertTrue(reg.evictedSessionIds().isEmpty(), "no eviction below the cap");
        }
        assertEquals(8, r.sessionsOf("CUS-1").size());

        var ninth = r.register("CUS-1", "S9", "dev-9", "Device 9", "1.2.3.4", "TN", T0.plusSeconds(9));
        assertEquals(List.of("S1"), ninth.evictedSessionIds(), "the oldest session is evicted");
        assertEquals(8, r.sessionsOf("CUS-1").size());
        assertFalse(r.isActive("S1"));
        assertTrue(r.isActive("S9"));
    }

    @Test
    void newDeviceIsFlaggedOnceThenRecognised() {
        var r = new SessionRegistry();
        assertTrue(r.register("CUS-1", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", T0).newDevice(),
                "a first sighting warrants a login notification");
        assertFalse(r.register("CUS-1", "S2", "dev-A", "Laptop", "1.1.1.1", "TN", T0.plusSeconds(1)).newDevice());
        assertTrue(r.register("CUS-1", "S3", "dev-B", "Phone", "2.2.2.2", "KA", T0.plusSeconds(2)).newDevice());
    }

    @Test
    void sessionsAreListableAndRevocablePerDevice() {
        var r = new SessionRegistry();
        r.register("CUS-1", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", T0);
        r.register("CUS-1", "S2", "dev-B", "Phone", "2.2.2.2", "KA", T0.plusSeconds(1));
        r.register("CUS-1", "S3", "dev-C", "Tablet", "3.3.3.3", "MH", T0.plusSeconds(2));

        assertEquals(3, r.sessionsOf("CUS-1").size());
        assertEquals("Phone", r.session("S2").orElseThrow().deviceLabel());
        assertTrue(r.revoke("S2"));
        assertFalse(r.revoke("S2"), "revoking twice is a no-op, not an error");
        assertEquals(2, r.sessionsOf("CUS-1").size());

        assertEquals(1, r.revokeAllExcept("CUS-1", "S1"));
        assertEquals(List.of("S1"), r.sessionsOf("CUS-1").stream().map(SessionRegistry.Session::sessionId).toList());
    }

    // ================================================= FR-CUS-003 step-up

    @Test
    void sensitiveActionsAlwaysForceStepUpExceptValueGatedPayment() {
        assertTrue(SessionRegistry.requiresStepUp(SensitiveAction.PAYOUT_ACCOUNT_EDIT, false, 0));
        assertTrue(SessionRegistry.requiresStepUp(SensitiveAction.PASSWORD_CHANGE, false, 0));
        assertTrue(SessionRegistry.requiresStepUp(SensitiveAction.MOBILE_CHANGE, false, 0));

        // a high-value payment forces step-up only from a NEW device, and only above ₹5,000
        assertTrue(SessionRegistry.requiresStepUp(SensitiveAction.HIGH_VALUE_PAYMENT, true, 5_000 * 100 + 1));
        assertFalse(SessionRegistry.requiresStepUp(SensitiveAction.HIGH_VALUE_PAYMENT, true, 5_000 * 100));
        assertFalse(SessionRegistry.requiresStepUp(SensitiveAction.HIGH_VALUE_PAYMENT, false, 50_00_000));
    }

    @Test
    void stepUpGrantIsBoundToActionSessionAndTenMinutes() {
        var r = new SessionRegistry();
        r.register("CUS-1", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", T0);
        r.register("CUS-1", "S2", "dev-B", "Phone", "2.2.2.2", "KA", T0);
        var grant = r.grantStepUp("G1", "S1", SensitiveAction.PASSWORD_CHANGE, T0);
        assertEquals(T0.plus(Duration.ofMinutes(10)), grant.expiresAt());

        assertTrue(r.isStepUpSatisfied("G1", "S1", SensitiveAction.PASSWORD_CHANGE, T0.plusSeconds(60)));
        // bound to the ACTION: a password-change grant cannot edit a payout account
        assertFalse(r.isStepUpSatisfied("G1", "S1", SensitiveAction.PAYOUT_ACCOUNT_EDIT, T0.plusSeconds(60)));
        // bound to the SESSION: it cannot be presented from the phone
        assertFalse(r.isStepUpSatisfied("G1", "S2", SensitiveAction.PASSWORD_CHANGE, T0.plusSeconds(60)));
        // and time-bound
        assertFalse(r.isStepUpSatisfied("G1", "S1", SensitiveAction.PASSWORD_CHANGE, T0.plus(Duration.ofMinutes(10))));
        assertFalse(r.isStepUpSatisfied("NOPE", "S1", SensitiveAction.PASSWORD_CHANGE, T0));
    }

    @Test
    void aGrantIsConsumedOnUseSoItCannotBeReplayed() {
        var r = new SessionRegistry();
        r.register("CUS-1", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", T0);
        r.grantStepUp("G1", "S1", SensitiveAction.PAYOUT_ACCOUNT_EDIT, T0);
        assertTrue(r.consumeStepUp("G1", "S1", SensitiveAction.PAYOUT_ACCOUNT_EDIT, T0.plusSeconds(30)));
        assertFalse(r.consumeStepUp("G1", "S1", SensitiveAction.PAYOUT_ACCOUNT_EDIT, T0.plusSeconds(31)),
                "a consumed grant is spent even inside its window");
    }

    @Test
    void revokingASessionKillsItsStepUpGrants() {
        var r = new SessionRegistry();
        r.register("CUS-1", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", T0);
        r.grantStepUp("G1", "S1", SensitiveAction.MOBILE_CHANGE, T0);
        r.revoke("S1");
        assertFalse(r.isStepUpSatisfied("G1", "S1", SensitiveAction.MOBILE_CHANGE, T0.plusSeconds(1)));
    }

    @Test
    void grantsCannotBeIssuedOnAnInactiveSession() {
        var r = new SessionRegistry();
        assertThrows(IllegalStateException.class,
                () -> r.grantStepUp("G1", "GHOST", SensitiveAction.PASSWORD_CHANGE, T0));
    }

    @Test
    void evictionAlsoClearsTheEvictedSessionsGrants() {
        var r = new SessionRegistry();
        for (int i = 1; i <= 8; i++) r.register("CUS-1", "S" + i, "dev-" + i, "D", "1.1.1.1", "TN", T0.plusSeconds(i));
        r.grantStepUp("G-OLD", "S1", SensitiveAction.PASSWORD_CHANGE, T0.plusSeconds(2));
        r.register("CUS-1", "S9", "dev-9", "D", "1.1.1.1", "TN", T0.plusSeconds(9));   // evicts S1
        assertFalse(r.isStepUpSatisfied("G-OLD", "S1", SensitiveAction.PASSWORD_CHANGE, T0.plusSeconds(10)));
    }

    // ================================================= recovery codes

    @Test
    void tenRecoveryCodesAreIssuedAndEachIsSingleUse() {
        var r = new SessionRegistry();
        var plain = new ArrayList<String>();
        for (int i = 0; i < 10; i++) plain.add("code-" + i);
        assertEquals(10, r.issueRecoveryCodes("CUS-1", plain).size());
        assertEquals(10, r.recoveryCodesRemaining("CUS-1"));

        assertTrue(r.redeemRecoveryCode("CUS-1", "code-3"));
        assertEquals(9, r.recoveryCodesRemaining("CUS-1"));
        assertFalse(r.redeemRecoveryCode("CUS-1", "code-3"), "single-use");
        assertFalse(r.redeemRecoveryCode("CUS-1", "not-a-code"));
        assertFalse(r.redeemRecoveryCode("CUS-UNKNOWN", "code-1"));
    }

    @Test
    void issuingTheWrongNumberOfCodesIsRefused() {
        var r = new SessionRegistry();
        assertThrows(IllegalArgumentException.class, () -> r.issueRecoveryCodes("CUS-1", List.of("a", "b")));
    }

    @Test
    void spendingEveryCodeForcesIdentityReverification() {
        var r = new SessionRegistry();
        var plain = new ArrayList<String>();
        for (int i = 0; i < 10; i++) plain.add("code-" + i);
        r.issueRecoveryCodes("CUS-1", plain);
        assertFalse(r.requiresIdentityReverification("CUS-1"));
        for (String c : plain) assertTrue(r.redeemRecoveryCode("CUS-1", c));
        assertEquals(0, r.recoveryCodesRemaining("CUS-1"));
        assertTrue(r.requiresIdentityReverification("CUS-1"));
    }
}
