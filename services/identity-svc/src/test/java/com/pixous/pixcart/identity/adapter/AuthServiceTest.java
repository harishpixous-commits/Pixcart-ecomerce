package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.auth.Totp;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import com.pixous.pixcart.identity.repository.MfaFactorRepository;
import com.pixous.pixcart.identity.security.JwtService;
import com.pixous.pixcart.identity.security.MfaSecretCipher;
import com.pixous.pixcart.identity.security.PasswordHasher;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The three flows over a persistent (in-memory) store. No database and no Spring context:
 * everything here runs offline, which is what keeps {@code mvn test} honest.
 */
class AuthServiceTest {

    private static final String SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-32bytes";
    private static final String GOOD_PASSWORD = "Correct-Horse-9";
    private static final String IP = "203.0.113.7";
    private static final Instant NOW = Instant.now();

    private final InMemoryIdentityStore store = new InMemoryIdentityStore();
    private final MfaSecretCipher cipher = new MfaSecretCipher(SECRET);
    private final AuthService service = new AuthService(store, store, store, store, store,
            new JwtService(SECRET), new PasswordHasher(), cipher);

    // --------------------------------------------------------------- FR-CUS-001

    @Test
    void registeringIssuesAUsableSessionAndTokenPair() {
        AuthService.AuthResponse response = register("alice@example.com", GOOD_PASSWORD, NOW);

        assertNotNull(response.accessToken());
        assertNotNull(response.refreshToken());
        assertEquals(Duration.ofMinutes(15).toMillis(), response.expiresInMs());
        assertEquals("CUSTOMER", response.user().role());
        assertEquals("alice@example.com", response.user().email());
        assertFalse(response.requiresStepUp(), "nothing is enrolled at registration");
        assertTrue(jwtService().verify(response.accessToken(), Instant.now()).sessionId().length() == 26);
    }

    @Test
    void eachPasswordRuleIsRefusedIndependently() {
        assertRejected("TOO_SHORT", "Ab1");
        assertRejected("INSUFFICIENT_CLASSES", "alllowercaseonly");
        assertRejected("TOO_LONG", "Aa1" + "x".repeat(126));
    }

    @Test
    void anAcceptedPasswordIsExactlyThePolicyMinimum() {
        // 10 chars, 3 classes: the boundary the policy names, and nothing more is required.
        AuthService.AuthResponse response = register("edge@example.com", "Abcdefgh1!", NOW);
        assertEquals("edge@example.com", response.user().email());
    }

    @Test
    void aTakenEmailAddressIsRefusedByName() {
        register("alice@example.com", GOOD_PASSWORD, NOW);
        ApiException e = assertThrows(ApiException.class,
                () -> register("ALICE@example.com", GOOD_PASSWORD, NOW));
        assertEquals(409, e.status());
        assertEquals(ApiException.EMAIL_ALREADY_REGISTERED, e.code());
    }

    // --------------------------------------------------------------- FR-CUS-002

    @Test
    void aWrongPasswordAndAnUnknownAccountAreIndistinguishable() {
        register("alice@example.com", GOOD_PASSWORD, NOW);

        ApiException wrongPassword = assertThrows(ApiException.class,
                () -> service.login(new AuthService.LoginCommand("alice@example.com", "nope-nope-nope", null), IP, NOW));
        ApiException unknown = assertThrows(ApiException.class,
                () -> service.login(new AuthService.LoginCommand("nobody@example.com", "nope-nope-nope", null), IP, NOW));

        assertEquals(401, wrongPassword.status());
        assertEquals(wrongPassword.code(), unknown.code());
        assertEquals(wrongPassword.getMessage(), unknown.getMessage(),
                "the two refusals must not reveal whether the account exists");
    }

    @Test
    void fiveFailuresLockTheAccountWithTheDocumentedCode() {
        register("alice@example.com", GOOD_PASSWORD, NOW);
        ApiException last = null;
        for (int i = 0; i < 5; i++) {
            last = assertThrows(ApiException.class,
                    () -> service.login(new AuthService.LoginCommand("alice@example.com", "nope-nope-nope", null), IP, NOW));
        }
        assertEquals(403, last.status());
        assertEquals("E-AUTH-003", last.code());
        assertTrue(last.getMessage().contains("/auth/password/reset"), last.getMessage());
    }

