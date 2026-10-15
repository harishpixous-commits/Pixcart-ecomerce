package com.pixous.pixcart.identity.repository;

import java.time.Instant;
import java.util.Optional;

/**
 * {@code id_session} (V002). One row per device login; the row <em>is</em> the refresh-token
 * family of Vol. 10 §10.3.
 *
 * <p>{@link #isActive(String)} reproduces {@code SessionRegistry.isActive} semantics over
 * the persisted store: a session exists and is active exactly while its row is present and
 * {@code revoked_at IS NULL}. The bearer filter calls this on every authenticated request,
 * so revoking a row kills every access token bound to it at the next hop — the 15-minute
 * JWT lifetime does not extend a revoked session.
 */
public interface SessionRepository {

    record SessionRecord(String id, String principalType, String principalId,
                         String deviceLabel, Instant createdAt, Instant revokedAt) {
    }

    void insert(String sessionId, String principalType, String principalId,
                String deviceLabel, Instant createdAt);

    Optional<SessionRecord> find(String sessionId);

    /** {@code true} when the row exists and {@code revoked_at IS NULL}. */
    boolean isActive(String sessionId);

    void revoke(String sessionId, Instant revokedAt);

    /** V002 {@code reuse_detected_at}: records that this family died to a token replay. */
    void markReuseDetected(String sessionId, Instant at);

    /**
     * FR-CUS-002 RULES: "concurrent session limit 8 (oldest evicted)". Keeps the
     * {@code cap} most recently created live sessions and revokes the rest, matching
     * {@code SessionRegistry.register}'s oldest-first eviction.
     *
     * @return how many sessions were evicted
     */
    int revokeOldestBeyondCap(String principalType, String principalId, int cap, Instant at);
}
