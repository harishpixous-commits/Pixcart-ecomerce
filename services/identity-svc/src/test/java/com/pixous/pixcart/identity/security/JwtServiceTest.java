package com.pixous.pixcart.identity.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.PlainJWT;
import com.nimbusds.jwt.SignedJWT;
import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Date;
import java.util.List;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The signing boundary, proved by round trip and by every refusal a forged token can reach.
 * No database and no Spring context: this is the piece that must be correct before anything
 * above it is worth testing.
 */
class JwtServiceTest {

    /** 32 bytes — exactly the HS256 floor, so a shorter secret is testable next to it. */
    private static final String SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-32bytes";
    private static final Instant NOW = Instant.parse("2026-10-11T10:00:00Z");

    private final JwtService jwt = new JwtService(SECRET);

    @Test
    void refusesToConstructWithoutASecret() {
        assertTrue(assertThrows(IllegalStateException.class, () -> new JwtService(null))
                .getMessage().contains("IDENTITY_JWT_SECRET"));
        assertTrue(assertThrows(IllegalStateException.class, () -> new JwtService("   "))
                .getMessage().contains("IDENTITY_JWT_SECRET"));
    }

    @Test
    void refusesASecretShorterThanTheHs256Floor() {
        assertTrue(assertThrows(IllegalStateException.class, () -> new JwtService("short"))
                .getMessage().contains("32"));
    }

    @Test
    void accessTokensCarryExactlyTheDocumentedClaims() throws Exception {
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW);
        JWTClaimsSet claims = SignedJWT.parse(token).getJWTClaimsSet();

