package com.pixous.pixcart.identity.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;

import com.pixous.pixcart.identity.domain.auth.LoginPolicy;
import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.rbac.Rbac;

import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.time.Instant;
import java.util.Date;

/**
 * HS256 access tokens and step-up grants.
 *
 * Vol. 10 §10.3 issues an "Access JWT (15 min)"; FR-CUS-003 issues a "step-up grant
 * (10-min scope-bound token)". Both are minted here over the same key with the same
 * algorithm, and are distinguished by a single claim: a grant carries {@code act}
 * (the {@link SessionRegistry.SensitiveAction} it is bound to), an access token does not.
 *
 * <p>The key is {@code IDENTITY_JWT_SECRET} and there is deliberately no default.
 * A service that silently falls back to a built-in secret issues tokens anyone can forge,
 * so a missing or undersized secret is a <em>startup failure</em>, not a warning. HS256
 * requires a 256-bit key (RFC 7518 §3.2), hence the 32-byte floor.
 *
 * <p>{@link #verify} refuses rather than defaults: an unparseable token, an unexpected
 * {@code alg}, a bad signature, a past {@code exp}, a future {@code iat}, or any missing or
 * unrecognised claim throws. It never returns a partially-filled principal.
 */
public final class JwtService {

    /** RFC 7518 §3.2: HMAC SHA-256 requires a key of at least 256 bits. */
    public static final int MIN_SECRET_BYTES = 32;

    static final JWSAlgorithm ALGORITHM = JWSAlgorithm.HS256;

    public static final String CLAIM_SESSION = "sid";
    public static final String CLAIM_ROLE = "role";
    public static final String CLAIM_ACTION = "act";

    /** Which of the two token species was verified. */
    public enum TokenKind { ACCESS, STEP_UP }

    /**
     * A verified principal. {@code stepUpAction} is non-null only for {@link TokenKind#STEP_UP},
     * so a caller can never mistake an ordinary access token for a step-up grant.
     */
    public record TokenPrincipal(String subject, String sessionId, Rbac.Role role,
                                 TokenKind kind, String stepUpAction,
                                 Instant issuedAt, Instant expiresAt) {

        public boolean isStepUpGrant() {
            return kind == TokenKind.STEP_UP;
        }
    }

    private final byte[] keyBytes;

    /**
     * @param secret the raw {@code IDENTITY_JWT_SECRET} value
     * @throws IllegalStateException if the secret is absent, blank or shorter than
     *         {@value #MIN_SECRET_BYTES} bytes — the application must not start
     */
    public JwtService(String secret) {
        if (secret == null || secret.isBlank()) {
            throw new IllegalStateException(
                    "IDENTITY_JWT_SECRET is not set. Refusing to start: an identity service "
                            + "without a signing key would issue forgeable tokens.");
        }
        byte[] raw = secret.getBytes(StandardCharsets.UTF_8);
        if (raw.length < MIN_SECRET_BYTES) {
            throw new IllegalStateException(
                    "IDENTITY_JWT_SECRET must be at least " + MIN_SECRET_BYTES + " bytes for HS256 "
                            + "(RFC 7518 §3.2); got " + raw.length + ". Refusing to start.");
        }
        this.keyBytes = raw;
    }

    // ----------------------------------------------------------------- minting

    /** FR-CUS-002: access JWT valid for {@link SessionRegistry#ACCESS_TOKEN_TTL} (15 min). */
    public String signAccessToken(String subject, String sessionId, Rbac.Role role, Instant now) {
        requireMintable(subject, sessionId, role, now);
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject(subject)
                .claim(CLAIM_SESSION, sessionId)
                .claim(CLAIM_ROLE, role.name())
                .issueTime(Date.from(now))
                .expirationTime(Date.from(now.plus(SessionRegistry.ACCESS_TOKEN_TTL)))
                .build();
        return sign(claims);
    }

    /**
     * FR-CUS-003: a grant bound to ONE action on ONE session for
     * {@link SessionRegistry#STEP_UP_TTL} (10 min). The binding lives in the claims, so a
     * grant minted for PASSWORD_CHANGE cannot be presented as a PAYOUT_ACCOUNT_EDIT.
     */
    public String signStepUpToken(String subject, String sessionId, Rbac.Role role,
                                  SessionRegistry.SensitiveAction action, Instant now) {
        if (action == null) throw new IllegalArgumentException("action");
        requireMintable(subject, sessionId, role, now);
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .subject(subject)
                .claim(CLAIM_SESSION, sessionId)
                .claim(CLAIM_ROLE, role.name())
                .claim(CLAIM_ACTION, action.name())
                .issueTime(Date.from(now))
                .expirationTime(Date.from(now.plus(SessionRegistry.STEP_UP_TTL)))
                .build();
        return sign(claims);
    }

