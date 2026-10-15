package com.pixous.pixcart.identity.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** JDBC adapter over V002 {@code id_session}. */
@Repository
public class JdbcSessionRepository implements SessionRepository {

    private static final String COLUMNS = "id, principal_type, principal_id, device_label, created_at, revoked_at";

    private static final RowMapper<SessionRecord> MAPPER = (rs, i) -> new SessionRecord(
            rs.getString("id"),
            rs.getString("principal_type"),
            rs.getString("principal_id"),
            rs.getString("device_label"),
            JdbcCustomerRepository.instant(rs.getTimestamp("created_at")),
            JdbcCustomerRepository.instant(rs.getTimestamp("revoked_at")));

    /** MariaDB rejects LIMIT in an un-derived subquery, hence the inner wrapping select. */
    private static final String EVICT_BEYOND_CAP =
            "UPDATE id_session SET revoked_at = ?"
                    + " WHERE principal_type = ? AND principal_id = ? AND revoked_at IS NULL"
                    + " AND id NOT IN (SELECT id FROM ("
                    + "     SELECT id FROM id_session"
                    + "     WHERE principal_type = ? AND principal_id = ? AND revoked_at IS NULL"
                    + "     ORDER BY created_at DESC, id DESC LIMIT ?"
                    + " ) keepers)";

    private final JdbcTemplate jdbc;

    public JdbcSessionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insert(String sessionId, String principalType, String principalId,
                       String deviceLabel, Instant createdAt) {
        jdbc.update("INSERT INTO id_session (id, principal_type, principal_id, device_label, created_at, last_seen_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?)",
                sessionId, principalType, principalId, deviceLabel,
                Timestamp.from(createdAt), Timestamp.from(createdAt));
    }

    @Override
    public Optional<SessionRecord> find(String sessionId) {
        List<SessionRecord> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM id_session WHERE id = ?", MAPPER, sessionId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public boolean isActive(String sessionId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM id_session WHERE id = ? AND revoked_at IS NULL",
                Integer.class, sessionId);
        return n != null && n == 1;
    }

    @Override
    public void revoke(String sessionId, Instant revokedAt) {
        jdbc.update("UPDATE id_session SET revoked_at = ?, last_seen_at = ? WHERE id = ?",
                Timestamp.from(revokedAt), Timestamp.from(revokedAt), sessionId);
    }

    @Override
    public void markReuseDetected(String sessionId, Instant at) {
        jdbc.update("UPDATE id_session SET reuse_detected_at = ?, revoked_at = ?, last_seen_at = ? WHERE id = ?",
                Timestamp.from(at), Timestamp.from(at), Timestamp.from(at), sessionId);
    }

    @Override
    public int revokeOldestBeyondCap(String principalType, String principalId, int cap, Instant at) {
        if (cap < 1) throw new IllegalArgumentException("cap");
        return jdbc.update(EVICT_BEYOND_CAP,
                Timestamp.from(at), principalType, principalId, principalType, principalId, cap);
    }
}
