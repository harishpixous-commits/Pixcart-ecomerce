package com.pixous.pixcart.identity.repository;

import java.time.Instant;
import java.util.Optional;

/**
 * {@code id_customer} (V001 DDL-01). The only principal type this slice writes; staff rows
 * live in {@code id_staff} and are not in scope for FR-CUS-001/002/003.
 */
public interface CustomerRepository {

    /**
     * A customer row. {@code passwordHash} is the <em>encoded</em> Argon2id string as stored
     * in the {@code VARBINARY(128)} column; {@code mobile} is null for email-only accounts.
     */
    record CustomerRecord(String id, String email, String mobile, String passwordHash,
                           String fullName, String status, String lang, int kycTier,
                           Instant createdAt) {
    }

    Optional<CustomerRecord> findById(String id);

    /**
     * @param emailNorm the lower-cased address; matches the generated {@code email_norm}
     *                  column, which is what {@code uq_customer_email} is declared on
     */
    Optional<CustomerRecord> findByEmailNorm(String emailNorm);

    /** @throws org.springframework.dao.DuplicateKeyException if the email is already taken */
    CustomerRecord insert(CustomerRecord customer);
}
