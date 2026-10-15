package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.domain.auth.LoginPolicy;
import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.auth.Totp;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import com.pixous.pixcart.identity.domain.throttle.SlidingWindowThrottle;
import com.pixous.pixcart.identity.domain.Ulid;
import com.pixous.pixcart.identity.repository.CustomerRepository;
import com.pixous.pixcart.identity.repository.MfaFactorRepository;
import com.pixous.pixcart.identity.repository.PrincipalRepository;
import com.pixous.pixcart.identity.repository.RefreshRotation;
import com.pixous.pixcart.identity.repository.RefreshTokenRepository;
import com.pixous.pixcart.identity.repository.SessionRepository;
import com.pixous.pixcart.identity.security.JwtService;
import com.pixous.pixcart.identity.security.MfaSecretCipher;
import com.pixous.pixcart.identity.security.PasswordHasher;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * The FR-CUS-001 / FR-CUS-002 / FR-CUS-003 flows, binding the frozen {@code domain} package
 * to the V001/V002/V008 schema and the HS256 issuer.
 *
 * <p>Every decision is delegated, never re-implemented: password acceptance is
 * {@code Rbac.PasswordPolicy}, lockout and the no-enumeration response are
 * {@code LoginPolicy}, the concurrent-session cap is
 * {@code SessionRegistry.MAX_CONCURRENT_SESSIONS}, TOTP is {@code Totp}, and the
 * permission matrix is {@code Rbac.access}. What lives here is only the wiring — which
 * table a decision is read from and written to.
 *
 * <p><b>Which table a principal is read from</b> is {@code PrincipalRepository}'s single
 * three-way fan-out. Sign-in accepts a customer, a staff member or a vendor operator, all
 * through the <em>same</em> {@code LoginPolicy} attempt, the same throttle and the same
 * no-enumeration response, so the caller cannot tell which of the three was consulted.
 * What differs is the role claim: a customer row can only ever claim {@code CUSTOMER}, a
 * staff row claims whatever {@code id_staff.role} records, and a vendor store claims
 * {@code VENDOR}. Registration remains customer-only — staff and vendor accounts are
 * provisioned by an operator (V008), never self-served.
 */
