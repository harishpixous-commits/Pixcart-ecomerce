package com.pixous.pixcart.identity.domain.token;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/** Vol.10 §10.3 refresh-token row, verified TC-SEC-011: rotation + family reuse-detection. */
class RefreshTokenFamilyTest {

    private static final Instant NOW = Instant.parse("2026-08-15T10:00:00Z");

    @Test
    void honestClientRotatesThroughSuccessiveTokens() {
        var fam = new RefreshTokenFamily("01SES00000000000000000000A", "tokA");
        assertEquals(new RefreshTokenFamily.RotationResult.Rotated("tokB"),
                fam.rotate("tokA", "tokB", NOW));
        assertEquals(new RefreshTokenFamily.RotationResult.Rotated("tokC"),
                fam.rotate("tokB", "tokC", NOW.plusSeconds(900)));
        assertEquals("tokC", fam.currentTokenId());
        assertFalse(fam.isRevoked());
    }

    @Test
    void replayingARetiredTokenRevokesTheWholeFamily() {
        var fam = new RefreshTokenFamily("01SES00000000000000000000A", "tokA");
        fam.rotate("tokA", "tokB", NOW);
        fam.rotate("tokB", "tokC", NOW.plusSeconds(900));

        // attacker replays the stolen tokA the honest client already rotated away
        var theft = fam.rotate("tokA", "tokX", NOW.plusSeconds(1000));
        assertInstanceOf(RefreshTokenFamily.RotationResult.ReuseDetected.class, theft);
        assertTrue(fam.isRevoked());

        // the honest client's CURRENT token is now dead too — full re-authentication
        assertInstanceOf(RefreshTokenFamily.RotationResult.FamilyRevoked.class,
                fam.rotate("tokC", "tokY", NOW.plusSeconds(1001)));
    }

    @Test
    void unknownTokenIsRejectedWithoutRevokingTheVictim() {
        var fam = new RefreshTokenFamily("01SES00000000000000000000A", "tokA");
        assertInstanceOf(RefreshTokenFamily.RotationResult.UnknownToken.class,
                fam.rotate("never-issued", "tokZ", NOW));
        assertFalse(fam.isRevoked(), "an outsider guessing ids must not kill the session");
        assertEquals(new RefreshTokenFamily.RotationResult.Rotated("tokB"),
                fam.rotate("tokA", "tokB", NOW.plusSeconds(1)));
    }
}
