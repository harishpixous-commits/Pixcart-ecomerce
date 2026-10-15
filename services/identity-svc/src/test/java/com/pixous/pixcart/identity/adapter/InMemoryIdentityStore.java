package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.domain.rbac.Rbac;
import com.pixous.pixcart.identity.repository.CustomerRepository;
import com.pixous.pixcart.identity.repository.MfaFactorRepository;
import com.pixous.pixcart.identity.repository.PrincipalRepository;
import com.pixous.pixcart.identity.repository.RefreshTokenRepository;
import com.pixous.pixcart.identity.repository.SessionRepository;
import org.springframework.dao.DuplicateKeyException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * An in-memory stand-in for the five JDBC repositories.
 *
 * <p>Deliberately hand-written rather than mocked: the point of these tests is the behaviour
 * of the flows over a <em>persistent</em> store — rotation, revocation, single-use recovery
 * codes, the session cap — and a Mockito mock would let each test invent a different store.
 * This one keeps the same invariants the schema does (a session is live until revoked, a
 * refresh token is current until used, a recovery code dies when spent), so a test that
 * passes here is exercising the real rules.
 */
final class InMemoryIdentityStore
        implements CustomerRepository, PrincipalRepository, SessionRepository,
        RefreshTokenRepository, MfaFactorRepository {

    private final Map<String, CustomerRecord> customersById = new LinkedHashMap<>();
    private final Map<String, String> customerIdByEmail = new LinkedHashMap<>();
    private final Map<String, Principal> staffById = new LinkedHashMap<>();
    private final Map<String, String> staffIdByEmail = new LinkedHashMap<>();
    private final Map<String, Principal> storesById = new LinkedHashMap<>();
    private final Map<String, String> storeIdByEmail = new LinkedHashMap<>();
    private final Map<String, SessionRecord> sessions = new LinkedHashMap<>();
    private final Map<String, RefreshTokenRecord> refreshByHash = new LinkedHashMap<>();
    private final Map<String, MfaFactorRecord> factors = new LinkedHashMap<>();

    // -------------------------------------------------------------- CustomerRepository

    @Override
    public synchronized Optional<CustomerRecord> findById(String id) {
        return Optional.ofNullable(customersById.get(id));
    }

    @Override
    public synchronized Optional<CustomerRecord> findByEmailNorm(String emailNorm) {
        String id = customerIdByEmail.get(emailNorm);
        return id == null ? Optional.empty() : Optional.ofNullable(customersById.get(id));
    }

    @Override
    public synchronized CustomerRecord insert(CustomerRecord customer) {
        if (customerIdByEmail.containsKey(customer.email().toLowerCase())) {
            throw new DuplicateKeyException("uq_customer_email");
        }
        customersById.put(customer.id(), customer);
        customerIdByEmail.put(customer.email().toLowerCase(), customer.id());
        return customer;
    }

    // --------------------------------------------------------- PrincipalRepository

    /**
     * Mirrors {@code JdbcPrincipalRepository}: one address resolves on at most one table,
     * customer first. The same customer row is reachable through both interfaces, so a
     * test that registers a customer can also sign in as them — exactly as in the schema,
     * where {@code id_customer} is both the registration target and the principal source.
     */
    @Override
    public synchronized Optional<Principal> resolveByEmailNorm(String emailNorm) {
        if (emailNorm == null || emailNorm.isBlank()) return Optional.empty();
        String norm = emailNorm.toLowerCase();
        CustomerRecord customer = customersById.get(customerIdByEmail.get(norm));
        if (customer != null) return Optional.of(asPrincipal(customer));
        Principal staff = staffIdByEmail.containsKey(norm) ? staffById.get(staffIdByEmail.get(norm)) : null;
        if (staff != null) return Optional.of(staff);
        Principal store = storeIdByEmail.containsKey(norm) ? storesById.get(storeIdByEmail.get(norm)) : null;
        return Optional.ofNullable(store);
    }

    @Override
    public synchronized Optional<Principal> findById(String kind, String id) {
        return switch (kind == null ? "" : kind) {
            case KIND_CUSTOMER -> customersById.containsKey(id)
                    ? Optional.of(asPrincipal(customersById.get(id))) : Optional.empty();
            case KIND_STAFF -> Optional.ofNullable(staffById.get(id));
            case KIND_VENDOR -> Optional.ofNullable(storesById.get(id));
            default -> throw new IllegalStateException(
                    "unknown principal type " + kind + "; refusing to resolve it against a table");
        };
    }

    private static Principal asPrincipal(CustomerRecord customer) {
        return new Principal(KIND_CUSTOMER, customer.id(), customer.email(), customer.fullName(),
                customer.status(), customer.passwordHash(), Rbac.Role.CUSTOMER,
                customer.lang(), customer.mobile(), customer.kycTier(), customer.createdAt());
    }

    /**
     * Test seam: place a staff row, optionally without a credential. A null
     * {@code passwordHash} is the V008 state of a row no operator has provisioned yet, and
     * is what proves such a row cannot sign in.
     */
    synchronized void putStaff(String id, String email, String fullName, String role,
                               String status, String passwordHash) {
        Principal principal = new Principal(KIND_STAFF, id, email, fullName, status,
                passwordHash, Rbac.Role.valueOf(role), null, null, 0, Instant.EPOCH);
        staffById.put(id, principal);
        staffIdByEmail.put(email.toLowerCase(), id);
    }

    /** Test seam: place a vendor store row; a vendor's role is always VENDOR. */
    synchronized void putStore(String id, String displayName, String email, String mobile,
                               String status, String passwordHash) {
        Principal principal = new Principal(KIND_VENDOR, id, email, displayName, status,
                passwordHash, Rbac.Role.VENDOR, null, mobile, 0, Instant.EPOCH);
        storesById.put(id, principal);
        storeIdByEmail.put(email.toLowerCase(), id);
    }

    /** Test seam: move a staff or vendor row to a non-ACTIVE state. */
    synchronized void markPrincipalStatus(String kind, String id, String status) {
        Map<String, Principal> byId = KIND_STAFF.equals(kind) ? staffById : storesById;
        Principal principal = byId.get(id);
        if (principal == null) throw new IllegalArgumentException(kind + " " + id);
        byId.put(id, new Principal(principal.kind(), principal.id(), principal.email(),
                principal.fullName(), status, principal.passwordHash(), principal.role(),
                principal.lang(), principal.mobile(), principal.kycTier(), principal.createdAt()));
    }

    // -------------------------------------------------------------- SessionRepository

    @Override
    public synchronized void insert(String sessionId, String principalType, String principalId,
                                    String deviceLabel, Instant createdAt) {
        sessions.put(sessionId, new SessionRecord(sessionId, principalType, principalId,
                deviceLabel, createdAt, null));
    }

    @Override
    public synchronized Optional<SessionRecord> find(String sessionId) {
        return Optional.ofNullable(sessions.get(sessionId));
    }

    @Override
    public synchronized boolean isActive(String sessionId) {
        SessionRecord record = sessions.get(sessionId);
        return record != null && record.revokedAt() == null;
    }

    @Override
    public synchronized void revoke(String sessionId, Instant revokedAt) {
        SessionRecord record = sessions.get(sessionId);
        if (record != null) {
            sessions.put(sessionId, new SessionRecord(record.id(), record.principalType(),
                    record.principalId(), record.deviceLabel(), record.createdAt(), revokedAt));
        }
    }

    @Override
    public synchronized void markReuseDetected(String sessionId, Instant at) {
        revoke(sessionId, at);
    }

    @Override
    public synchronized int revokeOldestBeyondCap(String principalType, String principalId,
                                                  int cap, Instant at) {
        List<SessionRecord> live = sessions.values().stream()
                .filter(s -> s.principalType().equals(principalType)
                        && s.principalId().equals(principalId) && s.revokedAt() == null)
                .sorted(Comparator.comparing(SessionRecord::createdAt).thenComparing(SessionRecord::id))
                .toList();
        int doomed = Math.max(0, live.size() - cap);
        for (int i = 0; i < doomed; i++) revoke(live.get(i).id(), at);
        return doomed;
    }

    // ------------------------------------------------------ RefreshTokenRepository

    @Override
    public synchronized void insert(String tokenId, String sessionId, byte[] tokenHash,
                                    Instant issuedAt, Instant expiresAt) {
        refreshByHash.put(HexFormat.of().formatHex(tokenHash),
                new RefreshTokenRecord(tokenId, sessionId, issuedAt, expiresAt, null, null));
    }

    @Override
    public synchronized Optional<RefreshTokenRecord> findByHash(byte[] tokenHash) {
        return Optional.ofNullable(refreshByHash.get(HexFormat.of().formatHex(tokenHash)));
    }

    @Override
    public synchronized int markRotated(String tokenId, Instant usedAt, String successorId) {
        for (Map.Entry<String, RefreshTokenRecord> entry : refreshByHash.entrySet()) {
            RefreshTokenRecord record = entry.getValue();
            if (record.id().equals(tokenId) && !record.isUsed()) {
                entry.setValue(new RefreshTokenRecord(record.id(), record.sessionId(),
                        record.issuedAt(), record.expiresAt(), usedAt, successorId));
                return 1;
            }
        }
        return 0;
    }

    @Override
    public synchronized void revokeUnused(String sessionId, Instant at) {
        for (Map.Entry<String, RefreshTokenRecord> entry : refreshByHash.entrySet()) {
            RefreshTokenRecord record = entry.getValue();
            if (record.sessionId().equals(sessionId) && !record.isUsed()) {
                entry.setValue(new RefreshTokenRecord(record.id(), record.sessionId(),
                        record.issuedAt(), record.expiresAt(), at, record.replacedBy()));
            }
        }
    }

    // --------------------------------------------------------- MfaFactorRepository

    @Override
    public synchronized List<MfaFactorRecord> findActiveFor(String principalType, String principalId) {
        List<MfaFactorRecord> out = new ArrayList<>();
        for (MfaFactorRecord factor : factors.values()) {
            if (!factor.id().startsWith(principalType + ':' + principalId + ':')) continue;
            if (KIND_RECOVERY.equals(factor.kind()) && factor.isSpent()) continue;
            out.add(factor);
        }
        return List.copyOf(out);
    }

    @Override
    public synchronized void markRecoveryUsed(String factorId, Instant at) {
        MfaFactorRecord factor = factors.get(factorId);
        if (factor != null && !factor.isSpent()) {
            factors.put(factorId, new MfaFactorRecord(factor.id(), factor.kind(), factor.secretEnc(),
                    factor.codeHash(), at, factor.verifiedAt()));
        }
    }

    @Override
    public synchronized void markVerified(String factorId, Instant at) {
        MfaFactorRecord factor = factors.get(factorId);
        if (factor != null && factor.verifiedAt() == null) {
            factors.put(factorId, new MfaFactorRecord(factor.id(), factor.kind(), factor.secretEnc(),
                    factor.codeHash(), factor.usedAt(), at));
        }
    }

    /**
     * Test seam: enrol a factor for a principal. The stored record's {@code id} is rewritten
     * to the composite key, because {@link #findActiveFor} filters on {@code id} starting with
     * {@code principalType + ':' + principalId + ':'} and {@code markVerified} /
     * {@code markRecoveryUsed} address rows by the id {@code findActiveFor} returned — the
     * real schema's {@code id_mfa_factor} primary key is that same composite.
     */
    synchronized void enrol(String principalType, String principalId, MfaFactorRecord factor) {
        String composite = principalType + ':' + principalId + ':' + factor.id();
        factors.put(composite, new MfaFactorRecord(composite, factor.kind(), factor.secretEnc(),
                factor.codeHash(), factor.usedAt(), factor.verifiedAt()));
    }

    /** Test seam: move a customer to another {@code ck_customer_status} state. */
    synchronized void markStatus(String customerId, String status) {
        CustomerRecord customer = customersById.get(customerId);
        customersById.put(customerId, new CustomerRecord(customer.id(), customer.email(),
                customer.mobile(), customer.passwordHash(), customer.fullName(), status,
                customer.lang(), customer.kycTier(), customer.createdAt()));
    }

    /** Test seam: how many live sessions a principal currently holds. */
    synchronized long countActiveFor(String principalId) {
        return sessions.values().stream()
                .filter(s -> s.principalId().equals(principalId) && s.revokedAt() == null)
                .count();
    }
}
