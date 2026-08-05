package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.identity.domain.admin.ApiCredentials.AuthResult;
import com.pixous.pixcart.identity.domain.admin.ApiCredentials.DeliveryOutcome;
import com.pixous.pixcart.identity.domain.admin.ApiCredentials.Outcome;
import com.pixous.pixcart.identity.domain.admin.ApiCredentials.PlanTier;
import com.pixous.pixcart.identity.domain.admin.ApiCredentials.Scope;
import com.pixous.pixcart.identity.domain.admin.ApiCredentials.SubscribeResult;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** FR-ADM-016, including the revoked-key acceptance scenario and the webhook retry ladder. */
class ApiCredentialsTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");
    private static final String SECRET = "s".repeat(40);

    // ---------------------------------------------------------------- keys

    @Test
    void revokedKeyAcceptanceScenario() {
        // "Given a revoked key, When any call uses it, Then 401 with key-revoked code returns,
        //  and the event shows in the key's usage log."
        var c = new ApiCredentials();
        c.issueKey("K1", "01VEND1", PlanTier.STANDARD, EnumSet.of(Scope.ORDER_READ), T0);
        assertInstanceOf(AuthResult.Allowed.class, c.authorise("K1", Scope.ORDER_READ, "GET /orders", T0));

        assertInstanceOf(Outcome.Ok.class, c.revokeKey("K1", "credential leaked in a public repo", T0.plusSeconds(60)));

        var denied = assertInstanceOf(AuthResult.Denied.class,
                c.authorise("K1", Scope.ORDER_READ, "GET /orders", T0.plusSeconds(90)));
        assertEquals(401, denied.httpStatus());
        assertEquals("KEY_REVOKED", denied.code());

        // the refusal is in the usage log, recorded by the same call that refused it
        var log = c.usageLog("K1");
        assertEquals(2, log.size());
        assertEquals("KEY_REVOKED", log.get(1).code());
        assertEquals(T0.plusSeconds(90), log.get(1).at());
        assertEquals("GET /orders", log.get(1).operation());
    }

    @Test
    void scopesAreLeastPrivilegeAndBoundedByPlanTier() {
        var c = new ApiCredentials();
        // a sandbox key cannot obtain write authority
        var over = assertInstanceOf(Outcome.Rejected.class,
                c.issueKey("K-SB", "01VEND1", PlanTier.SANDBOX, EnumSet.of(Scope.CATALOGUE_WRITE), T0));
        assertTrue(over.violations().stream().anyMatch(x -> x.startsWith("SCOPE_NOT_IN_PLAN_TIER")));

        assertInstanceOf(Outcome.Ok.class,
                c.issueKey("K-SB", "01VEND1", PlanTier.SANDBOX, EnumSet.of(Scope.CATALOGUE_READ), T0));
        // settlement read is partner-only
        assertInstanceOf(Outcome.Rejected.class,
                c.issueKey("K-ST", "01VEND1", PlanTier.STANDARD, EnumSet.of(Scope.SETTLEMENT_READ), T0));
        assertInstanceOf(Outcome.Ok.class,
                c.issueKey("K-PT", "01PART1", PlanTier.PARTNER, EnumSet.of(Scope.SETTLEMENT_READ), T0));

        assertInstanceOf(Outcome.Rejected.class,
                c.issueKey("K-EMPTY", "01VEND1", PlanTier.STANDARD, Set.of(), T0));
    }

    @Test
    void aCallOutsideTheGrantedScopeIsForbiddenAndLogged() {
        var c = new ApiCredentials();
        c.issueKey("K2", "01VEND1", PlanTier.STANDARD, EnumSet.of(Scope.ORDER_READ), T0);
        var denied = assertInstanceOf(AuthResult.Denied.class,
                c.authorise("K2", Scope.CATALOGUE_WRITE, "POST /listings", T0));
        assertEquals(403, denied.httpStatus());
        assertEquals("SCOPE_NOT_GRANTED", denied.code());
        assertEquals("SCOPE_NOT_GRANTED", c.usageLog("K2").get(0).code());
    }

    @Test
    void keysExpireAfterTwelveMonthsWithRotationRemindersAtT30AndT7() {
        var c = new ApiCredentials();
        c.issueKey("K3", "01VEND1", PlanTier.STANDARD, EnumSet.of(Scope.ORDER_READ), T0);
        var k = c.key("K3");
        assertEquals(T0.plus(Duration.ofDays(365)), k.expiresAt());

        assertTrue(k.rotationRemindersDue(T0).isEmpty());
        assertEquals(List.of("T-30"), k.rotationRemindersDue(T0.plus(Duration.ofDays(340))));
        assertEquals(List.of("T-7"), k.rotationRemindersDue(T0.plus(Duration.ofDays(360))));
        assertTrue(k.rotationRemindersDue(T0.plus(Duration.ofDays(366))).isEmpty(), "expired keys stop nagging");

        assertInstanceOf(AuthResult.Allowed.class,
                c.authorise("K3", Scope.ORDER_READ, "GET /orders", T0.plus(Duration.ofDays(364))));
        var expired = assertInstanceOf(AuthResult.Denied.class,
                c.authorise("K3", Scope.ORDER_READ, "GET /orders", T0.plus(Duration.ofDays(365))));
        assertEquals("KEY_EXPIRED", expired.code());
    }

    @Test
    void revocationTakesPrecedenceOverExpiryInTheReportedReason() {
        var c = new ApiCredentials();
        c.issueKey("K4", "01VEND1", PlanTier.STANDARD, EnumSet.of(Scope.ORDER_READ), T0);
        c.revokeKey("K4", "offboarded partner", T0.plusSeconds(1));
        var denied = assertInstanceOf(AuthResult.Denied.class,
                c.authorise("K4", Scope.ORDER_READ, "GET /orders", T0.plus(Duration.ofDays(400))));
        assertEquals("KEY_REVOKED", denied.code(), "revoked is the honest reason, not expired");
    }

    @Test
    void revocationNeedsAReasonAndAnUnknownKeyIsRejected() {
        var c = new ApiCredentials();
        c.issueKey("K5", "01VEND1", PlanTier.STANDARD, EnumSet.of(Scope.ORDER_READ), T0);
        assertInstanceOf(Outcome.Rejected.class, c.revokeKey("K5", "  ", T0));
        assertInstanceOf(Outcome.Rejected.class, c.revokeKey("NOPE", "reason", T0));
        var unknown = assertInstanceOf(AuthResult.Denied.class,
                c.authorise("NOPE", Scope.ORDER_READ, "GET /orders", T0));
        assertEquals("KEY_UNKNOWN", unknown.code());
    }

    @Test
    void perKeyRateLimitComesFromThePlanTier() {
        var c = new ApiCredentials();
        c.issueKey("K6", "01VEND1", PlanTier.SANDBOX, EnumSet.of(Scope.ORDER_READ), T0);   // 60/min
        for (int i = 0; i < 60; i++) {
            assertInstanceOf(AuthResult.Allowed.class,
                    c.authorise("K6", Scope.ORDER_READ, "GET /orders", T0.plusMillis(i)), "call " + i);
        }
        var limited = assertInstanceOf(AuthResult.Denied.class,
                c.authorise("K6", Scope.ORDER_READ, "GET /orders", T0.plusMillis(61)));
        assertEquals(429, limited.httpStatus());
        assertEquals("RATE_LIMITED", limited.code());

        // the window slides: a minute later the budget is back
        assertInstanceOf(AuthResult.Allowed.class,
                c.authorise("K6", Scope.ORDER_READ, "GET /orders", T0.plus(Duration.ofMinutes(1)).plusMillis(1)));
    }

    // ------------------------------------------------------------ webhooks

    @Test
    void webhookMustBeHttpsWithASecretEventsAndAChallenge() {
        assertTrue(assertInstanceOf(SubscribeResult.Rejected.class, ApiCredentials.subscribe(
                "W1", "http://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), "tok"))
                .violations().contains("WEBHOOK_URL_MUST_BE_HTTPS"));

        assertTrue(assertInstanceOf(SubscribeResult.Rejected.class, ApiCredentials.subscribe(
                "W1", "https://partner.example/hook", "short", Set.of("order.confirmed.v1"), "tok"))
                .violations().contains("SIGNING_SECRET_TOO_SHORT"));

        assertTrue(assertInstanceOf(SubscribeResult.Rejected.class, ApiCredentials.subscribe(
                "W1", "https://partner.example/hook", SECRET, Set.of(), "tok"))
                .violations().contains("AT_LEAST_ONE_EVENT_TYPE_REQUIRED"));

        assertTrue(assertInstanceOf(SubscribeResult.Rejected.class, ApiCredentials.subscribe(
                "W1", "https://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), " "))
                .violations().contains("CHALLENGE_TOKEN_REQUIRED"));

        assertInstanceOf(SubscribeResult.Ok.class, ApiCredentials.subscribe(
                "W1", "https://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), "tok-123"));
    }

    @Test
    void ownershipIsProvenByEchoingTheExactChallengeToken() {
        var sub = assertInstanceOf(SubscribeResult.Ok.class, ApiCredentials.subscribe(
                "W2", "https://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), "tok-abc"))
                .subscription();
        assertFalse(sub.isVerified());
        assertFalse(sub.verifyOwnership("tok-wrong"));
        assertFalse(sub.isVerified());
        assertTrue(sub.verifyOwnership("tok-abc"));
        assertTrue(sub.isVerified());
    }

    @Test
    void retryLadderFollowsTheDocumentedScheduleThenDeadLetters() {
        var sub = assertInstanceOf(SubscribeResult.Ok.class, ApiCredentials.subscribe(
                "W3", "https://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), "tok"))
                .subscription();

        var expected = List.of(Duration.ofMinutes(1), Duration.ofMinutes(5), Duration.ofMinutes(30),
                Duration.ofHours(2), Duration.ofHours(6));
        assertEquals(expected, ApiCredentials.RETRY_LADDER);

        Instant t = T0;
        for (int i = 0; i < expected.size(); i++) {
            var r = assertInstanceOf(DeliveryOutcome.RetryAt.class, sub.recordAttempt(false, t));
            assertEquals(t.plus(expected.get(i)), r.when(), "delay for attempt " + (i + 1));
            assertEquals(i + 1, r.attempt());
            t = r.when();
        }
        // the ladder is exhausted: the next failure dead-letters
        var dead = assertInstanceOf(DeliveryOutcome.DeadLettered.class, sub.recordAttempt(false, t));
        assertEquals(6, dead.attempts());
        assertTrue(sub.isDeadLettered());
    }

    @Test
    void redriveClearsDeadLetterAndRestartsTheLadder() {
        var sub = assertInstanceOf(SubscribeResult.Ok.class, ApiCredentials.subscribe(
                "W4", "https://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), "tok"))
                .subscription();
        for (int i = 0; i < 6; i++) sub.recordAttempt(false, T0);
        assertTrue(sub.isDeadLettered());

        sub.redrive();
        assertFalse(sub.isDeadLettered());
        assertEquals(0, sub.attempts());
        var again = assertInstanceOf(DeliveryOutcome.RetryAt.class, sub.recordAttempt(false, T0));
        assertEquals(T0.plus(Duration.ofMinutes(1)), again.when(), "the ladder starts from the top");
    }

    @Test
    void successfulDeliveryReportsTheAttemptAndClearsDeadLetter() {
        var sub = assertInstanceOf(SubscribeResult.Ok.class, ApiCredentials.subscribe(
                "W5", "https://partner.example/hook", SECRET, Set.of("order.confirmed.v1"), "tok"))
                .subscription();
        sub.recordAttempt(false, T0);
        var ok = assertInstanceOf(DeliveryOutcome.Delivered.class, sub.recordAttempt(true, T0));
        assertEquals(2, ok.attempt());
        assertFalse(sub.isDeadLettered());
    }
}
