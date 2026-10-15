package com.pixous.pixcart.identity.adapter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pixous.pixcart.identity.domain.auth.Totp;
import com.pixous.pixcart.identity.repository.MfaFactorRepository;
import com.pixous.pixcart.identity.security.JwtService;
import com.pixous.pixcart.identity.security.MfaSecretCipher;
import com.pixous.pixcart.identity.security.PasswordHasher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Wire shape and status codes, on a standalone MockMvc: real controller, real service, real
 * JWT/Argon2/GCM, an in-memory store and no servlet container, datasource or network. That is
 * what keeps {@code mvn test} green offline while still asserting the exact JSON the Node BFF
 * parses.
 *
 * <p>The bearer filter is not in this chain (it has its own test); authenticated cases place
 * the principal in the {@code SecurityContextHolder} exactly as the filter would.
 */
class AuthControllerTest {

    private static final String SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-32bytes";
    private static final String PASSWORD = "Correct-Horse-9";
    private static final ObjectMapper JSON = new ObjectMapper();

    private InMemoryIdentityStore store;
    private MfaSecretCipher cipher;
    private JwtService jwt;
    private AuthService authService;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        store = new InMemoryIdentityStore();
        cipher = new MfaSecretCipher(SECRET);
        jwt = new JwtService(SECRET);
        authService = new AuthService(store, store, store, store, store, jwt, new PasswordHasher(), cipher);
        mvc = MockMvcBuilders.standaloneSetup(new AuthController(authService))
                .setControllerAdvice(new GlobalProblemAdvice())
                // In production this filter runs as a servlet filter; standalone MockMvc has
                // no container, so it is added explicitly — problem documents must carry a
                // traceId in tests exactly as they do in deployment.
                .addFilters(new TraceIdFilter())
                .build();
    }

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void registerReturnsCreatedWithTokensAndTheUser() throws Exception {
        mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"alice@example.com\",\"password\":\"" + PASSWORD
                                + "\",\"fullName\":\"Alice\",\"deviceLabel\":\"laptop\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.accessToken").isNotEmpty())
                .andExpect(jsonPath("$.refreshToken").isNotEmpty())
                .andExpect(jsonPath("$.expiresInMs").value(900000))
                .andExpect(jsonPath("$.requiresStepUp").value(false))
                .andExpect(jsonPath("$.user.email").value("alice@example.com"))
                .andExpect(jsonPath("$.user.role").value("CUSTOMER"))
                .andExpect(jsonPath("$.user.status").value("ACTIVE"));
    }

    @Test
    void aWeakPasswordIsRejectedAsProblemJsonNamingTheViolation() throws Exception {
        mvc.perform(post("/api/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"alice@example.com\",\"password\":\"abc\",\"fullName\":\"Alice\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("PASSWORD_POLICY_REJECTED"))
                .andExpect(jsonPath("$.detail").value(containsString("TOO_SHORT")))
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.type").value("urn:pixcart:error:PASSWORD_POLICY_REJECTED"))
                .andExpect(jsonPath("$.traceId").isNotEmpty());
    }

    @Test
    void aDuplicateRegistrationIsAConflict() throws Exception {
        String body = "{\"email\":\"alice@example.com\",\"password\":\"" + PASSWORD + "\",\"fullName\":\"Alice\"}";
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated());
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("EMAIL_ALREADY_REGISTERED"));
    }

    @Test
    void malformedJsonIsAProblemNotAStack() throws Exception {
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content("{not json"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("MALFORMED_REQUEST"));
    }

    @Test
    void loginReturnsTheDocumentedShape() throws Exception {
        register("alice@example.com").andExpect(status().isCreated());

        mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"alice@example.com\",\"password\":\"" + PASSWORD + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accessToken").isNotEmpty())
                .andExpect(jsonPath("$.refreshToken").isNotEmpty())
                .andExpect(jsonPath("$.expiresInMs").value(900000))
                .andExpect(jsonPath("$.requiresStepUp").value(false))
                .andExpect(jsonPath("$.user.email").value("alice@example.com"));
    }

    @Test
    void aBadLoginIs401WithTheDocumentedCode() throws Exception {
        register("alice@example.com").andExpect(status().isCreated());

        mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"alice@example.com\",\"password\":\"wrong-password-1\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E-AUTH-002"));
    }

    @Test
    void refreshRotatesTheTokenPair() throws Exception {
        String refreshToken = field(register("alice@example.com"), "refreshToken");

        mvc.perform(post("/api/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.refreshToken").isNotEmpty())
                .andExpect(jsonPath("$.accessToken").isNotEmpty());
    }

    @Test
    void introspectionIsOkEvenWhenInactiveSoTheBffCanTellInactiveFromDown() throws Exception {
        mvc.perform(post("/api/auth/introspect")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"garbage\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false))
                .andExpect(jsonPath("$.subject").doesNotExist())
                .andExpect(jsonPath("$.role").doesNotExist())
                .andExpect(jsonPath("$.sessionId").doesNotExist())
                .andExpect(jsonPath("$.stepUpSatisfied").value(false));

        String accessToken = field(register("alice@example.com"), "accessToken");
        mvc.perform(post("/api/auth/introspect")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"" + accessToken + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true))
                .andExpect(jsonPath("$.subject").isNotEmpty())
                .andExpect(jsonPath("$.role").value("CUSTOMER"))
                .andExpect(jsonPath("$.sessionId").isNotEmpty())
                .andExpect(jsonPath("$.stepUpSatisfied").value(false));
    }

    @Test
    void canDelegatesToTheMatrixAndRefusesUnknownTerms() throws Exception {
        mvc.perform(post("/api/auth/can")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"CUSTOMER\",\"capability\":\"BROWSE_AND_PURCHASE\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.permitted").value(true))
                .andExpect(jsonPath("$.access").value("FULL"));

        mvc.perform(post("/api/auth/can")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"CUSTOMER\",\"capability\":\"PRODUCT_APPROVAL\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.permitted").value(false))
                .andExpect(jsonPath("$.access").value("NONE"));

        mvc.perform(post("/api/auth/can")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"ROOT\",\"capability\":\"BROWSE_AND_PURCHASE\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("ROLE_UNKNOWN"));

        mvc.perform(post("/api/auth/can")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"CUSTOMER\",\"capability\":\"EVERYTHING\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("CAPABILITY_UNKNOWN"));
    }

    @Test
    void meRefusesWithoutAPrincipal() throws Exception {
        mvc.perform(get("/api/auth/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
    }

    @Test
    void meEchoesThePrincipalTheFilterEstablished() throws Exception {
        register("alice@example.com").andExpect(status().isCreated());
        AuthService.AuthResponse session = signIn();

        mvc.perform(get("/api/auth/me"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.subject").value(session.user().id()))
                .andExpect(jsonPath("$.sessionId").isNotEmpty())
                .andExpect(jsonPath("$.role").value("CUSTOMER"))
                .andExpect(jsonPath("$.profile.email").value("alice@example.com"));
    }

    @Test
    void stepUpRefusesWhenNoFactorIsEnrolled() throws Exception {
        register("alice@example.com").andExpect(status().isCreated());
        signIn();

        mvc.perform(post("/api/auth/step-up")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"PASSWORD_CHANGE\",\"code\":\"123456\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-AUTH-011"));
    }

    @Test
    void stepUpMintsAGrantForAValidTotpCode() throws Exception {
        register("alice@example.com").andExpect(status().isCreated());
        AuthService.AuthResponse session = signIn();
        String secret = enrolTotp(session.user().id());

        mvc.perform(post("/api/auth/step-up")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"PASSWORD_CHANGE\",\"code\":\""
                                + Totp.codeAt(secret, Instant.now()) + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stepUpToken").isNotEmpty())
                .andExpect(jsonPath("$.validForMs").value(600000));
    }

    @Test
    void stepUpRequiresAPrincipal() throws Exception {
        mvc.perform(post("/api/auth/step-up")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"PASSWORD_CHANGE\",\"code\":\"123456\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("AUTH_REQUIRED"));
    }

    @Test
    void logoutRevokesTheSessionForLaterCalls() throws Exception {
        register("alice@example.com").andExpect(status().isCreated());
        AuthService.AuthResponse session = signIn();

        String sessionId = jwt.verify(session.accessToken(), Instant.now()).sessionId();
        mvc.perform(post("/api/auth/logout"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.revoked").value(true))
                .andExpect(jsonPath("$.sessionId").value(sessionId));

        // The token from THAT session is dead now; introspection says so without a 401.
        mvc.perform(post("/api/auth/introspect")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"token\":\"" + session.accessToken() + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false));
    }

    // ----------------------------------------------------------------------- helpers

    private ResultActions register(String email) throws Exception {
        return mvc.perform(post("/api/auth/register")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"email\":\"" + email + "\",\"password\":\"" + PASSWORD
                        + "\",\"fullName\":\"A Customer\"}"));
    }

    /** Signs in and installs the principal exactly as {@code BearerAuthenticationFilter} would. */
    private AuthService.AuthResponse signIn() {
        AuthService.AuthResponse response = authService.login(
                new AuthService.LoginCommand("alice@example.com", PASSWORD, null), "127.0.0.1", Instant.now());
        JwtService.TokenPrincipal principal = jwt.verify(response.accessToken(), Instant.now());
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                principal, null, java.util.List.of()));
        return response;
    }

    private String enrolTotp(String customerId) {
        String secret = Totp.newSecretBase32();
        store.enrol("CUSTOMER", customerId, new MfaFactorRepository.MfaFactorRecord(
                "totp", MfaFactorRepository.KIND_TOTP, cipher.encrypt(secret), null, null, null));
        return secret;
    }

    /** Reads one field out of a controller response body without a second JSON library. */
    private String field(ResultActions actions, String name) throws Exception {
        String body = actions.andReturn().getResponse().getContentAsString();
        try {
            return JSON.readTree(body).get(name).asText();
        } catch (Exception e) {
            throw new AssertionError("cannot read " + name + " from " + body, e);
        }
    }
}
