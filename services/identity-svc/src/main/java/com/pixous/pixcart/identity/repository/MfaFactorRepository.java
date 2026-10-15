package com.pixous.pixcart.identity.repository;

import java.time.Instant;
import java.util.List;

/**
 * {@code id_mfa_factor} (V002) — the enrolment store behind FR-CUS-003.
 *
 * <p>Two kinds matter to this slice. {@code TOTP} holds an encrypted RFC 6238 secret in
 * {@code secret_enc} (see {@code MfaSecretCipher}); {@code RECOVERY} holds a single-use
 * code digest in {@code code_hash} with {@code used_at} recording the spend. Both are
 * "active" while {@code revoked_at IS NULL}, and a recovery code additionally needs
 * {@code used_at IS NULL} — that column, not an in-memory set, is the single-use guarantee.
 */
public interface MfaFactorRepository {

    String KIND_TOTP = "TOTP";
    String KIND_RECOVERY = "RECOVERY";

    record MfaFactorRecord(String id, String kind, byte[] secretEnc, byte[] codeHash,
                           Instant usedAt, Instant verifiedAt) {

        public boolean isSpent() {
            return usedAt != null;
        }
    }

    /**
     * @param principalType {@code CUSTOMER} or {@code STAFF}
     * @return every unrevoked factor; spent recovery codes are excluded, TOTP factors are not
     */
    List<MfaFactorRecord> findActiveFor(String principalType, String principalId);

    /** Spend a recovery code. A second spend of the same code is refused by the row state. */
    void markRecoveryUsed(String factorId, Instant at);

    /** Record that the TOTP secret has been proven, so an unproven enrolment is distinguishable. */
    void markVerified(String factorId, Instant at);
}
