package com.pixous.pixcart.identity.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** JDBC adapter over V001 {@code id_customer}. */
@Repository
public class JdbcCustomerRepository implements CustomerRepository {

    private static final String COLUMNS =
            "id, email, mobile, password_hash, full_name, status, lang, kyc_tier, created_at";

    private static final RowMapper<CustomerRecord> MAPPER = (rs, i) -> new CustomerRecord(
            rs.getString("id"),
            rs.getString("email"),
            rs.getString("mobile"),
            bytesToAscii(rs.getBytes("password_hash")),
            rs.getString("full_name"),
            rs.getString("status"),
            rs.getString("lang"),
            rs.getInt("kyc_tier"),
            instant(rs.getTimestamp("created_at")));

    private final JdbcTemplate jdbc;

    public JdbcCustomerRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Optional<CustomerRecord> findById(String id) {
        return one("SELECT " + COLUMNS + " FROM id_customer WHERE id = ?", id);
    }

    @Override
    public Optional<CustomerRecord> findByEmailNorm(String emailNorm) {
        return one("SELECT " + COLUMNS + " FROM id_customer WHERE email_norm = ?", emailNorm);
    }

    @Override
    public CustomerRecord insert(CustomerRecord customer) {
        // mobile stays NULL and email_norm is GENERATED, so neither is written.
        jdbc.update("INSERT INTO id_customer (id, email, password_hash, full_name, lang, status, kyc_tier, created_at)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                customer.id(),
                customer.email(),
                customer.passwordHash().getBytes(StandardCharsets.US_ASCII),
                customer.fullName(),
                customer.lang(),
                customer.status(),
                customer.kycTier(),
                Timestamp.from(customer.createdAt()));
        return customer;
    }

    private Optional<CustomerRecord> one(String sql, Object... args) {
        List<CustomerRecord> rows = jdbc.query(sql, MAPPER, args);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** {@code password_hash} is {@code VARBINARY(128)} holding the ASCII of the encoded string. */
    static String bytesToAscii(byte[] bytes) {
        return bytes == null ? null : new String(bytes, StandardCharsets.US_ASCII);
    }

    static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
