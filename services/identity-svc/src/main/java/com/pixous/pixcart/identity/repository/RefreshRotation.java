package com.pixous.pixcart.identity.repository;

/**
 * The refresh-rotation decision, as a pure function of the persisted state.
 *
 * <p>This table <em>is</em> {@code RefreshTokenFamily.rotate}'s rule, transcribed rather than
 * re-derived, because the domain object is an in-memory map that cannot be reconstructed from
 * the V002 schema without a seeding constructor — and {@code domain/} is frozen. The three
 * states {@link Outcome#ROTATED}, {@link Outcome#REUSE_DETECTED} and
 * {@link Outcome#UNKNOWN_TOKEN} plus {@link Outcome#FAMILY_REVOKED} correspond one-for-one to
 * {@code Rotated}, {@code ReuseDetected}, {@code UnknownToken} and {@code FamilyRevoked};
 * {@link Outcome#EXPIRED} is the one state the schema models ({@code expires_at}) and the
 * domain does not, because an in-memory family has no wall-clock expiry of its own.
 *
 * <p>{@code RefreshRotationParityTest} asserts the two agree on every shared state, so the
 * transcription cannot drift from the spec it transcribes.
 *
 * <p>Order matters and mirrors the domain's check order: family-revoked first, then the
 * unknown-token refusal (a foreign token must never revoke a victim's family), then the
 * current-token rotation. Expiry is checked <em>after</em> reuse on purpose: a retired token
 * replayed past {@code expires_at} is still the §10.3 theft signal, and answering "expired"
 * would under-revoke the family (pinned by {@code RefreshRotationParityTest}).
 */
public final class RefreshRotation {

    /** Nothing was mutated; the caller must persist the successor. */
    public enum Outcome {
        /** The presented token is the family's current token — rotate it. */
        ROTATED,
        /** The presented token was already rotated away: theft signal, revoke the family. */
        REUSE_DETECTED,
        /** Not a token this family issued. Refuse; do NOT revoke (could be an outsider probing). */
        UNKNOWN_TOKEN,
        /** The family (its session) is already dead. */
        FAMILY_REVOKED,
        /** Found and current, but past {@code expires_at}. Adapter-level state; not in the domain. */
        EXPIRED
    }

    private RefreshRotation() {
    }

    public static Outcome decide(boolean sessionActive, boolean tokenRowFound,
                                 boolean tokenAlreadyUsed, boolean tokenExpired) {
        if (!sessionActive) return Outcome.FAMILY_REVOKED;
        if (!tokenRowFound) return Outcome.UNKNOWN_TOKEN;
        if (tokenAlreadyUsed) return Outcome.REUSE_DETECTED;
        if (tokenExpired) return Outcome.EXPIRED;
        return Outcome.ROTATED;
    }
}