    private static void requireMintable(String subject, String sessionId, Rbac.Role role, Instant now) {
        if (subject == null || subject.isBlank()) throw new IllegalArgumentException("subject");
        if (sessionId == null || sessionId.isBlank()) throw new IllegalArgumentException("sessionId");
        if (role == null) throw new IllegalArgumentException("role");
        if (now == null) throw new IllegalArgumentException("now");
    }

    private String sign(JWTClaimsSet claims) {
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader(ALGORITHM), claims);
            jwt.sign(new MACSigner(keyBytes));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException("HS256 signing failed", e);
        }
    }

    // -------------------------------------------------------------- verification

    /**
     * Verify signature and claims, returning the principal.
     *
     * @throws JwtVerificationException for every rejection — the caller maps it to 401 and
     *         must not distinguish the reason to an anonymous caller beyond what
     *         {@code getMessage()} already says (which never identifies an account)
     */
    public TokenPrincipal verify(String token, Instant now) {
        if (now == null) throw new IllegalArgumentException("now");
        if (token == null || token.isBlank()) throw new JwtVerificationException("token is empty");

        SignedJWT jwt;
        try {
            jwt = SignedJWT.parse(token.trim());
        } catch (ParseException e) {
            throw new JwtVerificationException("token is not a compact JWS");
        }

        JWSHeader header = jwt.getHeader();
        // alg is pinned, never taken from the token: this is the "alg confusion" defence.
        if (!ALGORITHM.equals(header.getAlgorithm())) {
            throw new JwtVerificationException("unexpected JWS algorithm " + header.getAlgorithm());
        }
        try {
            if (!jwt.verify(new MACVerifier(keyBytes))) {
                throw new JwtVerificationException("signature does not verify");
            }
        } catch (JOSEException e) {
            throw new JwtVerificationException("signature could not be verified");
        }

        JWTClaimsSet claims;
        try {
            claims = jwt.getJWTClaimsSet();
        } catch (ParseException e) {
            throw new JwtVerificationException("claims are not readable");
        }

        String subject = claims.getSubject();
        if (subject == null || subject.isBlank()) throw new JwtVerificationException("sub claim is missing");

        String sessionId = stringClaim(claims, CLAIM_SESSION);
        if (sessionId == null || sessionId.isBlank()) throw new JwtVerificationException("sid claim is missing");

        String roleName = stringClaim(claims, CLAIM_ROLE);
        if (roleName == null) throw new JwtVerificationException("role claim is missing");
        Rbac.Role role;
        try {
            role = Rbac.Role.valueOf(roleName);
        } catch (IllegalArgumentException e) {
            throw new JwtVerificationException("role claim is not a known role");
        }

        Date issuedAtDate = claims.getIssueTime();
        Date expDate = claims.getExpirationTime();
        if (issuedAtDate == null) throw new JwtVerificationException("iat claim is missing");
        if (expDate == null) throw new JwtVerificationException("exp claim is missing");
        Instant issuedAt = issuedAtDate.toInstant();
        Instant expiresAt = expDate.toInstant();

        // Not-yet-valid and already-expired are both refusals, not leniencies.
        if (issuedAt.isAfter(now.plus(LoginPolicy.CLOCK_SKEW_TOLERANCE))) {
            throw new JwtVerificationException("iat is in the future");
        }
        if (!now.isBefore(expiresAt)) {
            throw new JwtVerificationException("token has expired");
        }

        String action = stringClaim(claims, CLAIM_ACTION);
        if (action == null) {
            return new TokenPrincipal(subject, sessionId, role, TokenKind.ACCESS, null, issuedAt, expiresAt);
        }
        SessionRegistry.SensitiveAction sensitive;
        try {
            sensitive = SessionRegistry.SensitiveAction.valueOf(action);
        } catch (IllegalArgumentException e) {
            throw new JwtVerificationException("act claim is not a known sensitive action");
        }
        return new TokenPrincipal(subject, sessionId, role, TokenKind.STEP_UP, sensitive.name(), issuedAt, expiresAt);
    }

    private static String stringClaim(JWTClaimsSet claims, String name) {
        try {
            return claims.getStringClaim(name);
        } catch (ParseException e) {
            throw new JwtVerificationException(name + " claim is not a string");
        }
    }
}