        assertEquals(new TreeSet<>(List.of("exp", "iat", "role", "sid", "sub")),
                new TreeSet<>(claims.toJSONObject().keySet()));
        assertEquals("CUST-1", claims.getSubject());
        assertEquals("SESS-1", claims.getStringClaim("sid"));
        assertEquals("CUSTOMER", claims.getStringClaim("role"));
        assertEquals(Date.from(NOW), claims.getIssueTime());
        assertEquals(Date.from(NOW.plusSeconds(900)), claims.getExpirationTime());
    }

    @Test
    void accessTtlIsFifteenMinutes() {
        JwtService.TokenPrincipal principal = jwt.verify(
                jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.ADMIN, NOW), NOW.plusSeconds(1));

        assertEquals(Duration.ofMinutes(15), Duration.between(principal.issuedAt(), principal.expiresAt()));
        assertEquals(JwtService.TokenKind.ACCESS, principal.kind());
        assertFalse(principal.isStepUpGrant());
        assertEquals(Rbac.Role.ADMIN, principal.role());
    }

    @Test
    void stepUpGrantsAreTenMinutesAndBoundToAnAction() {
        JwtService.TokenPrincipal principal = jwt.verify(
                jwt.signStepUpToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER,
                        SessionRegistry.SensitiveAction.PAYOUT_ACCOUNT_EDIT, NOW),
                NOW.plusSeconds(1));

        assertTrue(principal.isStepUpGrant());
        assertEquals("PAYOUT_ACCOUNT_EDIT", principal.stepUpAction());
        assertEquals(Duration.ofMinutes(10), Duration.between(principal.issuedAt(), principal.expiresAt()));
    }

    @Test
    void aForgedSignatureIsRejected() {
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW);
        int dot = token.lastIndexOf('.');
        String forged = token.substring(0, dot + 1) + flipLastCharacter(token.substring(dot + 1));
        assertThrows(JwtVerificationException.class, () -> jwt.verify(forged, NOW.plusSeconds(1)));
    }

    @Test
    void aTokenSignedUnderAnotherKeyIsRejected() {
        JwtService other = new JwtService("an entirely different 32-byte secret!");
        String token = other.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW);
        assertThrows(JwtVerificationException.class, () -> jwt.verify(token, NOW.plusSeconds(1)));
    }

    @Test
    void anExpiredTokenIsRejected() {
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW);
        assertThrows(JwtVerificationException.class,
                () -> jwt.verify(token, NOW.plus(15, ChronoUnit.MINUTES)));
    }

    @Test
    void aTokenIssuedInTheFutureIsRejected() {
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW.plusSeconds(300));
        assertThrows(JwtVerificationException.class, () -> jwt.verify(token, NOW));
    }

    @Test
    void anHs512TokenIsRejectedEvenThoughTheKeyWouldVerifyIt() throws Exception {
        // HS512 needs a 64-byte key, so this token is minted under one — and verified at the
        // nimbus level below to prove the signature itself is sound. The service must still
        // refuse it: the algorithm is pinned, never read from the token.
        String longKey = "s".repeat(64);
        byte[] keyBytes = longKey.getBytes(StandardCharsets.UTF_8);
        SignedJWT hs512 = new SignedJWT(new JWSHeader(JWSAlgorithm.HS512), new JWTClaimsSet.Builder()
                .subject("CUST-1").claim("sid", "SESS-1").claim("role", "CUSTOMER")
                .issueTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(900))).build());
        hs512.sign(new MACSigner(keyBytes));
        assertTrue(hs512.verify(new MACVerifier(keyBytes)),
                "the token genuinely verifies under its own key; the refusal below is about alg");

        JwtService underSameKey = new JwtService(longKey);
        assertTrue(assertThrows(JwtVerificationException.class,
                        () -> underSameKey.verify(hs512.serialize(), NOW.plusSeconds(1)))
                .getMessage().contains("algorithm"));
    }

    @Test
    void anUnsignedJwtIsRejected() {
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject("CUST-1").claim("sid", "SESS-1").claim("role", "CUSTOMER")
                .issueTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(900))).build();
        assertThrows(JwtVerificationException.class,
                () -> jwt.verify(new PlainJWT(claims).serialize(), NOW.plusSeconds(1)));
    }

    @Test
    void aTokenWithAnUnknownRoleIsRejected() {
        String token = signManually(new JWTClaimsSet.Builder()
                .subject("CUST-1").claim("sid", "SESS-1").claim("role", "ROOT")
                .issueTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(900))));
        assertTrue(assertThrows(JwtVerificationException.class, () -> jwt.verify(token, NOW.plusSeconds(1)))
                .getMessage().contains("role"));
    }

    @Test
    void aTokenWithoutASessionIsRejected() {
        String token = signManually(new JWTClaimsSet.Builder()
                .subject("CUST-1").claim("role", "CUSTOMER")
                .issueTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(900))));
        assertTrue(assertThrows(JwtVerificationException.class, () -> jwt.verify(token, NOW.plusSeconds(1)))
                .getMessage().contains("sid"));
    }

    @Test
    void aStepUpGrantNamingAnUnknownActionIsRejected() {
        String token = signManually(new JWTClaimsSet.Builder()
                .subject("CUST-1").claim("sid", "SESS-1").claim("role", "CUSTOMER").claim("act", "ANYTHING")
                .issueTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(600))));
        assertThrows(JwtVerificationException.class, () -> jwt.verify(token, NOW.plusSeconds(1)));
    }

    @Test
    void garbageIsRejectedRatherThanDefaulted() {
        for (String junk : List.of("", "   ", "not-a-token", "a.b.c")) {
            assertThrows(JwtVerificationException.class, () -> jwt.verify(junk, NOW), junk);
        }
    }

    @Test
    void mintingRequiresACompletePrincipal() {
        assertThrows(IllegalArgumentException.class,
                () -> jwt.signAccessToken(null, "SESS-1", Rbac.Role.CUSTOMER, NOW));
        assertThrows(IllegalArgumentException.class,
                () -> jwt.signAccessToken("CUST-1", " ", Rbac.Role.CUSTOMER, NOW));
        assertThrows(IllegalArgumentException.class,
                () -> jwt.signAccessToken("CUST-1", "SESS-1", null, NOW));
        assertThrows(IllegalArgumentException.class,
                () -> jwt.signStepUpToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, null, NOW));
    }

    private String signManually(JWTClaimsSet.Builder claims) {
        try {
            SignedJWT signed = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims.build());
            signed.sign(new MACSigner(SECRET.getBytes(StandardCharsets.UTF_8)));
            return signed.serialize();
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static String flipLastCharacter(String s) {
        char last = s.charAt(s.length() - 1);
        return s.substring(0, s.length() - 1) + (last == 'A' ? 'B' : 'A');
    }
}
