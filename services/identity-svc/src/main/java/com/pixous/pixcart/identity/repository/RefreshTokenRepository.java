package com.pixous.pixcart.identity.repository;

import java.time.Instant;
import java.util.Optional;

/**
 * {@code id_refresh_token} (V002) — opaque, rotating, family reuse-detection (Vol. 10 §10.3).
 *
 * <p>The token <em>value</em> never reaches this layer; callers pass a SHA-256 digest, which
 * is what the {@code uq_refresh_hash} unique key indexes. A family is the set of rows sharing
 * a {@code session_id}: the row with {@code used_at IS NULL} is current, every other row is
 * retired, and presenting a retired row is the theft signal that kills the session.
 */
public interface RefreshTokenRepository {

    record RefreshTokenRecord(String id, String sessionId, Instant issuedAt, Instant expiresAt,
                              Instant usedAt, String replacedBy) {

        public boolean isUsed() {
            return usedAt != null;
        }
    }

    void insert(String tokenId, String sessionId, byte[] tokenHash, Instant issuedAt, Instant expiresAt);

    Optional<RefreshTokenRecord> findByHash(byte[] tokenHash);

    /**
     * Set {@code used_at} and {@code replaced_by} — the retirement half of a rotation.
     *
     * <p>The {@code AND used_at IS NULL} guard makes this a compare-and-set: two concurrent
     * presentations of the same token race here, exactly one wins, and the loser's zero-row
     * result is the same reuse signal the domain models.
     *
     * @return 1 if this caller retired the token, 0 if someone else already had
     */
    int markRotated(String tokenId, Instant usedAt, String successorId);

    /** Retire every still-current token of a session, so none can be rotated again. */
    void revokeUnused(String sessionId, Instant at);
}
