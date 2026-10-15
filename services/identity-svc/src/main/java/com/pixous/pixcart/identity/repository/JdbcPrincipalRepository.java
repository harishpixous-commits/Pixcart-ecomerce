package com.pixous.pixcart.identity.repository;

import com.pixous.pixcart.identity.domain.rbac.Rbac;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * JDBC adapter resolving a principal across {@code id_customer}, {@code id_staff} and
 * {@code ven_store} (V008).
 *
 * <p>Each {@code SELECT} is written to match the table's own generated normalised column —
 * {@code email_norm} on all three as of V008 — so the lookup is index-backed and the
 * lower-casing rule exists once, in the schema, rather than here.
 *
 * <p>{@link #resolveByEmailNorm} deliberately issues <em>one</em> query per table in a fixed
 * order rather than a three-way {@code UNION}: a {@code UNION} would need the three tables'
 * column lists to be padded to a common shape, which would put the "customer wins" rule into
 * a {@code CASE} expression that nothing else can read. The order below states it plainly.
 *
 * <p>If the same address exists on more than one table, the customer row wins and the other
 * rows are unreachable by that address. That is a provisioning error, not a lookup bug, and
 * it is resolved by renaming rather than by choosing a different winner at sign-in time.
 */
@Repository
public class JdbcPrincipalRepository implements PrincipalRepository {

    private static final String CUSTOMER_COLUMNS =
            "id, email, full_name, status, password_hash, lang, mobile, kyc_tier, created_at";
    private static final String STAFF_COLUMNS =
            "id, email, full_name, status, role, password_hash, created_at";
    private static final String STORE_COLUMNS =
            "id, display_name, email, mobile, status, password_hash, created_at";

    // password_hash is VARBINARY holding the ASCII of the encoded string (see JdbcCustomerRepository).
    private static final RowMapper<Principal> CUSTOMER_MAPPER = (rs, i) -> new Principal(
            KIND_CUSTOMER,
            rs.getString("id"),
            rs.getString("email"),
            rs.getString("full_name"),
            rs.getString("status"),
            ascii(rs.getBytes("password_hash")),
            Rbac.Role.CUSTOMER,                       // a customer row can never claim otherwise
            rs.getString("lang"),
            rs.getString("mobile"),
            rs.getInt("kyc_tier"),
            instant(rs.getTimestamp("created_at")));

    /**
     * {@code id_staff.role} is constrained by {@code ck_staff_role} to the platform-employee
     * vocabulary, which is exactly the non-customer half of {@link Rbac.Role}. An unknown
     * value therefore means the row predates the check; refusing loudly beats silently
     * defaulting the caller to CUSTOMER, which would grant them a stranger's permissions.
     */
    private static final RowMapper<Principal> STAFF_MAPPER = (rs, i) -> new Principal(
            KIND_STAFF,
            rs.getString("id"),
            rs.getString("email"),
            rs.getString("full_name"),
            rs.getString("status"),
            ascii(rs.getBytes("password_hash")),
            staffRole(rs.getString("role")),
            null,                                    // id_staff has no locale column
            null,                                    // and no mobile column
            0,                                       // and no KYC tier
            instant(rs.getTimestamp("created_at")));

    /** A vendor principal is the store row; {@link Rbac.Role} has exactly one vendor role. */
    private static final RowMapper<Principal> STORE_MAPPER = (rs, i) -> new Principal(
            KIND_VENDOR,
            rs.getString("id"),
            rs.getString("email"),
            rs.getString("display_name"),
            rs.getString("status"),
            ascii(rs.getBytes("password_hash")),
            Rbac.Role.VENDOR,
            null,                                    // ven_store has no locale column
            rs.getString("mobile"),
            0,                                       // and no KYC tier
            instant(rs.getTimestamp("created_at")));

    private final JdbcTemplate jdbc;

    public JdbcPrincipalRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Customer first, then staff, then vendor — the same order the login path documents.
     * A blank or unparseable address returns empty rather than throwing: the caller turns
     * "no row" into the one no-enumeration response, so the lookup must not reveal which
     * of the three tables was consulted.
     */
    @Override
    public Optional<Principal> resolveByEmailNorm(String emailNorm) {
        if (emailNorm == null || emailNorm.isBlank()) return Optional.empty();

        List<Principal> customers = jdbc.query(
                "SELECT " + CUSTOMER_COLUMNS + " FROM id_customer WHERE email_norm = ?",
                CUSTOMER_MAPPER, emailNorm);
        if (!customers.isEmpty()) return Optional.of(customers.get(0));

        List<Principal> staff = jdbc.query(
                "SELECT " + STAFF_COLUMNS + " FROM id_staff WHERE email_norm = ?",
                STAFF_MAPPER, emailNorm);
        if (!staff.isEmpty()) return Optional.of(staff.get(0));

        List<Principal> stores = jdbc.query(
                "SELECT " + STORE_COLUMNS + " FROM ven_store WHERE email_norm = ?",
                STORE_MAPPER, emailNorm);
        return stores.isEmpty() ? Optional.empty() : Optional.of(stores.get(0));
    }

    @Override
    public Optional<Principal> findById(String kind, String id) {
        if (id == null || id.isBlank()) return Optional.empty();
        return switch (kind == null ? "" : kind) {
            case KIND_CUSTOMER -> one(
                    "SELECT " + CUSTOMER_COLUMNS + " FROM id_customer WHERE id = ?",
                    CUSTOMER_MAPPER, id);
            case KIND_STAFF -> one(
                    "SELECT " + STAFF_COLUMNS + " FROM id_staff WHERE id = ?",
                    STAFF_MAPPER, id);
            case KIND_VENDOR -> one(
                    "SELECT " + STORE_COLUMNS + " FROM ven_store WHERE id = ?",
                    STORE_MAPPER, id);
            // An unrecorded principal type is a defect in whoever wrote the session row,
            // not something to guess at by falling through to the customer table.
            default -> throw new IllegalStateException(
                    "unknown principal type " + kind + "; refusing to resolve it against a table");
        };
    }

    private Optional<Principal> one(String sql, RowMapper<Principal> mapper, Object... args) {
        List<Principal> rows = jdbc.query(sql, mapper, args);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    private static Rbac.Role staffRole(String raw) {
        try {
            return Rbac.Role.valueOf(raw);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new IllegalStateException(
                    "id_staff.role is '" + raw + "', which is not a Rbac.Role; the row cannot be mapped safely",
                    e);
        }
    }

    private static String ascii(byte[] bytes) {
        return bytes == null ? null : new String(bytes, StandardCharsets.US_ASCII);
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
