package com.pixous.pixcart.identity.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

/** JDBC adapter over V002 {@code id_mfa_factor}. */
@Repository
public class JdbcMfaFactorRepository implements MfaFactorRepository {

    private static final String COLUMNS = "id, kind, secret_enc, code_hash, used_at, verified_at";

    /**
     * A spent recovery code is dead; a TOTP factor has no {@code used_at} meaning and stays
     * selectable for its whole life, so the spend filter is kind-specific rather than global.
     */
    private static final String ACTIVE =
            "SELECT " + COLUMNS + " FROM id_mfa_factor"
                    + " WHERE principal_type = ? AND principal_id = ? AND revoked_at IS NULL"
                    + " AND (kind = 'TOTP' OR used_at IS NULL)";

    private static final RowMapper<MfaFactorRecord> MAPPER = (rs, i) -> new MfaFactorRecord(
            rs.getString("id"),
            rs.getString("kind"),
            rs.getBytes("secret_enc"),
            rs.getBytes("code_hash"),
            JdbcCustomerRepository.instant(rs.getTimestamp("used_at")),
            JdbcCustomerRepository.instant(rs.getTimestamp("verified_at")));

    private final JdbcTemplate jdbc;

    public JdbcMfaFactorRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public List<MfaFactorRecord> findActiveFor(String principalType, String principalId) {
        return jdbc.query(ACTIVE, MAPPER, principalType, principalId);
    }

    @Override
    public void markRecoveryUsed(String factorId, Instant at) {
        jdbc.update("UPDATE id_mfa_factor SET used_at = ? WHERE id = ? AND used_at IS NULL",
                Timestamp.from(at), factorId);
    }

    @Override
    public void markVerified(String factorId, Instant at) {
        jdbc.update("UPDATE id_mfa_factor SET verified_at = ? WHERE id = ? AND verified_at IS NULL",
                Timestamp.from(at), factorId);
    }
}
