package com.pixous.pixcart.identity.domain.admin;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * API & integration management — FR-ADM-016.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "manage API credentials for vendors/partners (scoped keys, OAuth clients),
 *                webhook subscriptions with signing secrets and retry policies, sandbox
 *                access, usage analytics and per-key rate limits."
 *   RULES:      "Keys auto-expire 12 months (rotation reminders at T-30/T-7); webhook retries
 *                1m/5m/30m/2h/6h then dead-letter with UI redrive."
 *   ACCEPTANCE: "Given a revoked key, When any call uses it, Then 401 with key-revoked code
 *                returns, and the event shows in the key's usage log within 1 min."
 *   VALIDATION: "Scopes least-privilege from catalogue; webhook URLs HTTPS +
 *                ownership-verified (challenge); rate tiers within plan."
 *
 * The acceptance criterion is met structurally: {@link #authorise} records every decision —
 * including refusals — in the key's usage log as part of the same call, so a rejected request
 * cannot fail to appear. Scopes are drawn from a published catalogue and bounded by the plan
 * tier, so a key can never hold more authority than its plan permits.
 */
public final class ApiCredentials {

    /** RULES: keys auto-expire after 12 months. */
    public static final Duration KEY_LIFETIME = Duration.ofDays(365);
    public static final Duration ROTATION_REMINDER_EARLY = Duration.ofDays(30);
    public static final Duration ROTATION_REMINDER_LATE = Duration.ofDays(7);

    /** RULES: webhook retry ladder, then dead-letter. */
    public static final List<Duration> RETRY_LADDER = List.of(
            Duration.ofMinutes(1), Duration.ofMinutes(5), Duration.ofMinutes(30),
            Duration.ofHours(2), Duration.ofHours(6));

    /** The published scope catalogue (VALIDATION: "scopes least-privilege from catalogue"). */
    public enum Scope {
        CATALOGUE_READ, CATALOGUE_WRITE, ORDER_READ, ORDER_WRITE,
        INVENTORY_WRITE, SETTLEMENT_READ, WEBHOOK_MANAGE
    }

    /** Plan tiers bound both the grantable scopes and the rate limit. */
    public enum PlanTier {
        SANDBOX(60, EnumSet.of(Scope.CATALOGUE_READ, Scope.ORDER_READ)),
        STANDARD(600, EnumSet.of(Scope.CATALOGUE_READ, Scope.CATALOGUE_WRITE, Scope.ORDER_READ,
                Scope.INVENTORY_WRITE, Scope.WEBHOOK_MANAGE)),
        PARTNER(6_000, EnumSet.allOf(Scope.class));

        private final int requestsPerMinute;
        private final Set<Scope> grantable;

        PlanTier(int requestsPerMinute, Set<Scope> grantable) {
            this.requestsPerMinute = requestsPerMinute;
            this.grantable = Set.copyOf(grantable);
        }

        public int requestsPerMinute() { return requestsPerMinute; }
        public Set<Scope> grantableScopes() { return grantable; }
    }

    /** Every authorisation decision, success or failure, lands here. */
    public record UsageEntry(Instant at, String keyId, String operation, int httpStatus, String code) {}

    public sealed interface AuthResult {
        record Allowed() implements AuthResult {}
        record Denied(int httpStatus, String code) implements AuthResult {}
    }

    public sealed interface Outcome {
        record Ok(String id) implements Outcome {}
        record Rejected(List<String> violations) implements Outcome {}
    }

    // ------------------------------------------------------------------ keys

    public static final class ApiKey {
        private final String keyId;
        private final String ownerId;
        private final PlanTier tier;
        private final Set<Scope> scopes;
        private final Instant createdAt;
        private final Instant expiresAt;
        private Instant revokedAt;
        private String revokeReason;
        private final List<Instant> callTimestamps = new ArrayList<>();

        ApiKey(String keyId, String ownerId, PlanTier tier, Set<Scope> scopes, Instant createdAt) {
            this.keyId = keyId;
            this.ownerId = ownerId;
            this.tier = tier;
            this.scopes = Set.copyOf(scopes);
            this.createdAt = createdAt;
            this.expiresAt = createdAt.plus(KEY_LIFETIME);
        }

        public boolean isRevoked()  { return revokedAt != null; }
        public boolean isExpired(Instant now) { return !now.isBefore(expiresAt); }
        public Instant expiresAt()  { return expiresAt; }
        public String keyId()       { return keyId; }
        public String ownerId()     { return ownerId; }
        public PlanTier tier()      { return tier; }
        public Set<Scope> scopes()  { return scopes; }
        public String revokeReason(){ return revokeReason; }

        /** RULES: rotation reminders at T-30 and T-7 days before expiry. */
        public List<String> rotationRemindersDue(Instant now) {
            var due = new ArrayList<String>();
            if (isRevoked()) return due;
            Instant early = expiresAt.minus(ROTATION_REMINDER_EARLY);
            Instant late = expiresAt.minus(ROTATION_REMINDER_LATE);
            if (!now.isBefore(early) && now.isBefore(late)) due.add("T-30");
            if (!now.isBefore(late) && now.isBefore(expiresAt)) due.add("T-7");
            return due;
        }
    }

    private final Map<String, ApiKey> keys = new LinkedHashMap<>();
    private final List<UsageEntry> usage = new ArrayList<>();

    /**
     * Issue a key. VALIDATION: requested scopes must exist in the catalogue (guaranteed by the
     * enum) and be grantable under the plan tier — least privilege is enforced upward, so a
     * SANDBOX key can never obtain write authority.
     */
    public Outcome issueKey(String keyId, String ownerId, PlanTier tier, Set<Scope> requestedScopes,
                            Instant now) {
        var v = new ArrayList<String>();
        if (requestedScopes.isEmpty()) v.add("AT_LEAST_ONE_SCOPE_REQUIRED");
        for (Scope s : requestedScopes) {
            if (!tier.grantableScopes().contains(s)) {
                v.add("SCOPE_NOT_IN_PLAN_TIER: " + s + " not grantable on " + tier);
            }
        }
        if (keys.containsKey(keyId)) v.add("DUPLICATE_KEY_ID");
        if (!v.isEmpty()) return new Outcome.Rejected(List.copyOf(v));
        keys.put(keyId, new ApiKey(keyId, ownerId, tier, requestedScopes, now));
        return new Outcome.Ok(keyId);
    }

    public Outcome revokeKey(String keyId, String reason, Instant now) {
        ApiKey k = keys.get(keyId);
        if (k == null) return new Outcome.Rejected(List.of("UNKNOWN_KEY"));
        if (reason == null || reason.isBlank()) return new Outcome.Rejected(List.of("REVOKE_REASON_REQUIRED"));
        k.revokedAt = now;
        k.revokeReason = reason;
        return new Outcome.Ok(keyId);
    }

    /**
     * Authorise a call. Every outcome — allowed or denied — is appended to the usage log in
     * this same call, which is what satisfies "the event shows in the key's usage log".
     * Revocation is checked before expiry and before scope, so a revoked key always reports
     * KEY_REVOKED rather than some later reason.
     */
    public AuthResult authorise(String keyId, Scope required, String operation, Instant now) {
        ApiKey k = keys.get(keyId);
        if (k == null) {
            usage.add(new UsageEntry(now, keyId, operation, 401, "KEY_UNKNOWN"));
            return new AuthResult.Denied(401, "KEY_UNKNOWN");
        }
        if (k.isRevoked()) {
            usage.add(new UsageEntry(now, keyId, operation, 401, "KEY_REVOKED"));
            return new AuthResult.Denied(401, "KEY_REVOKED");
        }
        if (k.isExpired(now)) {
            usage.add(new UsageEntry(now, keyId, operation, 401, "KEY_EXPIRED"));
            return new AuthResult.Denied(401, "KEY_EXPIRED");
        }
        if (!k.scopes().contains(required)) {
            usage.add(new UsageEntry(now, keyId, operation, 403, "SCOPE_NOT_GRANTED"));
            return new AuthResult.Denied(403, "SCOPE_NOT_GRANTED");
        }
        // per-key rate limit from the plan tier, sliding one minute
        Instant cutoff = now.minus(Duration.ofMinutes(1));
        k.callTimestamps.removeIf(t -> t.isBefore(cutoff));
        if (k.callTimestamps.size() >= k.tier().requestsPerMinute()) {
            usage.add(new UsageEntry(now, keyId, operation, 429, "RATE_LIMITED"));
            return new AuthResult.Denied(429, "RATE_LIMITED");
        }
        k.callTimestamps.add(now);
        usage.add(new UsageEntry(now, keyId, operation, 200, "OK"));
        return new AuthResult.Allowed();
    }

    public List<UsageEntry> usageLog(String keyId) {
        return usage.stream().filter(e -> e.keyId().equals(keyId)).toList();
    }

    public ApiKey key(String keyId) {
        return keys.get(keyId);
    }

    // -------------------------------------------------------------- webhooks

    public sealed interface DeliveryOutcome {
        record RetryAt(Instant when, int attempt) implements DeliveryOutcome {}
        record DeadLettered(int attempts) implements DeliveryOutcome {}
        record Delivered(int attempt) implements DeliveryOutcome {}
    }

    /** A webhook subscription. VALIDATION: HTTPS only, and ownership proven by challenge. */
    public static final class WebhookSubscription {
        private final String subscriptionId;
        private final String url;
        private final String signingSecret;
        private final Set<String> eventTypes;
        private final String challengeToken;
        private boolean verified;
        private boolean deadLettered;
        private int attempts;

        private WebhookSubscription(String subscriptionId, String url, String signingSecret,
                                    Set<String> eventTypes, String challengeToken) {
            this.subscriptionId = subscriptionId;
            this.url = url;
            this.signingSecret = signingSecret;
            this.eventTypes = Set.copyOf(eventTypes);
            this.challengeToken = challengeToken;
        }

        /** Ownership challenge: the endpoint must echo the exact token back. */
        public boolean verifyOwnership(String echoedToken) {
            this.verified = challengeToken.equals(echoedToken);
            return this.verified;
        }

        public boolean isVerified()    { return verified; }
        public boolean isDeadLettered(){ return deadLettered; }
        public int attempts()          { return attempts; }
        public String url()            { return url; }
        public String signingSecret()  { return signingSecret; }
        public String challengeToken() { return challengeToken; }
        public Set<String> eventTypes(){ return eventTypes; }
        public String subscriptionId() { return subscriptionId; }

        /**
         * Record a delivery attempt. On failure the next retry follows the documented ladder;
         * once the ladder is exhausted the message is dead-lettered for UI redrive.
         */
        public DeliveryOutcome recordAttempt(boolean succeeded, Instant now) {
            attempts++;
            if (succeeded) {
                deadLettered = false;
                return new DeliveryOutcome.Delivered(attempts);
            }
            if (attempts > RETRY_LADDER.size()) {
                deadLettered = true;
                return new DeliveryOutcome.DeadLettered(attempts);
            }
            return new DeliveryOutcome.RetryAt(now.plus(RETRY_LADDER.get(attempts - 1)), attempts);
        }

        /** UI redrive: clear the dead-letter state and start the ladder again. */
        public void redrive() {
            deadLettered = false;
            attempts = 0;
        }
    }

    public sealed interface SubscribeResult {
        record Ok(WebhookSubscription subscription) implements SubscribeResult {}
        record Rejected(List<String> violations) implements SubscribeResult {}
    }

    public static SubscribeResult subscribe(String subscriptionId, String url, String signingSecret,
                                            Set<String> eventTypes, String challengeToken) {
        var v = new ArrayList<String>();
        if (url == null || !url.startsWith("https://")) v.add("WEBHOOK_URL_MUST_BE_HTTPS");
        if (signingSecret == null || signingSecret.length() < 32) v.add("SIGNING_SECRET_TOO_SHORT");
        if (eventTypes == null || eventTypes.isEmpty()) v.add("AT_LEAST_ONE_EVENT_TYPE_REQUIRED");
        if (challengeToken == null || challengeToken.isBlank()) v.add("CHALLENGE_TOKEN_REQUIRED");
        if (!v.isEmpty()) return new SubscribeResult.Rejected(List.copyOf(v));
        return new SubscribeResult.Ok(
                new WebhookSubscription(subscriptionId, url, signingSecret, eventTypes, challengeToken));
    }
}
