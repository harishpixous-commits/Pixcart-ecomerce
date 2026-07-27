package com.pixous.pixcart.identity.domain.otp;

import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;

/**
 * OTP challenge state machine.
 *
 * Normative source (Documentation Suite v1.0):
 *   FR-CUS-001 validation:  "OTP 6 digits, 3 attempts, 5-min TTL"
 *   FR-CUS-001 errors:      "resend with 30 s cool-down (max 5/hour/number)"
 *   Vol. 10 §10.3 OTP row:  "6-digit CSPRNG, 5-min TTL, 3 attempts, per-number+IP+device budgets"
 *
 * The domain holds only the HASH of the code (generation, hashing and delivery are
 * adapter concerns); comparison is constant-time. Instances are immutable — every
 * verification returns the successor state plus the outcome, so persistence is a
 * plain save of the returned state (optimistic-locked by row_version at the adapter).
 */
public final class OtpChallenge {

    /** Policy constants; {@link #STANDARD} carries the document's normative values. */
    public record Policy(Duration ttl, int maxAttempts, Duration resendCooldown, int maxSendsPerHour) {
        public static final Policy STANDARD =
                new Policy(Duration.ofMinutes(5), 3, Duration.ofSeconds(30), 5);

        public Policy {
            if (ttl.isNegative() || ttl.isZero()) throw new IllegalArgumentException("ttl");
            if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts");
            if (resendCooldown.isNegative()) throw new IllegalArgumentException("resendCooldown");
            if (maxSendsPerHour < 1) throw new IllegalArgumentException("maxSendsPerHour");
        }
    }

    /** Outcome of one verification attempt (E-AUTH-001 carries attemptsRemaining). */
    public sealed interface VerifyResult {
        record Ok() implements VerifyResult {}
        record Invalid(int attemptsRemaining) implements VerifyResult {}
        record Expired() implements VerifyResult {}
        record Exhausted() implements VerifyResult {}
        record AlreadyConsumed() implements VerifyResult {}
    }

    /** Successor state paired with the verification outcome. */
    public record Attempt(OtpChallenge state, VerifyResult result) {}

    private final String principal;
    private final byte[] codeHash;
    private final Instant createdAt;
    private final Instant expiresAt;
    private final Instant resendAfter;
    private final int attemptsUsed;
    private final boolean consumed;
    private final Policy policy;

    private OtpChallenge(String principal, byte[] codeHash, Instant createdAt, Instant expiresAt,
                         Instant resendAfter, int attemptsUsed, boolean consumed, Policy policy) {
        this.principal = principal;
        this.codeHash = codeHash;
        this.createdAt = createdAt;
        this.expiresAt = expiresAt;
        this.resendAfter = resendAfter;
        this.attemptsUsed = attemptsUsed;
        this.consumed = consumed;
        this.policy = policy;
    }

    public static OtpChallenge start(String principal, byte[] codeHash, Instant now, Policy policy) {
        if (principal == null || principal.isBlank()) throw new IllegalArgumentException("principal");
        if (codeHash == null || codeHash.length == 0) throw new IllegalArgumentException("codeHash");
        return new OtpChallenge(principal, codeHash.clone(), now,
                now.plus(policy.ttl()), now.plus(policy.resendCooldown()), 0, false, policy);
    }

    /**
     * One verification attempt. Order of checks: consumed → exhausted → expired → compare.
     * A challenge whose 3 attempts are spent stays Exhausted even inside the TTL —
     * the user must request a fresh OTP (subject to the resend budget).
     */
    public Attempt verify(byte[] attemptHash, Instant now) {
        if (consumed) return new Attempt(this, new VerifyResult.AlreadyConsumed());
        if (attemptsUsed >= policy.maxAttempts()) return new Attempt(this, new VerifyResult.Exhausted());
        if (now.isAfter(expiresAt)) return new Attempt(this, new VerifyResult.Expired());
        if (MessageDigest.isEqual(codeHash, attemptHash)) {
            OtpChallenge done = new OtpChallenge(principal, codeHash, createdAt, expiresAt,
                    resendAfter, attemptsUsed, true, policy);
            return new Attempt(done, new VerifyResult.Ok());
        }
        int used = attemptsUsed + 1;
        OtpChallenge next = new OtpChallenge(principal, codeHash, createdAt, expiresAt,
                resendAfter, used, false, policy);
        return used >= policy.maxAttempts()
                ? new Attempt(next, new VerifyResult.Exhausted())
                : new Attempt(next, new VerifyResult.Invalid(policy.maxAttempts() - used));
    }

    /** FR-CUS-001: a replacement OTP may be requested only after the 30 s cool-down. */
    public boolean canResend(Instant now) {
        return !now.isBefore(resendAfter);
    }

    public String principal()   { return principal; }
    public Instant expiresAt()  { return expiresAt; }
    public int attemptsUsed()   { return attemptsUsed; }
    public boolean isConsumed() { return consumed; }
}
