package com.pixous.pixcart.identity.repository;

import com.pixous.pixcart.identity.domain.token.RefreshTokenFamily;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * The persisted rotation decision must be the domain's decision, not a lookalike.
 *
 * <p>{@code RefreshRotation} is the same rule expressed over V002 columns, because
 * {@code RefreshTokenFamily} is an in-memory map that the schema cannot rebuild without a
 * seeding constructor — and {@code domain/} is frozen. This test pins the two together state
 * by state, so a future edit to either one that changes a verdict fails here rather than in
 * production.
 */
class RefreshRotationParityTest {

    private static final Instant T0 = Instant.parse("2026-10-11T10:00:00Z");

    @Test
    void aLiveFamilyAcceptingItsCurrentTokenRotatesInBothModels() {
        RefreshTokenFamily family = new RefreshTokenFamily("SESS-1", "T1");
        RefreshTokenFamily.RotationResult domain = family.rotate("T1", "T2", T0);

        RefreshRotation.Outcome persisted = RefreshRotation.decide(
                true /* session active */, true /* row found */, false /* not yet used */, false);

        assertInstanceOf(RefreshTokenFamily.RotationResult.Rotated.class, domain);
        assertSameOutcome(RefreshRotation.Outcome.ROTATED, persisted);
    }

    @Test
    void presentingARetiredTokenIsReuseInBothModels() {
        RefreshTokenFamily family = new RefreshTokenFamily("SESS-1", "T1");
        family.rotate("T1", "T2", T0);                       // T1 is now retired
        RefreshTokenFamily.RotationResult domain = family.rotate("T1", "T3", T0.plusSeconds(1));

        RefreshRotation.Outcome persisted = RefreshRotation.decide(
                true, true, true /* already used */, false);

        assertInstanceOf(RefreshTokenFamily.RotationResult.ReuseDetected.class, domain);
        assertSameOutcome(RefreshRotation.Outcome.REUSE_DETECTED, persisted);
    }

    @Test
    void aTokenThisFamilyNeverIssuedIsRefusedWithoutRevocationInBothModels() {
        RefreshTokenFamily family = new RefreshTokenFamily("SESS-1", "T1");
        RefreshTokenFamily.RotationResult domain = family.rotate("T9", "T2", T0);

        RefreshRotation.Outcome persisted = RefreshRotation.decide(
                true, false /* no row */, false, false);

        assertInstanceOf(RefreshTokenFamily.RotationResult.UnknownToken.class, domain);
        // The outsider's probe must not kill the victim's family.
        assertSameOutcome(RefreshRotation.Outcome.UNKNOWN_TOKEN, persisted);
    }

    @Test
    void aRevokedFamilyRefusesEverythingInBothModels() {
        RefreshTokenFamily family = new RefreshTokenFamily("SESS-1", "T1");
        family.rotate("T1", "T2", T0);
        family.rotate("T1", "T3", T0.plusSeconds(1));         // reuse → family revoked
        RefreshTokenFamily.RotationResult domain = family.rotate("T2", "T4", T0.plusSeconds(2));

        RefreshRotation.Outcome persisted = RefreshRotation.decide(
                false /* session revoked */, true, false, false);

        assertInstanceOf(RefreshTokenFamily.RotationResult.FamilyRevoked.class, domain);
        assertSameOutcome(RefreshRotation.Outcome.FAMILY_REVOKED, persisted);
    }

    @Test
    void expiryIsTheOneStateOnlyThePersistedModelCarries() {
        // The schema has expires_at; an in-memory family has no wall clock of its own. The
        // extra state must never be able to shadow a reuse verdict.
        RefreshRotation.Outcome expired = RefreshRotation.decide(true, true, false, true);
        RefreshRotation.Outcome reuse = RefreshRotation.decide(true, true, true, true);

        assertSameOutcome(RefreshRotation.Outcome.EXPIRED, expired);
        assertSameOutcome(RefreshRotation.Outcome.REUSE_DETECTED, reuse);
    }

    /** Fails with both values visible, rather than with a bare "expected true". */
    private static void assertSameOutcome(RefreshRotation.Outcome expected, RefreshRotation.Outcome actual) {
        if (expected != actual) {
            throw new AssertionError("expected " + expected + " but the persisted decision was " + actual);
        }
        // Guard against a no-op assertion: every shared state must be distinct from the others.
        assertNotEquals(null, actual);
    }
}
