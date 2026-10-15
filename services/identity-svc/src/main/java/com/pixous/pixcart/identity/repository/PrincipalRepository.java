package com.pixous.pixcart.identity.repository;

import java.time.Instant;
import java.util.Optional;

/**
 * Resolution of a principal across the three tables a human can sign in from:
 * {@code id_customer} (V001), {@code id_staff} (V002) and {@code ven_store} (V006).
 *
 * <p>Why one interface rather than three: {@code AuthService.login} must apply
 * <em>exactly one</em> {@code LoginPolicy} attempt regardless of which table holds the
 * account, and {@code refresh}/{@code me} must resolve whatever the session recorded. If
 * each table had its own repository and its own lookup call, the "which table is this
 * principal in" decision would be re-stated three times in the adapter and a fourth time in
 * the test double — which is how a second behaviour grows under one name (CLAUDE.md §5).
 * The three-way fan-out lives here, once.
 *
 * <p>Nothing in this interface implies the three kinds are interchangeable. They are not:
 * a staff role comes from {@code id_staff.role}, a vendor is always {@code Rbac.Role.VENDOR},
 * and a customer is always {@code Rbac.Role.CUSTOMER}. The mapping is stated once, in
 * {@link #KIND_CUSTOMER}/{@link #KIND_STAFF}/{@link #KIND_VENDOR}, and the RBAC matrix is
 * still the only source of what each role may do.
 */
public interface PrincipalRepository {

    String KIND_CUSTOMER = "CUSTOMER";
    String KIND_STAFF = "STAFF";
    String KIND_VENDOR = "VENDOR";

    /** {@code ck_customer_status} / {@code ck_staff_status} — the usable state of both. */
    String STATUS_ACTIVE = "ACTIVE";
    /** {@code ck_store_status} — {@code ven_store}'s usable state; it has no ACTIVE. */
    String STATUS_APPROVED = "APPROVED";

    /**
     * One principal, whichever table it came from.
     *
     * @param kind             {@code CUSTOMER}, {@code STAFF} or {@code VENDOR}
     * @param passwordHash     the encoded Argon2id string, or <em>null</em> when the row
     *                         carries no credential. {@code PasswordHasher.matches} fails
     *                         closed on null, so a null here is a refusal, not a bypass.
     * @param role             the role the token must claim; see the class doc on how it
     *                         is derived per kind
     * @param status           the account-state column of the owning table, verbatim
     * @param lang             {@code id_customer.lang}; null for staff rows, which have no
     *                         locale column
     * @param mobile           {@code id_customer.mobile} or {@code ven_store.mobile}; null
     *                         for staff rows and for email-only customer accounts
     * @param kycTier          {@code id_customer.kyc_tier}; 0 for staff and vendor rows
     */
    record Principal(String kind, String id, String email, String fullName, String status,
                     String passwordHash, com.pixous.pixcart.identity.domain.rbac.Rbac.Role role,
                     String lang, String mobile, int kycTier, Instant createdAt) {

        /**
         * Whether the owning table's status column admits this principal to a session.
         *
         * <p>Each table has its own vocabulary, and they do <em>not</em> share a word for
         * "usable": {@code id_customer} and {@code id_staff} say {@code ACTIVE} while
         * {@code ven_store} says {@code APPROVED}. Collapsing them to a single
         * {@code status.equals("ACTIVE")} test is the obvious alternative and it is wrong —
         * it silently locks out every approved vendor, because no store row ever reads
         * ACTIVE. Naming the one usable value per kind keeps the mapping in one place and
         * makes the refusal total: every other value, including {@code PENDING} (a store
         * still in KYC review), {@code REJECTED}, {@code SUSPENDED}, {@code PAUSED},
         * {@code DELETED} and {@code DELETION_PENDING}, is refused.
         */
        public boolean isUsable() {
            return switch (kind) {
                case KIND_CUSTOMER, KIND_STAFF -> STATUS_ACTIVE.equals(status);
                case KIND_VENDOR -> STATUS_APPROVED.equals(status);
                // An unrecorded kind is not usable, and findById refuses it loudly before
                // this is ever reached.
                default -> false;
            };
        }
    }

    /**
     * @param emailNorm the lower-cased address, matching each table's normalised lookup
     * @return the principal, or empty when the address is on none of the three tables
     *
     * <p>Named {@code resolveByEmailNorm} rather than {@code findByEmailNorm} only because
     * {@code CustomerRepository} already declares the latter returning
     * {@code Optional<CustomerRecord)}. The two {@code Optional} element types are unrelated,
     * so Java will not accept one method as a covariant override of the other, and renaming
     * here leaves the registration-facing interface untouched. The behaviour is the
     * customer lookup's, extended across three tables — not a second one.
     */
    Optional<Principal> resolveByEmailNorm(String emailNorm);

    /** @param kind one of {@link #KIND_CUSTOMER}, {@link #KIND_STAFF}, {@link #KIND_VENDOR} */
    Optional<Principal> findById(String kind, String id);
}
