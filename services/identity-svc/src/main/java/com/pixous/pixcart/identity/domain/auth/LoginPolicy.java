package com.pixous.pixcart.identity.domain.auth;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Login policy — FR-CUS-002.
 *
 * Normative source (Documentation Suite v1.0):
 *   RULES:      "Progressive lockout: 5 fails → 15-min lock, then doubling to 24 h cap;
 *                concurrent session limit 8 (oldest evicted); refresh reuse detection revokes
 *                the token family."
 *   VALIDATION: "account state must be Active (not Suspended/Deleted); clock-skew tolerance
 *                ±60 s."
 *   ERRORS:     "Bad credentials → generic E-AUTH-002 (no enumeration); locked → E-AUTH-003
 *                with unlock ETA and reset path; suspended → E-AUTH-004 with support link."
 *
 * Two things this class exists to get right:
 *
 *  - NO ENUMERATION. An unknown identifier and a wrong password return the SAME code
 *    (E-AUTH-002) with no distinguishing detail, so the endpoint cannot be used to discover
 *    which accounts exist. The tests assert the two responses are indistinguishable.
 *
 *  - PROGRESSIVE LOCKOUT that actually doubles: 15 min, 30, 60, 120, 240, 480, 960 and then
 *    capped at 24 h. A fixed lockout is trivially waited out; an uncapped one becomes a
 *    denial-of-service against the legitimate owner.
 */
public final class LoginPolicy {

    public static final int FAILS_BEFORE_LOCK = 5;
    public static final Duration BASE_LOCK = Duration.ofMinutes(15);
    public static final Duration MAX_LOCK = Duration.ofHours(24);
    /** VALIDATION: tolerance applied to externally-issued token timestamps. */
    public static final Duration CLOCK_SKEW_TOLERANCE = Duration.ofSeconds(60);

    public enum AccountState { ACTIVE, SUSPENDED, DELETED }

    /** Error codes exactly as the requirement names them. */
    public sealed interface Result {
        record Success(String sessionId) implements Result {}
        /** E-AUTH-002 — deliberately identical for unknown user and wrong credential. */
        record BadCredentials(String code, int attemptsRemaining) implements Result {}
        record Locked(String code, Instant unlockAt, String resetPath) implements Result {}
        record Suspended(String code, String supportUrl) implements Result {}
        record MfaRequired(String code, String challengeId) implements Result {}
    }

    /** Per-identifier failure state. Keyed by identifier, never by whether the account exists. */
    private static final class Attempts {
        int consecutiveFails;
        int lockCount;
        Instant lockedUntil;
    }

    private final Map<String, Attempts> attempts = new LinkedHashMap<>();

    /** The doubling ladder, capped. Lock n (1-based) lasts BASE × 2^(n-1), never beyond MAX. */
    public static Duration lockDurationFor(int lockCount) {
        if (lockCount < 1) return Duration.ZERO;
        long minutes = BASE_LOCK.toMinutes();
        for (int i = 1; i < lockCount; i++) {
            minutes *= 2;
            if (minutes >= MAX_LOCK.toMinutes()) return MAX_LOCK;
        }
        return Duration.ofMinutes(Math.min(minutes, MAX_LOCK.toMinutes()));
    }

    public boolean isLocked(String identifier, Instant now) {
        Attempts a = attempts.get(identifier);
        return a != null && a.lockedUntil != null && now.isBefore(a.lockedUntil);
    }

    public Instant unlockAt(String identifier) {
        Attempts a = attempts.get(identifier);
        return a == null ? null : a.lockedUntil;
    }

    /**
     * Attempt a login.
     *
     * @param accountExists whether the identifier resolves — used ONLY to decide success, never
     *                      to shape the failure response
     * @param credentialOk  whether the supplied credential verified
     */
    public Result attempt(String identifier, boolean accountExists, AccountState state,
                          boolean credentialOk, boolean mfaEnabled, String sessionId, Instant now) {
        Attempts a = attempts.computeIfAbsent(identifier, k -> new Attempts());

        // a live lock short-circuits everything, including a correct credential
        if (a.lockedUntil != null && now.isBefore(a.lockedUntil)) {
            return new Result.Locked("E-AUTH-003", a.lockedUntil, "/auth/password/reset");
        }
        if (a.lockedUntil != null) {                 // lock expired: clear the streak, keep the count
            a.lockedUntil = null;
            a.consecutiveFails = 0;
        }

        if (!accountExists || !credentialOk) {
            a.consecutiveFails++;
            if (a.consecutiveFails >= FAILS_BEFORE_LOCK) {
                a.lockCount++;
                a.lockedUntil = now.plus(lockDurationFor(a.lockCount));
                a.consecutiveFails = 0;
                return new Result.Locked("E-AUTH-003", a.lockedUntil, "/auth/password/reset");
            }
            // identical response whether or not the account exists
            return new Result.BadCredentials("E-AUTH-002", FAILS_BEFORE_LOCK - a.consecutiveFails);
        }

        // credential is good; now the account state decides
        if (state == AccountState.SUSPENDED || state == AccountState.DELETED) {
            return new Result.Suspended("E-AUTH-004", "https://support.pixoustech.com/account");
        }

        a.consecutiveFails = 0;
        a.lockCount = 0;
        if (mfaEnabled) return new Result.MfaRequired("E-AUTH-011", "MFA-" + sessionId);
        return new Result.Success(sessionId);
    }

    /** VALIDATION: clock-skew tolerance for social/JWKS-verified token timestamps. */
    public static boolean isTimestampAcceptable(Instant tokenIssuedAt, Instant now) {
        Duration delta = Duration.between(tokenIssuedAt, now).abs();
        return delta.compareTo(CLOCK_SKEW_TOLERANCE) <= 0;
    }

    /** For diagnostics/tests: how many lockouts an identifier has accumulated. */
    public int lockCount(String identifier) {
        Attempts a = attempts.get(identifier);
        return a == null ? 0 : a.lockCount;
    }

    /** The full documented ladder, exposed so the console can display it. */
    public static List<Duration> lockLadder(int steps) {
        var out = new ArrayList<Duration>();
        for (int i = 1; i <= steps; i++) out.add(lockDurationFor(i));
        return out;
    }
}
