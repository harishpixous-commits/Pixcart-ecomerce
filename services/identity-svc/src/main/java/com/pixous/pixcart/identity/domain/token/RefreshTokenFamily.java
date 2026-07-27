package com.pixous.pixcart.identity.domain.token;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

/**
 * Refresh-token family (one family = one device session, id_session row).
 *
 * Normative source — Vol. 10 §10.3, Refresh token row:
 *   "Opaque, rotating, family reuse-detection → family revoke"  (verified TC-SEC-011)
 *
 * Semantics implemented:
 *   - presenting the CURRENT token rotates it: the token retires, a successor becomes current;
 *   - presenting a RETIRED token is the theft signal (an attacker replayed a stolen token
 *     after the honest client already rotated) → the entire family revokes immediately;
 *   - a token id this family has never issued is rejected without revocation
 *     (mistyped/foreign token must not let an outsider kill a victim's session);
 *   - a revoked family refuses everything; the user must re-authenticate.
 *
 * Token VALUES never enter the domain — adapters store hashes (uq_refresh_hash in V002);
 * this class reasons over token ids.
 */
public final class RefreshTokenFamily {

    public sealed interface RotationResult {
        record Rotated(String newTokenId) implements RotationResult {}
        record ReuseDetected(Instant revokedAt) implements RotationResult {}
        record FamilyRevoked() implements RotationResult {}
        record UnknownToken() implements RotationResult {}
    }

    private final String sessionId;
    private String currentTokenId;
    private final Set<String> retired = new HashSet<>();
    private Instant revokedAt;

    public RefreshTokenFamily(String sessionId, String initialTokenId) {
        if (sessionId == null || sessionId.isBlank()) throw new IllegalArgumentException("sessionId");
        if (initialTokenId == null || initialTokenId.isBlank()) throw new IllegalArgumentException("initialTokenId");
        this.sessionId = sessionId;
        this.currentTokenId = initialTokenId;
    }

    public RotationResult rotate(String presentedTokenId, String newTokenId, Instant now) {
        if (revokedAt != null) return new RotationResult.FamilyRevoked();
        if (currentTokenId.equals(presentedTokenId)) {
            retired.add(currentTokenId);
            currentTokenId = newTokenId;
            return new RotationResult.Rotated(newTokenId);
        }
        if (retired.contains(presentedTokenId)) {
            revokedAt = now;                       // §10.3: reuse ⇒ revoke the family
            return new RotationResult.ReuseDetected(now);
        }
        return new RotationResult.UnknownToken();
    }

    public boolean isRevoked()      { return revokedAt != null; }
    public Instant revokedAt()      { return revokedAt; }
    public String sessionId()       { return sessionId; }
    public String currentTokenId()  { return currentTokenId; }
}