@Service
public final class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);

    private static final String LANG_DEFAULT = "en";

    /** Vol. 7 §7.2: "auth endpoints 20/min/IP". */
    private static final int AUTH_RATE_PER_IP = 20;
    private static final Duration AUTH_RATE_WINDOW = Duration.ofMinutes(1);
    /** Bounds the per-IP throttle map; entries with a fully restored budget are droppable. */
    private static final int THROTTLE_MAP_CEILING = 4096;

    private static final SecureRandom RNG = new SecureRandom();

    /** Which endpoint a budget belongs to, so logins do not consume refreshes' allowance. */
    private enum Budget { REGISTER, LOGIN, REFRESH, STEP_UP }

    // ------------------------------------------------------------------ responses

    public record UserView(String id, String email, String mobile, String fullName, String role,
                           String status, int kycTier, String lang) {
    }

    public record AuthResponse(String accessToken, String refreshToken, long expiresInMs,
                               UserView user, boolean requiresStepUp) {
    }

    public record StepUpResponse(String stepUpToken, long validForMs) {
    }

    public record MeView(String subject, String role, String sessionId, UserView profile) {
    }

    /** Exactly the shape the Node BFF parses in {@code services/bff/src/auth.ts}. */
    public record IntrospectResponse(boolean active, String subject, String role,
                                     String sessionId, boolean stepUpSatisfied) {
    }

    public record CanResponse(boolean permitted, String access) {
    }

    // -------------------------------------------------------------------- commands

    public record RegisterCommand(String email, String password, String fullName, String deviceLabel) {
    }

    public record LoginCommand(String email, String password, String deviceLabel) {
    }

    public record StepUpCommand(String action, String code) {
    }

    private final CustomerRepository customerRepository;
    private final PrincipalRepository principalRepository;
    private final SessionRepository sessionRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final MfaFactorRepository mfaFactorRepository;
    private final JwtService jwtService;
    private final PasswordHasher passwordHasher;
    private final MfaSecretCipher mfaSecretCipher;
    private final LoginPolicy loginPolicy = new LoginPolicy();
    private final ConcurrentMap<String, SlidingWindowThrottle> throttles = new ConcurrentHashMap<>();

    public AuthService(CustomerRepository customerRepository,
                       PrincipalRepository principalRepository,
                       SessionRepository sessionRepository,
                       RefreshTokenRepository refreshTokenRepository,
                       MfaFactorRepository mfaFactorRepository,
                       JwtService jwtService,
                       PasswordHasher passwordHasher,
                       MfaSecretCipher mfaSecretCipher) {
        this.customerRepository = customerRepository;
        this.principalRepository = principalRepository;
        this.sessionRepository = sessionRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.mfaFactorRepository = mfaFactorRepository;
        this.jwtService = jwtService;
        this.passwordHasher = passwordHasher;
        this.mfaSecretCipher = mfaSecretCipher;
    }

    /**
     * Inverse of the mapping {@code JdbcPrincipalRepository} applies when reading a row.
     *
     * <p>A token's role claim names which table its subject lives in, and the mapping is a
     * bijection by construction: a customer row can only ever mint {@code CUSTOMER}, a
     * vendor store only ever {@code VENDOR}, and the seven remaining roles are exactly
     * {@code id_staff.role}'s vocabulary (V002 {@code ck_staff_role}). So this is a lookup,
     * not an inference — it cannot be fooled by presenting a staff role for a customer id,
     * because such a session row is never written.
     */
    private static String kindOf(Rbac.Role role) {
        return switch (role) {
            case CUSTOMER -> PrincipalRepository.KIND_CUSTOMER;
            case VENDOR -> PrincipalRepository.KIND_VENDOR;
            default -> PrincipalRepository.KIND_STAFF;
        };
    }

    // ----------------------------------------------------------------- FR-CUS-001

    /** FR-CUS-001: register a customer, then issue the same tokens a login would. */
    public AuthResponse register(RegisterCommand command, String ip, Instant now) {
        if (command == null) throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, "a JSON body is required");
        String email = normaliseEmail(command.email());
        String fullName = require(command.fullName(), "fullName", 120);
        String deviceLabel = optionalLabel(command.deviceLabel());
        char[] password = command.password() == null ? new char[0] : command.password().toCharArray();
        try {
            // The policy is the domain's; the adapter only reports its verdict, verbatim.
            List<Rbac.PasswordPolicy.Violation> violations = Rbac.PasswordPolicy.validate(password);
            if (!violations.isEmpty()) {
                throw ApiException.badRequest(ApiException.PASSWORD_POLICY_REJECTED,
                        "the password violates the platform policy: " + violationNames(violations));
            }
            throttle(Budget.REGISTER, ip, now);

            if (customerRepository.findByEmailNorm(email).isPresent()) {
                throw ApiException.conflict(ApiException.EMAIL_ALREADY_REGISTERED,
                        "a customer with that email address is already registered");
            }
            String encoded = passwordHasher.encode(password);
            String customerId = Ulid.next();
            CustomerRepository.CustomerRecord created;
            try {
                created = customerRepository.insert(new CustomerRepository.CustomerRecord(
                        customerId, email, null, encoded, fullName,
                        PrincipalRepository.STATUS_ACTIVE, LANG_DEFAULT, 0, now));
            } catch (DuplicateKeyException e) {
                // Lost the race to a concurrent register on the same address.
                throw ApiException.conflict(ApiException.EMAIL_ALREADY_REGISTERED,
                        "a customer with that email address is already registered");
            }
            log.info("registered customer {}", customerId);
            return issue(asPrincipal(created), Ulid.next(), deviceLabel, now);
        } finally {
            PasswordHasher.wipe(password);
        }
    }

    // ----------------------------------------------------------------- FR-CUS-002

    /**
     * FR-CUS-002: verify credentials under {@code LoginPolicy}, then open a session.
     *
     * <p>Accepts a customer, a staff member or a vendor operator. All three take the
     * <em>same</em> policy path — one throttle, one failure counter, one no-enumeration
     * response — so an address that exists on {@code id_staff} is not distinguishable from
     * one that exists nowhere. What the three differ in is the role claim on the token,
     * which comes from the row itself and never from the request.
     *
     * <p>{@code accountExists} is true when the address resolves on <em>any</em> of the
     * three tables. A row that resolves but carries no {@code password_hash} (V008 leaves
     * it NULL until an operator provisions it) counts as existing with a failed credential:
     * {@code PasswordHasher.matches} fails closed on null, so the caller gets the ordinary
     * bad-credentials refusal rather than a distinct "unprovisioned" signal that would
     * enumerate which accounts have been set up.
     */
    public AuthResponse login(LoginCommand command, String ip, Instant now) {
        if (command == null) throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, "a JSON body is required");
        String email = normaliseEmail(command.email());
        String deviceLabel = optionalLabel(command.deviceLabel());
        char[] password = command.password() == null ? new char[0] : command.password().toCharArray();
        try {
            throttle(Budget.LOGIN, ip, now);

            Optional<PrincipalRepository.Principal> found = principalRepository.resolveByEmailNorm(email);
            boolean accountExists = found.isPresent();
            // Each table owns its own status vocabulary and they do not share a word for
            // "usable" — ven_store says APPROVED, the other two say ACTIVE — so the mapping
            // is Principal.isUsable's, not a string comparison repeated here. Everything
            // else (SUSPENDED, DELETION_PENDING, DELETED, PENDING, REJECTED, PAUSED) is
            // refused as suspended rather than inventing a per-table state machine the
            // domain does not model.
            LoginPolicy.AccountState state = (accountExists && found.get().isUsable())
                    ? LoginPolicy.AccountState.ACTIVE
                    : LoginPolicy.AccountState.SUSPENDED;
            boolean credentialOk = accountExists
                    && passwordHasher.matches(password, found.get().passwordHash());

            String sessionId = Ulid.next();
            // mfaEnabled is false by design: FR-CUS-003 gates *sensitive actions*, not sign-in.
            // Whether the account can step up at all is reported as `requiresStepUp`.
            LoginPolicy.Result result = synchronizedLoginPolicyAttempt(
                    email, accountExists, state, credentialOk, sessionId, now);

            if (result instanceof LoginPolicy.Result.Success) {
                return issue(found.get(), sessionId, deviceLabel, now);
            }
            if (result instanceof LoginPolicy.Result.BadCredentials bad) {
                throw ApiException.unauthorised(bad.code(),
                        "the email address or password is incorrect (" + bad.attemptsRemaining()
                                + " attempts remain before the account is locked)");
            }
            if (result instanceof LoginPolicy.Result.Locked locked) {
                throw ApiException.forbidden(locked.code(),
                        "the account is locked until " + locked.unlockAt()
                                + "; reset it at " + locked.resetPath());
            }
            if (result instanceof LoginPolicy.Result.Suspended suspended) {
                throw ApiException.forbidden(suspended.code(),
                        "the account is not active; contact support at " + suspended.supportUrl());
            }
            if (result instanceof LoginPolicy.Result.MfaRequired mfa) {
                // Unreachable while mfaEnabled is false, and answered correctly if that ever
                // changes: refuse rather than issue tokens around a failed challenge.
                throw ApiException.unauthorised(mfa.code(), "a multi-factor challenge is required: " + mfa.challengeId());
            }
            throw new IllegalStateException("unhandled LoginPolicy.Result " + result.getClass());
        } finally {
            PasswordHasher.wipe(password);
        }
    }

    private LoginPolicy.Result synchronizedLoginPolicyAttempt(String identifier, boolean accountExists,
                                                              LoginPolicy.AccountState state,
                                                              boolean credentialOk, String sessionId, Instant now) {
        // LoginPolicy keys its failure counters in a plain map; the adapter owns the lock.
        synchronized (loginPolicy) {
            return loginPolicy.attempt(identifier, accountExists, state, credentialOk,
                    false, sessionId, now);
        }
    }

    /**
     * FR-CUS-002 / Vol. 10 §10.3: rotate the refresh token; a replayed (already rotated)
     * token revokes the whole family, which is the session row.
     */
    public AuthResponse refresh(String presentedToken, Instant now) {
        if (presentedToken == null || presentedToken.isBlank()) {
            throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, "refreshToken is required");
        }
        Optional<RefreshTokenRepository.RefreshTokenRecord> found =
                refreshTokenRepository.findByHash(sha256(presentedToken));
        if (found.isEmpty()) {
            throw ApiException.unauthorised(ApiException.REFRESH_TOKEN_INVALID, "the refresh token is not recognised");
        }
        RefreshTokenRepository.RefreshTokenRecord record = found.get();
        boolean sessionActive = sessionRepository.isActive(record.sessionId());
        RefreshRotation.Outcome outcome = RefreshRotation.decide(
                sessionActive, true, record.isUsed(), !now.isBefore(record.expiresAt()));

        switch (outcome) {
            case FAMILY_REVOKED -> throw ApiException.unauthorised(ApiException.REFRESH_TOKEN_INVALID,
                    "the session this refresh token belongs to has been revoked");
            case UNKNOWN_TOKEN -> throw ApiException.unauthorised(ApiException.REFRESH_TOKEN_INVALID,
                    "the refresh token is not recognised");
            case EXPIRED -> throw ApiException.unauthorised(ApiException.REFRESH_TOKEN_EXPIRED,
                    "the refresh token has expired; sign in again");
            case REUSE_DETECTED -> {
                // Vol. 10 §10.3: reuse ⇒ revoke the family. Both the session and any
                // still-current sibling token die, so a stolen successor is worthless too.
                sessionRepository.markReuseDetected(record.sessionId(), now);
                refreshTokenRepository.revokeUnused(record.sessionId(), now);
                log.warn("refresh-token reuse detected on session {}", record.sessionId());
                throw ApiException.unauthorised(ApiException.REFRESH_TOKEN_REUSE_DETECTED,
                        "this refresh token was already used; the session has been revoked as a precaution");
            }
            case ROTATED -> {
                // fall through to the rotation below
            }
        }

        SessionRepository.SessionRecord session = sessionRepository.find(record.sessionId())
                .orElseThrow(() -> ApiException.unauthorised(ApiException.REFRESH_TOKEN_INVALID,
                        "the session this refresh token belongs to no longer exists"));
        // The session row records which of the three tables its subject lives in, so a
        // rotation re-issues the SAME role the original login did. Reading the role from
        // the row rather than from the presented token matters: a token is untrusted input,
        // and re-deriving the role from it would let a forged claim survive a rotation.
        PrincipalRepository.Principal principal = principalRepository
                .findById(session.principalType(), session.principalId())
                .orElseThrow(() -> ApiException.unauthorised(ApiException.REFRESH_TOKEN_INVALID,
                        "the principal this session belongs to no longer exists"));

        String successorId = Ulid.next();
        if (refreshTokenRepository.markRotated(record.id(), now, successorId) != 1) {
            // Compare-and-set lost: another request rotated this token microseconds ago.
            sessionRepository.markReuseDetected(record.sessionId(), now);
            refreshTokenRepository.revokeUnused(record.sessionId(), now);
            throw ApiException.unauthorised(ApiException.REFRESH_TOKEN_REUSE_DETECTED,
                    "this refresh token was already used; the session has been revoked as a precaution");
        }
        String successor = newOpaqueToken();
        // The family keeps its ORIGINAL expiry: rotation must not extend a session forever.
        refreshTokenRepository.insert(successorId, record.sessionId(), sha256(successor), now, record.expiresAt());
        return new AuthResponse(
                jwtService.signAccessToken(principal.id(), record.sessionId(), principal.role(), now),
                successor,
                SessionRegistry.ACCESS_TOKEN_TTL.toMillis(),
                view(principal),
                hasEnrolledMfa(principal.kind(), principal.id()));
    }

    /** Revokes the caller's session; every access token bound to it dies at the next hop. */
    public void logout(String sessionId, Instant now) {
        sessionRepository.revoke(sessionId, now);
        refreshTokenRepository.revokeUnused(sessionId, now);
    }

    public MeView me(JwtService.TokenPrincipal principal) {
        // The token's role claim determines which table to read, and the role claim was
        // itself derived from a row when the token was minted — so this cannot be used to
        // read across principals. A STAFF role can only ever name an id_staff row.
        PrincipalRepository.Principal resolved = principalRepository
                .findById(kindOf(principal.role()), principal.subject())
                .orElseThrow(() -> ApiException.unauthorised(ApiException.PRINCIPAL_NOT_FOUND,
                        "the principal this token names no longer exists"));
        return new MeView(resolved.id(), principal.role().name(), principal.sessionId(), view(resolved));
    }

    /**
     * The BFF's introspection call. Always HTTP 200 for a well-formed body — including
     * {@code active:false} — because the BFF treats a transport error as "anonymous" and a
     * non-200 here would be indistinguishable from an outage.
     */
    public IntrospectResponse introspect(String token, Instant now) {
        JwtService.TokenPrincipal principal;
        try {
            principal = jwtService.verify(token, now);
        } catch (RuntimeException e) {
            return new IntrospectResponse(false, null, null, null, false);
        }
        if (!sessionRepository.isActive(principal.sessionId())) {
            return new IntrospectResponse(false, null, null, null, false);
        }
        // A step-up grant is itself a token; only presenting it proves the step-up.
        return new IntrospectResponse(true, principal.subject(), principal.role().name(),
                principal.sessionId(), principal.isStepUpGrant());
    }

    /** Single source of truth for the permission matrix (Vol. 2 §2.4 via {@code Rbac}). */
    public CanResponse can(String roleName, String capabilityName) {
        Rbac.Role role = parseEnum(Rbac.Role.class, roleName, ApiException.ROLE_UNKNOWN, "role");
        Rbac.Capability capability = parseEnum(Rbac.Capability.class, capabilityName,
                ApiException.CAPABILITY_UNKNOWN, "capability");
        return new CanResponse(Rbac.permits(role, capability), Rbac.access(role, capability).name());
    }

    // ----------------------------------------------------------------- FR-CUS-003

    /**
     * FR-CUS-003: accept a TOTP code or a recovery code and mint the scope-bound grant.
     *
     * <p>The grant is the returned JWT, carrying {@code act}. Vol. 10 §10.3 requires it to be
     * bound to an action type, a session and a ten-minute window; all three are claims on the
     * token, because V002 has no table to hang an in-memory {@code StepUpGrant} on and the
     * domain package is frozen.
     */
    public StepUpResponse stepUp(JwtService.TokenPrincipal principal, StepUpCommand command, String ip, Instant now) {
        if (principal == null) throw ApiException.unauthorised(ApiException.AUTH_REQUIRED,
                "this endpoint requires a valid access token");
        if (command == null) throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, "a JSON body is required");
        throttle(Budget.STEP_UP, ip, now);

        SessionRegistry.SensitiveAction action;
        try {
            action = SessionRegistry.SensitiveAction.valueOf(
                    command.action() == null ? "" : command.action().trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(ApiException.STEP_UP_ACTION_UNKNOWN,
                    "action must be one of " + List.of(SessionRegistry.SensitiveAction.values()));
        }
        if (command.code() == null || command.code().isBlank()) {
            throw ApiException.badRequest(ApiException.STEP_UP_PROOF_REQUIRED,
                    "code is required: a 6-digit TOTP code or a recovery code");
        }
        if (principal.role() != Rbac.Role.CUSTOMER) {
            throw ApiException.forbidden(ApiException.AUTH_REQUIRED,
                    "step-up is only supported for customer principals in this service");
        }
        if (!sessionRepository.isActive(principal.sessionId())) {
            throw ApiException.unauthorised(ApiException.SESSION_INACTIVE,
                    "the session this token is bound to is no longer active");
        }

        String proof = command.code().trim();
        List<MfaFactorRepository.MfaFactorRecord> factors =
                mfaFactorRepository.findActiveFor(PrincipalRepository.KIND_CUSTOMER, principal.subject());
        if (factors.isEmpty()) {
            throw ApiException.forbidden("E-AUTH-011",
                    "no MFA factor is enrolled for this principal, so it cannot satisfy a step-up challenge");
        }

        for (MfaFactorRepository.MfaFactorRecord factor : factors) {
            if (!MfaFactorRepository.KIND_TOTP.equals(factor.kind())) continue;
            if (factor.secretEnc() == null) continue;
            String secret = mfaSecretCipher.decrypt(factor.secretEnc());
            if (Totp.verify(secret, proof, now)) {
                mfaFactorRepository.markVerified(factor.id(), now);
                return grant(principal, action, now);
            }
        }
        byte[] proofDigest = sha256Hex(proof);
        for (MfaFactorRepository.MfaFactorRecord factor : factors) {
            if (!MfaFactorRepository.KIND_RECOVERY.equals(factor.kind())) continue;
            if (factor.isSpent()) continue;
            if (MfaSecretCipher.constantTimeEquals(factor.codeHash(), proofDigest)) {
                // The spend is the single-use guarantee, exactly as SessionRegistry models it.
                mfaFactorRepository.markRecoveryUsed(factor.id(), now);
                return grant(principal, action, now);
            }
        }
        throw ApiException.unauthorised("E-AUTH-011",
                "the supplied step-up proof did not verify");
    }

    private StepUpResponse grant(JwtService.TokenPrincipal principal,
                                 SessionRegistry.SensitiveAction action, Instant now) {
        String token = jwtService.signStepUpToken(principal.subject(), principal.sessionId(),
                principal.role(), action, now);
        return new StepUpResponse(token, SessionRegistry.STEP_UP_TTL.toMillis());
    }

    // --------------------------------------------------------------------- helpers

    private AuthResponse issue(PrincipalRepository.Principal principal, String sessionId,
                               String deviceLabel, Instant now) {
        sessionRepository.insert(sessionId, principal.kind(), principal.id(), deviceLabel, now);
        // The cap is per (kind, id): a vendor operator holding eight sessions must not
        // evict a staff member who happens to share a ULID namespace, and a customer's
        // eight devices must not evict their own staff account if they have one.
        int evicted = sessionRepository.revokeOldestBeyondCap(
                principal.kind(), principal.id(), SessionRegistry.MAX_CONCURRENT_SESSIONS, now);
        if (evicted > 0) {
            log.info("evicted {} session(s) beyond the concurrent cap of {} for {} {}",
                    evicted, SessionRegistry.MAX_CONCURRENT_SESSIONS, principal.kind(), principal.id());
        }
        String refreshToken = newOpaqueToken();
        refreshTokenRepository.insert(Ulid.next(), sessionId, sha256(refreshToken), now,
                now.plus(SessionRegistry.REFRESH_TOKEN_TTL));
        String accessToken = jwtService.signAccessToken(principal.id(), sessionId, principal.role(), now);
        return new AuthResponse(accessToken, refreshToken,
                SessionRegistry.ACCESS_TOKEN_TTL.toMillis(), view(principal),
                hasEnrolledMfa(principal.kind(), principal.id()));
    }

    /**
     * A row with no {@code password_hash} cannot enrol MFA either: the enrolment flow is
     * reached through a step-up, which is reached through a sign-in, which that row cannot
     * complete. Reporting {@code false} here is not a decision to skip a check — it is the
     * only reachable answer.
     */
    private boolean hasEnrolledMfa(String principalKind, String principalId) {
        return !mfaFactorRepository.findActiveFor(principalKind, principalId).isEmpty();
    }

    /** A customer row as a principal, for the register path that still holds one. */
    private static PrincipalRepository.Principal asPrincipal(CustomerRepository.CustomerRecord customer) {
        return new PrincipalRepository.Principal(PrincipalRepository.KIND_CUSTOMER, customer.id(),
                customer.email(), customer.fullName(), customer.status(), customer.passwordHash(),
                Rbac.Role.CUSTOMER, customer.lang(), customer.mobile(), customer.kycTier(),
                customer.createdAt());
    }

    /**
     * Staff and vendor rows have no locale and no KYC tier, so both are reported as
     * null/0 rather than as a default a customer would then be unable to distinguish from
     * a real value. The BFF renders the field as absent for those two kinds. {@code mobile}
     * is passed through as-is: {@code ven_store} has one, {@code id_staff} does not.
     */
    private static UserView view(PrincipalRepository.Principal principal) {
        return new UserView(principal.id(), principal.email(), principal.mobile(), principal.fullName(),
                principal.role().name(), principal.status(), principal.kycTier(),
                principal.lang() == null ? LANG_DEFAULT : principal.lang());
    }

    private void throttle(Budget budget, String ip, Instant now) {
        String key = budget.name() + '|' + (ip == null || ip.isBlank() ? "-" : ip);
        // Prune first, and without holding this budget's lock: taking other throttles' locks
        // inside one would invert lock order between two concurrent callers.
        evictStaleThrottles(now);
        SlidingWindowThrottle throttle = throttles.computeIfAbsent(key,
                k -> new SlidingWindowThrottle(AUTH_RATE_PER_IP, AUTH_RATE_WINDOW));
        boolean admitted;
        // SlidingWindowThrottle is deliberately framework-free and single-threaded; the
        // adapter owns the lock (Vol. 10: cross-node distribution is the adapter's job).
        synchronized (throttle) {
            admitted = throttle.tryAcquire(now);
        }
        if (!admitted) {
            throw ApiException.tooManyRequests(ApiException.THROTTLED,
                    "auth endpoints accept at most " + AUTH_RATE_PER_IP + " requests per minute per IP");
        }
    }

    private void evictStaleThrottles(Instant now) {
        if (throttles.size() < THROTTLE_MAP_CEILING) return;
        throttles.entrySet().removeIf(entry -> {
            SlidingWindowThrottle t = entry.getValue();
            synchronized (t) {
                return t.available(now) == AUTH_RATE_PER_IP;   // fully restored ⇒ no live events
            }
        });
    }

    private static String normaliseEmail(String email) {
        String value = require(email, "email", 254);
        int at = value.indexOf('@');
        if (at <= 0 || at != value.lastIndexOf('@') || at == value.length() - 1 || value.chars().anyMatch(Character::isWhitespace)) {
            throw ApiException.badRequest(ApiException.MALFORMED_REQUEST,
                    "email must be a single well-formed address");
        }
        return value.toLowerCase(Locale.ROOT);
    }

    private static String require(String value, String field, int max) {
        if (value == null || value.isBlank()) {
            throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, field + " is required");
        }
        String trimmed = value.trim();
        if (trimmed.length() > max) {
            throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, field + " must be at most " + max + " characters");
        }
        return trimmed;
    }

    private static String optionalLabel(String deviceLabel) {
        if (deviceLabel == null || deviceLabel.isBlank()) return null;
        return require(deviceLabel, "deviceLabel", 120);
    }

    private static <E extends Enum<E>> E parseEnum(Class<E> type, String raw, String code, String field) {
        List<E> allowed = List.of(type.getEnumConstants());
        if (raw == null || raw.isBlank()) {
            throw ApiException.badRequest(code, field + " is required and must be one of " + allowed);
        }
        try {
            return Enum.valueOf(type, raw.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(code, field + " is not an accepted value; must be one of " + allowed);
        }
    }

    private static String violationNames(List<Rbac.PasswordPolicy.Violation> violations) {
        List<String> names = new ArrayList<>(violations.size());
        for (Rbac.PasswordPolicy.Violation violation : violations) names.add(violation.name());
        return String.join(", ", names);
    }

    /** 32 CSPRNG bytes, base64url — the opaque refresh token of Vol. 10 §10.3. */
    static String newOpaqueToken() {
        byte[] raw = new byte[32];
        RNG.nextBytes(raw);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    /** Only the digest of a refresh token is ever stored (V002 {@code token_hash}). */
    static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /**
     * Recovery-code digests take the domain's own form: {@code SessionRegistry.issueRecoveryCodes}
     * hashes to 64 hex characters, which is exactly what {@code id_mfa_factor.code_hash}
     * ({@code VARBINARY(64)}) is sized for. Storing the raw 32-byte digest instead would mean
     * this adapter had quietly chosen a second representation of the same code.
     */
    static byte[] sha256Hex(String value) {
        return HexFormat.of().formatHex(sha256(value)).getBytes(StandardCharsets.US_ASCII);
    }
}
