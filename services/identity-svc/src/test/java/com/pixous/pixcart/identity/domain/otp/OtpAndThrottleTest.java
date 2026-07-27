package com.pixous.pixcart.identity.domain.otp;

import com.pixous.pixcart.identity.domain.throttle.SlidingWindowThrottle;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-CUS-001 / Vol.10 §10.3 acceptance as tests (TC-SEC-002 pattern):
 * 5-min TTL boundary, exactly 3 attempts, 30 s resend cool-down, 5 sends/hour budget,
 * and the Vol.7 §7.2 auth-endpoint limit of 20/min.
 */
class OtpAndThrottleTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");

    private static byte[] h(String code) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(code.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void threeWrongAttemptsExhaustTheChallenge() {
        var c = OtpChallenge.start("+919876543210", h("482913"), T0, OtpChallenge.Policy.STANDARD);

        var a1 = c.verify(h("000000"), T0.plusSeconds(10));
        assertEquals(new OtpChallenge.VerifyResult.Invalid(2), a1.result());

        var a2 = a1.state().verify(h("111111"), T0.plusSeconds(20));
        assertEquals(new OtpChallenge.VerifyResult.Invalid(1), a2.result());

        var a3 = a2.state().verify(h("222222"), T0.plusSeconds(30));
        assertInstanceOf(OtpChallenge.VerifyResult.Exhausted.class, a3.result());

        // even the CORRECT code is refused once exhausted — a fresh OTP is required
        var a4 = a3.state().verify(h("482913"), T0.plusSeconds(40));
        assertInstanceOf(OtpChallenge.VerifyResult.Exhausted.class, a4.result());
    }

    @Test
    void ttlIsFiveMinutesInclusive() {
        var c = OtpChallenge.start("+919876543210", h("482913"), T0, OtpChallenge.Policy.STANDARD);
        assertInstanceOf(OtpChallenge.VerifyResult.Ok.class,
                c.verify(h("482913"), T0.plus(Duration.ofMinutes(5))).result());

        var late = OtpChallenge.start("+919876543210", h("482913"), T0, OtpChallenge.Policy.STANDARD)
                .verify(h("482913"), T0.plus(Duration.ofMinutes(5)).plusMillis(1));
        assertInstanceOf(OtpChallenge.VerifyResult.Expired.class, late.result());
    }

    @Test
    void successConsumesTheChallengeExactlyOnce() {
        var c = OtpChallenge.start("+919876543210", h("482913"), T0, OtpChallenge.Policy.STANDARD);
        var ok = c.verify(h("482913"), T0.plusSeconds(60));
        assertInstanceOf(OtpChallenge.VerifyResult.Ok.class, ok.result());
        assertTrue(ok.state().isConsumed());
        assertInstanceOf(OtpChallenge.VerifyResult.AlreadyConsumed.class,
                ok.state().verify(h("482913"), T0.plusSeconds(61)).result());
    }

    @Test
    void resendOpensAtExactlyThirtySeconds() {
        var c = OtpChallenge.start("+919876543210", h("482913"), T0, OtpChallenge.Policy.STANDARD);
        assertFalse(c.canResend(T0.plusMillis(29_999)));
        assertTrue(c.canResend(T0.plusSeconds(30)));
    }

    @Test
    void fiveSendsPerHourSlidingWindow() {
        var t = new SlidingWindowThrottle(5, Duration.ofHours(1));
        for (int i = 0; i < 5; i++) assertTrue(t.tryAcquire(T0.plusSeconds(i)), "send " + (i + 1));
        assertFalse(t.tryAcquire(T0.plusSeconds(10)), "6th send inside the hour");
        assertFalse(t.tryAcquire(T0.plus(Duration.ofHours(1))), "still counted at exactly +1h");
        assertTrue(t.tryAcquire(T0.plus(Duration.ofHours(1)).plusMillis(1)), "window slid past first send");
    }

    @Test
    void authEndpointBudgetTwentyPerMinute() {
        var t = new SlidingWindowThrottle(20, Duration.ofMinutes(1));
        for (int i = 0; i < 20; i++) assertTrue(t.tryAcquire(T0.plusMillis(i)));
        assertFalse(t.tryAcquire(T0.plusSeconds(30)));
        assertEquals(0, t.available(T0.plusSeconds(30)));
    }
}
