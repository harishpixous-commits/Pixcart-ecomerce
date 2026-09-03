package com.pixous.pixcart.identity.domain.auth;

import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Session management and step-up MFA — FR-CUS-002 / FR-CUS-003.
 *
 * Normative source (Documentation Suite v1.0):
 *   FR-CUS-002 OUTPUTS: "Access JWT (15 min), refresh token (30 d, rotating, httpOnly), session
 *                        record (device, IP, geo), login notification on new device."
 *   FR-CUS-002 RULES:   "concurrent session limit 8 (oldest evicted)".
 *   FR-CUS-003 DESC:    "force step-up MFA for sensitive actions: payout-account edits (wallet),
 *                        password/mobile change, and first payment from a new device above
 *                        ₹5,000."
 *   FR-CUS-003 OUTPUTS: "recovery-code sheet (download once), step-up grant (10-min
 *                        scope-bound token)".
 *   FR-CUS-003 VALIDATION: "recovery code single-use; step-up token bound to action type and
 *                        session."
 *
 * The binding is the security property worth stating plainly: a step-up grant is valid for ONE
 * action type on ONE session for ten minutes. A grant obtained to change a password cannot be
 * replayed to edit a payout account, and a grant issued on a laptop cannot be presented from a
 * phone. Both are proven by tests rather than left to the caller's discipline.
 */
public final class SessionRegistry {

    public static final int MAX_CONCURRENT_SESSIONS = 8;
    public static final Duration ACCESS_TOKEN_TTL = Duration.ofMinutes(15);
    public static final Duration REFRESH_TOKEN_TTL = Duration.ofDays(30);
    public static final Duration STEP_UP_TTL = Duration.ofMinutes(10);
    public static final int RECOVERY_CODE_COUNT = 10;
    /** FR-CUS-003: first payment from a new device above this amount forces step-up. */
    public static final long NEW_DEVICE_STEP_UP_THRESHOLD_PAISE = 5_000 * 100;

    /** The sensitive actions that force step-up. */
    public enum SensitiveAction { PAYOUT_ACCOUNT_EDIT, PASSWORD_CHANGE, MOBILE_CHANGE, HIGH_VALUE_PAYMENT }

    public record Session(String sessionId, String customerId, String deviceFingerprint,
                          String deviceLabel, String ip, String geo, Instant createdAt,
                          Instant lastSeenAt) {}

    public record StepUpGrant(String grantId, String sessionId, SensitiveAction action,
                              Instant issuedAt, Instant expiresAt) {}

    /** Outcome of registering a session, including whether a new-device notice is owed. */
    public record LoginRegistration(Session session, boolean newDevice, List<String> evictedSessionIds) {}

    private final Map<String, List<Session>> byCustomer = new LinkedHashMap<>();
    private final Map<String, Session> byId = new LinkedHashMap<>();
    private final Map<String, StepUpGrant> grants = new LinkedHashMap<>();
    /** customerId -> hashed recovery codes not yet spent. */
    private final Map<String, List<String>> recoveryCodes = new LinkedHashMap<>();
    private final Map<String, java.util.Set<String>> knownDevices = new LinkedHashMap<>();

    /**
     * Register a new session. RULES: at most 8 concurrent; when a ninth arrives the OLDEST is
     * evicted (by creation time, not by last activity — a long-idle-but-recent session should
     * not outlive an older active one under this rule as written).
     */
    public LoginRegistration register(String customerId, String sessionId, String deviceFingerprint,
                                      String deviceLabel, String ip, String geo, Instant now) {
        var sessions = byCustomer.computeIfAbsent(customerId, k -> new ArrayList<>());
        var devices = knownDevices.computeIfAbsent(customerId, k -> new java.util.LinkedHashSet<>());
        boolean newDevice = !devices.contains(deviceFingerprint);

        var session = new Session(sessionId, customerId, deviceFingerprint, deviceLabel, ip, geo, now, now);
        sessions.add(session);
        byId.put(sessionId, session);
        devices.add(deviceFingerprint);

        var evicted = new ArrayList<String>();
        while (sessions.size() > MAX_CONCURRENT_SESSIONS) {
            Session oldest = sessions.stream().min(Comparator.comparing(Session::createdAt)).orElseThrow();
            sessions.remove(oldest);
            byId.remove(oldest.sessionId());
            grants.values().removeIf(g -> g.sessionId().equals(oldest.sessionId()));
            evicted.add(oldest.sessionId());
        }
        return new LoginRegistration(session, newDevice, List.copyOf(evicted));
    }