    @Test
    void aSuspendedAccountIsRefusedWithTheSupportPath() {
        register("alice@example.com", GOOD_PASSWORD, NOW);
        String id = store.findByEmailNorm("alice@example.com").orElseThrow().id();
        // SUSPENDED is one of the states ck_customer_status allows.
        store.markStatus(id, "SUSPENDED");

        ApiException e = assertThrows(ApiException.class,
                () -> service.login(new AuthService.LoginCommand("alice@example.com", GOOD_PASSWORD, null), IP, NOW));
        assertEquals("E-AUTH-004", e.code());
    }

    @Test
    void theTwentyFirstAuthCallFromOneIpIsThrottled() {
        ApiException last = null;
        for (int i = 0; i < 21; i++) {
            last = assertThrows(ApiException.class,
                    () -> service.login(new AuthService.LoginCommand("anyone@example.com", "nope-nope-nope", null), IP, NOW));
        }
        assertEquals(429, last.status());
        assertEquals(ApiException.THROTTLED, last.code());
    }

    @Test
    void aNinthLoginEvictsTheOldestSession() {
        register("alice@example.com", GOOD_PASSWORD, NOW);
        String customerId = store.findByEmailNorm("alice@example.com").orElseThrow().id();

        List<String> sessionIds = new ArrayList<>();
        for (int i = 0; i < SessionRegistry.MAX_CONCURRENT_SESSIONS; i++) {
            AuthService.AuthResponse next = service.login(
                    new AuthService.LoginCommand("alice@example.com", GOOD_PASSWORD, "device-" + i),
                    IP, NOW.plusSeconds(i + 1));
            sessionIds.add(jwtService().verify(next.accessToken(), Instant.now()).sessionId());
        }
        assertTrue(sessionIds.stream().allMatch(store::isActive), "8 live sessions before the ninth login");

        service.login(new AuthService.LoginCommand("alice@example.com", GOOD_PASSWORD, "device-9"), IP,
                NOW.plusSeconds(99));

        long live = sessionIds.stream().filter(store::isActive).count();
        assertEquals(SessionRegistry.MAX_CONCURRENT_SESSIONS - 1, live,
                "the oldest of the eight must be evicted when the ninth arrives");
        assertEquals(SessionRegistry.MAX_CONCURRENT_SESSIONS, store.countActiveFor(customerId),
                "the cap itself is never exceeded");
    }

    // --------------------------------------------------------------- refresh / logout

    @Test
    void refreshRotatesAndThePresentedTokenDies() {
        AuthService.AuthResponse first = register("alice@example.com", GOOD_PASSWORD, NOW);

        AuthService.AuthResponse second = service.refresh(first.refreshToken(), Instant.now());

        assertNotEquals(first.refreshToken(), second.refreshToken());
        assertNotEquals(first.accessToken(), second.accessToken());
        ApiException replay = assertThrows(ApiException.class,
                () -> service.refresh(first.refreshToken(), Instant.now()));
        assertEquals(ApiException.REFRESH_TOKEN_REUSE_DETECTED, replay.code());
    }

    @Test
    void reuseDetectionRevokesTheWholeFamilyNotJustThePresentedToken() {
        AuthService.AuthResponse first = register("alice@example.com", GOOD_PASSWORD, NOW);
        AuthService.AuthResponse second = service.refresh(first.refreshToken(), Instant.now());
        String sessionId = jwtService().verify(second.accessToken(), Instant.now()).sessionId();

        assertThrows(ApiException.class, () -> service.refresh(first.refreshToken(), Instant.now()));

        assertFalse(store.isActive(sessionId), "the session dies with the family");
        // The successor the attacker never saw is worthless too.
        ApiException successor = assertThrows(ApiException.class,
                () -> service.refresh(second.refreshToken(), Instant.now()));
        assertEquals(ApiException.REFRESH_TOKEN_INVALID, successor.code());
    }

    @Test
    void anExpiredRefreshTokenIsRefusedByName() {
        Instant longAgo = NOW.minus(Duration.ofDays(31));
        AuthService.AuthResponse response = register("alice@example.com", GOOD_PASSWORD, longAgo);

        ApiException e = assertThrows(ApiException.class, () -> service.refresh(response.refreshToken(), NOW));
        assertEquals(ApiException.REFRESH_TOKEN_EXPIRED, e.code());
    }

