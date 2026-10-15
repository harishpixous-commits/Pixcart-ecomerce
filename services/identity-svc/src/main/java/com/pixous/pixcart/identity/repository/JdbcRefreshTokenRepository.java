package com.pixous.pixcart.identity.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** JDBC adapter over V002 {@code id_refresh_token}. */
@Repository
public class JdbcRefreshTokenRepository implements RefreshTokenRepository {

    private static final String COLUMNS = "id, session_id, issued_at, expires_at, used_at, replaced_by";

    private static final RowMapper<RefreshTokenRecord> MAPPER = (rs, i) -> new RefreshTokenRecord(
            rs.getString("id"),
            rs.getString("session_id"),
            JdbcCustomerRepository.instant(rs.getTimestamp("issued_at")),
            JdbcCustomerRepository.instant(rs.getTimestamp("expires_at")),
            JdbcCustomerRepository.instant(rs.getTimestamp("used_at")),
            rs.getString("replaced_by"));

    private final JdbcTemplate jdbc;

    public JdbcRefreshTokenRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insert(String tokenId, String sessionId, byte[] tokenHash,
                       Instant issuedAt, Instant expiresAt) {
        jdbc.update("INSERT INTO id_refresh_token (id, session_id, token_hash, issued_at, expires_at)"
                        + " VALUES (?, ?, ?, ?, ?)",
                tokenId, sessionId, tokenHash, Timestamp.from(issuedAt), Timestamp.from(expiresAt));
    }

    @Override
    public Optional<RefreshTokenRecord> findByHash(byte[] tokenHash) {
        List<RefreshTokenRecord> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM id_refresh_token WHERE token_hash = ?", MAPPER, tokenHash);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public int markRotated(String tokenId, Instant usedAt, String successorId) {
        return jdbc.update("UPDATE id_refresh_token SET used_at = ?, replaced_by = ? WHERE id = ? AND used_at IS NULL",
                Timestamp.from(usedAt), successorId, tokenId);
    }

    @Override
    public void revokeUnused(String sessionId, Instant at) {
        jdbc.update("UPDATE id_refresh_token SET used_at = ? WHERE session_id = ? AND used_at IS NULL",
                Timestamp.from(at), sessionId);
    }
}