    /** Sessions listable per device (FR-CUS-002 DESC). */
    public List<Session> sessionsOf(String customerId) {
        return List.copyOf(byCustomer.getOrDefault(customerId, List.of()));
    }

    /** Revoke one session; any step-up grant bound to it dies with it. */
    public boolean revoke(String sessionId) {
        Session s = byId.remove(sessionId);
        if (s == null) return false;
        byCustomer.getOrDefault(s.customerId(), new ArrayList<>()).removeIf(x -> x.sessionId().equals(sessionId));
        grants.values().removeIf(g -> g.sessionId().equals(sessionId));
        return true;
    }

    public int revokeAllExcept(String customerId, String keepSessionId) {
        var sessions = byCustomer.getOrDefault(customerId, new ArrayList<>());
        var doomed = sessions.stream().map(Session::sessionId)
                .filter(id -> !id.equals(keepSessionId)).toList();
        doomed.forEach(this::revoke);
        return doomed.size();
    }

    public boolean isActive(String sessionId) {
        return byId.containsKey(sessionId);
    }

    // ------------------------------------------------------------- step-up

    /** Whether an action requires step-up. High-value payment only does from a NEW device. */
    public static boolean requiresStepUp(SensitiveAction action, boolean newDevice, long amountPaise) {
        return switch (action) {
            case PAYOUT_ACCOUNT_EDIT, PASSWORD_CHANGE, MOBILE_CHANGE -> true;
            case HIGH_VALUE_PAYMENT -> newDevice && amountPaise > NEW_DEVICE_STEP_UP_THRESHOLD_PAISE;
        };
    }

    /** Issue a scope-bound grant after a successful MFA challenge. */
    public StepUpGrant grantStepUp(String grantId, String sessionId, SensitiveAction action, Instant now) {
        if (!isActive(sessionId)) throw new IllegalStateException("cannot grant step-up on an inactive session");
        var grant = new StepUpGrant(grantId, sessionId, action, now, now.plus(STEP_UP_TTL));
        grants.put(grantId, grant);
        return grant;
    }

    /**
     * VALIDATION: a grant is bound to the action type AND the session, and expires in 10 minutes.
     * All three conditions are checked here so no caller can satisfy two and skip the third.
     */
    public boolean isStepUpSatisfied(String grantId, String sessionId, SensitiveAction action, Instant now) {
        StepUpGrant g = grants.get(grantId);
        if (g == null) return false;
        if (!g.sessionId().equals(sessionId)) return false;     // bound to the session
        if (g.action() != action) return false;                 // bound to the action type
        return now.isBefore(g.expiresAt());                     // and time-bound
    }

    /** A grant is consumed on use, so it cannot be replayed even inside its window. */
    public boolean consumeStepUp(String grantId, String sessionId, SensitiveAction action, Instant now) {
        if (!isStepUpSatisfied(grantId, sessionId, action, now)) return false;
        grants.remove(grantId);
        return true;
    }

    // ------------------------------------------------------ recovery codes

    /** Issue the one-time sheet of 10 codes; only their hashes are retained. */
    public List<String> issueRecoveryCodes(String customerId, List<String> plainCodes) {
        if (plainCodes.size() != RECOVERY_CODE_COUNT) {
            throw new IllegalArgumentException("exactly " + RECOVERY_CODE_COUNT + " recovery codes are issued");
        }
        var hashes = new ArrayList<String>();
        for (String c : plainCodes) hashes.add(sha256(c));
        recoveryCodes.put(customerId, hashes);
        return List.copyOf(plainCodes);   // the sheet is downloadable once; we keep only hashes
    }

    /** VALIDATION: a recovery code is single-use. */
    public boolean redeemRecoveryCode(String customerId, String plainCode) {
        var hashes = recoveryCodes.get(customerId);
        if (hashes == null) return false;
        String h = sha256(plainCode);
        return hashes.remove(h);          // removal is the single-use guarantee
    }

    public int recoveryCodesRemaining(String customerId) {
        return recoveryCodes.getOrDefault(customerId, List.of()).size();
    }

    /** ERRORS: when every recovery code is spent, identity re-verification is the only path. */
    public boolean requiresIdentityReverification(String customerId) {
        return recoveryCodesRemaining(customerId) == 0;
    }

    public Optional<Session> session(String sessionId) {
        return Optional.ofNullable(byId.get(sessionId));
    }

    private static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(64);
            for (byte b : d) hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