    @Test
    void anUnrecognisedRefreshTokenIsRefused() {
        ApiException e = assertThrows(ApiException.class,
                () -> service.refresh(AuthService.newOpaqueToken(), NOW));
        assertEquals(ApiException.REFRESH_TOKEN_INVALID, e.code());
    }

    @Test
    void logoutRevokesTheSessionSoTheAccessTokenStopsWorking() {
        AuthService.AuthResponse response = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(response.accessToken(), Instant.now());
        assertTrue(service.introspect(response.accessToken(), Instant.now()).active());

        service.logout(principal.sessionId(), Instant.now());

        assertFalse(service.introspect(response.accessToken(), Instant.now()).active());
        assertFalse(store.isActive(principal.sessionId()));
    }

    // --------------------------------------------------------------- introspect / can

    @Test
    void introspectionReportsInactiveRatherThanThrowing() {
        assertFalse(service.introspect("not-a-token", Instant.now()).active());
        assertFalse(service.introspect(null, Instant.now()).active());
    }

    @Test
    void onlyAStepUpGrantReportsStepUpSatisfied() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());
        enrolTotp(principal.subject());

        String proof = Totp.codeAt(secretFor(principal.subject()), Instant.now());
        AuthService.StepUpResponse grant = service.stepUp(principal,
                new AuthService.StepUpCommand("PASSWORD_CHANGE", proof), IP, Instant.now());

        assertFalse(service.introspect(access.accessToken(), Instant.now()).stepUpSatisfied());
        assertTrue(service.introspect(grant.stepUpToken(), Instant.now()).stepUpSatisfied());
    }

    @Test
    void canAnswersFromTheMatrixAndRefusesUnknownTerms() {
        assertEquals(new AuthService.CanResponse(true, "FULL"), service.can("CUSTOMER", "BROWSE_AND_PURCHASE"));
        assertEquals(new AuthService.CanResponse(false, "NONE"), service.can("CUSTOMER", "PRODUCT_APPROVAL"));
        assertEquals(new AuthService.CanResponse(true, "SCOPED"), service.can("CUSTOMER", "ORDER_MANAGEMENT"));

        assertEquals(ApiException.ROLE_UNKNOWN, assertThrows(ApiException.class,
                () -> service.can("ROOT", "BROWSE_AND_PURCHASE")).code());
        assertEquals(ApiException.CAPABILITY_UNKNOWN, assertThrows(ApiException.class,
                () -> service.can("CUSTOMER", "EVERYTHING")).code());
        assertEquals(ApiException.ROLE_UNKNOWN, assertThrows(ApiException.class,
                () -> service.can(null, "BROWSE_AND_PURCHASE")).code());
    }

    // ------------------------------------------------------------------ FR-CUS-003

    @Test
    void stepUpRefusesWhenNothingIsEnrolled() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());

        ApiException e = assertThrows(ApiException.class, () -> service.stepUp(principal,
                new AuthService.StepUpCommand("PASSWORD_CHANGE", "123456"), IP, Instant.now()));

        assertEquals(403, e.status());
        assertEquals("E-AUTH-011", e.code());
        assertTrue(e.getMessage().contains("no MFA factor is enrolled"), e.getMessage());
    }

    @Test
    void stepUpAcceptsAValidTotpCodeAndIssuesATenMinuteGrant() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());
        enrolTotp(principal.subject());

        String proof = Totp.codeAt(secretFor(principal.subject()), Instant.now());
        AuthService.StepUpResponse grant = service.stepUp(principal,
                new AuthService.StepUpCommand("payout_account_edit", proof), IP, Instant.now());

        assertEquals(Duration.ofMinutes(10).toMillis(), grant.validForMs());
        JwtService.TokenPrincipal verified = jwtService().verify(grant.stepUpToken(), Instant.now());
        assertEquals("PAYOUT_ACCOUNT_EDIT", verified.stepUpAction());
        assertEquals(principal.sessionId(), verified.sessionId());
        assertEquals(principal.subject(), verified.subject());
    }

    @Test
    void stepUpRejectsAWrongTotpCode() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());
        enrolTotp(principal.subject());

        Instant at = Instant.now();
        String secret = secretFor(principal.subject());
        long counter = Math.floorDiv(at.getEpochSecond(), Totp.DEFAULT_STEP.toSeconds());
        java.util.Set<String> accepted = java.util.Set.of(
                Totp.codeForCounter(Totp.decodeBase32(secret), counter - 1, Totp.DEFAULT_DIGITS),
                Totp.codeForCounter(Totp.decodeBase32(secret), counter, Totp.DEFAULT_DIGITS),
                Totp.codeForCounter(Totp.decodeBase32(secret), counter + 1, Totp.DEFAULT_DIGITS));
        // Deterministically outside the ±1-step window rather than merely unlikely to hit it.
        String wrong = "000000";
        while (accepted.contains(wrong)) {
            wrong = String.format("%06d", (Integer.parseInt(wrong) + 1) % 1_000_000);
        }
        final String definitelyWrong = wrong;

        ApiException e = assertThrows(ApiException.class, () -> service.stepUp(principal,
                new AuthService.StepUpCommand("PASSWORD_CHANGE", definitelyWrong), IP, at));
        assertEquals("E-AUTH-011", e.code());
    }

    @Test
    void stepUpRefusesAnActionTheRequirementDoesNotName() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());
        enrolTotp(principal.subject());

        ApiException e = assertThrows(ApiException.class, () -> service.stepUp(principal,
                new AuthService.StepUpCommand("WORLD_DOMINATION", "123456"), IP, Instant.now()));
        assertEquals(ApiException.STEP_UP_ACTION_UNKNOWN, e.code());
        assertTrue(e.getMessage().contains("PASSWORD_CHANGE"), e.getMessage());
    }

    @Test
    void aRecoveryCodeIsSingleUse() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());
        String code = "RECOV-0001-ABCD";
        enrolRecoveryCode(principal.subject(), code);

        assertNotNull(service.stepUp(principal,
                new AuthService.StepUpCommand("MOBILE_CHANGE", code), IP, Instant.now()).stepUpToken());

        ApiException second = assertThrows(ApiException.class, () -> service.stepUp(principal,
                new AuthService.StepUpCommand("MOBILE_CHANGE", code), IP, Instant.now()));
        // The spend left no active factor at all, so the second attempt is refused as
        // "nothing enrolled" — the refusal the spent row state produces, not a guess.
        assertEquals("E-AUTH-011", second.code());
        assertTrue(second.getMessage().contains("no MFA factor is enrolled"), second.getMessage());
    }

    @Test
    void stepUpOnARevokedSessionIsRefusedEvenWithAValidCode() {
        AuthService.AuthResponse access = register("alice@example.com", GOOD_PASSWORD, NOW);
        JwtService.TokenPrincipal principal = jwtService().verify(access.accessToken(), Instant.now());
        enrolTotp(principal.subject());
        service.logout(principal.sessionId(), Instant.now());

        String proof = Totp.codeAt(secretFor(principal.subject()), Instant.now());
        ApiException e = assertThrows(ApiException.class, () -> service.stepUp(principal,
                new AuthService.StepUpCommand("PASSWORD_CHANGE", proof), IP, Instant.now()));
        assertEquals(ApiException.SESSION_INACTIVE, e.code());
    }

    @Test
    void aMissingBodyIsNamedNotDefaulted() {
        assertEquals(ApiException.MALFORMED_REQUEST, assertThrows(ApiException.class,
                () -> service.register(null, IP, NOW)).code());
        assertEquals(ApiException.MALFORMED_REQUEST, assertThrows(ApiException.class,
                () -> service.login(new AuthService.LoginCommand(null, GOOD_PASSWORD, null), IP, NOW)).code());
        assertEquals(ApiException.MALFORMED_REQUEST, assertThrows(ApiException.class,
                () -> service.register(new AuthService.RegisterCommand("no-at-sign", GOOD_PASSWORD, "A", null), IP, NOW)).code());
        assertEquals(ApiException.MALFORMED_REQUEST, assertThrows(ApiException.class,
                () -> service.refresh(null, NOW)).code());
    }

    // --------------------------------------------------- staff and vendor sign-in (V008)

    @Test
    void aStaffRowWithACredentialSignsInAndClaimsItsOwnRole() {
        store.putStaff("01STAFF0000000000000000AA", "priya.desai@pixcart.example.in",
                "Priya Desai", "ADMIN", "ACTIVE", encoded("Correct-Horse-9"));

        AuthService.AuthResponse response = service.login(
                new AuthService.LoginCommand("PRIYA.DESAI@pixcart.example.in", GOOD_PASSWORD, "ops-laptop"),
                IP, NOW);

        assertEquals("ADMIN", response.user().role());
        assertEquals("priya.desai@pixcart.example.in", response.user().email());
        JwtService.TokenPrincipal principal = jwtService().verify(response.accessToken(), Instant.now());
        assertEquals(Rbac.Role.ADMIN, principal.role(), "the role claim must come from id_staff.role");
        assertEquals("01STAFF0000000000000000AA", principal.subject());
    }

    @Test
    void everyStaffRoleInTheSchemaIsReachableWithThatRoleClaim() {
        // ck_staff_role's vocabulary, transcribed: each of these must round-trip as itself,
        // because a token that claimed the wrong one would pass a different RBAC row.
        for (String role : List.of("ADMIN", "SUPER_ADMIN", "FINANCE", "MARKETING",
                "WAREHOUSE", "DELIVERY", "SUPPORT")) {
            store.putStaff("01STAFF" + role + "0000000000000", role.toLowerCase()
                            + "@pixcart.example.in", "A " + role, role, "ACTIVE", encoded(GOOD_PASSWORD));

            AuthService.AuthResponse response = service.login(
                    new AuthService.LoginCommand(role.toLowerCase() + "@pixcart.example.in",
                            GOOD_PASSWORD, null), IP, NOW.plusSeconds(role.length()));

            assertEquals(role, response.user().role());
        }
    }

    @Test
    void aStaffRowWithNoPasswordHashCannotSignIn() {
        // The V008 state of a row no operator has provisioned: the column is NULL.
        store.putStaff("01STAFF0000000000000000BB", "meera.joshi@pixcart.example.in",
                "Meera Joshi", "SUPPORT", "ACTIVE", null);

        ApiException unprovisioned = assertThrows(ApiException.class, () -> service.login(
                new AuthService.LoginCommand("meera.joshi@pixcart.example.in", GOOD_PASSWORD, null), IP, NOW));
        ApiException unknown = assertThrows(ApiException.class, () -> service.login(
                new AuthService.LoginCommand("nobody@nowhere.example.in", GOOD_PASSWORD, null), IP, NOW));

        assertEquals(401, unprovisioned.status());
        assertEquals(unknown.code(), unprovisioned.code());
        assertEquals(unknown.getMessage(), unprovisioned.getMessage(),
                "an unprovisioned account must be indistinguishable from one that does not exist");
    }

    @Test
    void aSuspendedStaffAccountIsRefusedWithTheSameCodeAsASuspendedCustomer() {
        store.putStaff("01STAFF0000000000000000CC", "kabir.sen@pixcart.example.in",
                "Kabir Sen", "MARKETING", "SUSPENDED", encoded(GOOD_PASSWORD));

        ApiException staff = assertThrows(ApiException.class, () -> service.login(
                new AuthService.LoginCommand("kabir.sen@pixcart.example.in", GOOD_PASSWORD, null), IP, NOW));

        register("alice@example.com", GOOD_PASSWORD, NOW);
        store.markStatus(store.findByEmailNorm("alice@example.com").orElseThrow().id(), "SUSPENDED");
        ApiException customer = assertThrows(ApiException.class, () -> service.login(
                new AuthService.LoginCommand("alice@example.com", GOOD_PASSWORD, null), IP, NOW.plusSeconds(1)));

        assertEquals("E-AUTH-004", staff.code());
        assertEquals(customer.code(), staff.code(),
                "one LoginPolicy means one code, whichever table the account is on");
        assertEquals(customer.getMessage(), staff.getMessage());
    }

    @Test
    void aVendorStoreSignsInAndClaimsTheVendorRole() {
        store.putStore("01VENDOR0000000000000000A", "Eco Essentials", "ops@ecoessentials.example.in",
                "+911140000001", "APPROVED", encoded(GOOD_PASSWORD));

        AuthService.AuthResponse response = service.login(
                new AuthService.LoginCommand("ops@ecoessentials.example.in", GOOD_PASSWORD, "vendor-portal"),
                IP, NOW);

        assertEquals("VENDOR", response.user().role());
        assertEquals("Eco Essentials", response.user().fullName());
        JwtService.TokenPrincipal principal = jwtService().verify(response.accessToken(), Instant.now());
        assertEquals(Rbac.Role.VENDOR, principal.role());
        assertEquals("01VENDOR0000000000000000A", principal.subject());
    }

    @Test
    void aNonApprovedVendorIsRefusedLikeAnyOtherInactiveAccount() {
        // PENDING is what ck_store_status allows but ACTIVE is not; a store still in KYC
        // review must not reach the vendor surface.
        store.putStore("01VENDOR0000000000000000B", "Urban Cart Probe", "ops@urbancart.example.in",
                "+911140000002", "PENDING", encoded(GOOD_PASSWORD));

        ApiException e = assertThrows(ApiException.class, () -> service.login(
                new AuthService.LoginCommand("ops@urbancart.example.in", GOOD_PASSWORD, null), IP, NOW));

        assertEquals("E-AUTH-004", e.code());
    }

    @Test
    void aCustomerAddressWinsWhenTheSameAddressIsAlsoOnAnotherTable() {
        // A provisioning mistake, not a lookup race: whichever row the operator meant, the
        // customer must keep their own account rather than silently acquiring a staff role.
        register("shared@example.com", GOOD_PASSWORD, NOW);
        store.putStaff("01STAFF0000000000000000DD", "shared@example.com",
                "Not A Customer", "ADMIN", "ACTIVE", encoded("Some-Other-Pass-1"));

        AuthService.AuthResponse response = service.login(
                new AuthService.LoginCommand("shared@example.com", GOOD_PASSWORD, null), IP, NOW);

        assertEquals("CUSTOMER", response.user().role(),
                "a customer must not acquire a staff role because an operator reused their address");
    }

    @Test
    void refreshReIssuesTheStaffRoleRatherThanTheOneTheTokenClaimed() {
        store.putStaff("01STAFF0000000000000000EE", "arnav.rao@pixcart.example.in",
                "Arnav Rao", "FINANCE", "ACTIVE", encoded(GOOD_PASSWORD));
        AuthService.AuthResponse first = service.login(
                new AuthService.LoginCommand("arnav.rao@pixcart.example.in", GOOD_PASSWORD, null), IP, NOW);

        AuthService.AuthResponse rotated = service.refresh(first.refreshToken(), Instant.now());

        assertEquals("FINANCE", rotated.user().role(), "rotation must not downgrade a staff principal to CUSTOMER");
        assertEquals(Rbac.Role.FINANCE,
                jwtService().verify(rotated.accessToken(), Instant.now()).role());
    }

    @Test
    void refreshReIssuesTheVendorRole() {
        store.putStore("01VENDOR0000000000000000C", "Tech Harbor", "ops@techharbor.example.in",
                "+911140000003", "APPROVED", encoded(GOOD_PASSWORD));
        AuthService.AuthResponse first = service.login(
                new AuthService.LoginCommand("ops@techharbor.example.in", GOOD_PASSWORD, null), IP, NOW);

        AuthService.AuthResponse rotated = service.refresh(first.refreshToken(), Instant.now());

        assertEquals("VENDOR", rotated.user().role());
    }

    @Test
    void meResolvesAStaffPrincipalFromItsRoleClaim() {
        store.putStaff("01STAFF0000000000000000FF", "deepa.verma@pixcart.example.in",
                "Deepa Verma", "WAREHOUSE", "ACTIVE", encoded(GOOD_PASSWORD));
        AuthService.AuthResponse login = service.login(
                new AuthService.LoginCommand("deepa.verma@pixcart.example.in", GOOD_PASSWORD, null), IP, NOW);

        AuthService.MeView me = service.me(jwtService().verify(login.accessToken(), Instant.now()));

        assertEquals("WAREHOUSE", me.role());
        assertEquals("Deepa Verma", me.profile().fullName());
        assertEquals(Rbac.Role.WAREHOUSE, Rbac.Role.valueOf(me.role()));
    }

    @Test
    void aStaffTokenCannotReadACustomerPrincipal() {
        // The role claim routes the lookup. A staff token whose subject is really a
        // customer id must fail to resolve, rather than reading the customer's profile
        // under the staff member's role.
        AuthService.AuthResponse customer = register("alice@example.com", GOOD_PASSWORD, NOW);
        store.putStaff("01STAFF0000000000000000GG", "me@pixcart.example.in",
                "Me", "ADMIN", "ACTIVE", encoded(GOOD_PASSWORD));
        JwtService.TokenPrincipal forged = new JwtService.TokenPrincipal(
                jwtService().verify(customer.accessToken(), Instant.now()).subject(),
                "01SESSION0000000000000000AA", Rbac.Role.ADMIN,
                JwtService.TokenKind.ACCESS, null, NOW, NOW.plusSeconds(900));

        ApiException e = assertThrows(ApiException.class, () -> service.me(forged));

        assertEquals(401, e.status());
        assertEquals(ApiException.PRINCIPAL_NOT_FOUND, e.code());
    }

    @Test
    void staffAndVendorSessionsAreCappedPerPrincipalNotGlobally() {
        // Verified against a fixed instant past every iat below: Argon2 makes this test take
        // several real seconds, so verifying against Instant.now() would reject the later
        // tokens as "iat is in the future".
        final Instant verifyAt = NOW.plusSeconds(120);
        store.putStore("01VENDOR0000000000000000D", "Nova Bazaar", "ops@novabazaar.example.in",
                "+911140000004", "APPROVED", encoded(GOOD_PASSWORD));
        List<String> vendorSessions = new ArrayList<>();
        for (int i = 0; i < SessionRegistry.MAX_CONCURRENT_SESSIONS; i++) {
            vendorSessions.add(jwtService().verify(service.login(
                    new AuthService.LoginCommand("ops@novabazaar.example.in", GOOD_PASSWORD, "d" + i),
                    IP, NOW.plusSeconds(i + 1)).accessToken(), verifyAt).sessionId());
        }
        register("alice@example.com", GOOD_PASSWORD, NOW.plusSeconds(100));

        assertTrue(vendorSessions.stream().allMatch(store::isActive),
                "a customer's session must not evict a vendor's, and vice versa: the cap is per (kind, id)");
        assertTrue(store.isActive(jwtService().verify(
                register("bob@example.com", GOOD_PASSWORD, NOW.plusSeconds(101)).accessToken(),
                verifyAt).sessionId()));
    }

    // ----------------------------------------------------------------------- helpers

    /** Encode with the real Argon2id hasher, so a test hash is a genuine credential. */
    private String encoded(String password) {
        return new PasswordHasher().encode(password.toCharArray());
    }

    private void assertRejected(String expectedViolation, String password) {
        ApiException e = assertThrows(ApiException.class, () -> register("x@example.com", password, NOW));
        assertEquals(400, e.status());
        assertEquals(ApiException.PASSWORD_POLICY_REJECTED, e.code());
        assertTrue(e.getMessage().contains(expectedViolation), e.getMessage());
    }

    private AuthService.AuthResponse register(String email, String password, Instant now) {
        return service.register(new AuthService.RegisterCommand(email, password, "A Customer", "laptop"), IP, now);
    }

    private JwtService jwtService() {
        return new JwtService(SECRET);
    }

    /** Test seam on the in-memory store so enrolment does not need an endpoint. */
    private final java.util.Map<String, String> totpSecrets = new java.util.HashMap<>();

    private void enrolTotp(String customerId) {
        String secret = Totp.newSecretBase32();
        totpSecrets.put(customerId, secret);
        store.enrol("CUSTOMER", customerId, new MfaFactorRepository.MfaFactorRecord(
                "totp", MfaFactorRepository.KIND_TOTP, cipher.encrypt(secret), null, null, null));
    }

    private String secretFor(String customerId) {
        return totpSecrets.get(customerId);
    }

    private void enrolRecoveryCode(String customerId, String plainCode) {
        List<String> sheet = new ArrayList<>();
        for (int i = 0; i < SessionRegistry.RECOVERY_CODE_COUNT; i++) {
            sheet.add(i == 0 ? plainCode : "RECOV-" + i + "-WXYZ");
        }
        // The domain issues exactly RECOVERY_CODE_COUNT codes or refuses; the sheet is what the
        // customer downloads once. Only the digest is persisted, in the domain's hex form.
        assertEquals(SessionRegistry.RECOVERY_CODE_COUNT,
                new SessionRegistry().issueRecoveryCodes(customerId, sheet).size());
        store.enrol("CUSTOMER", customerId, new MfaFactorRepository.MfaFactorRecord(
                "recovery", MfaFactorRepository.KIND_RECOVERY, null,
                AuthService.sha256Hex(plainCode), null, null));
    }
}
