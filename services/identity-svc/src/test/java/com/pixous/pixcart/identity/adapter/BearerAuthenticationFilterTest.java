package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.rbac.Rbac;
import com.pixous.pixcart.identity.repository.SessionRepository;
import com.pixous.pixcart.identity.security.JwtService;
import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.Instant;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The bearer boundary, driven directly against {@code jakarta.servlet} mocks.
 *
 * <p>Both refusals are asserted as <em>401 problem+json</em> and as "the chain did not run",
 * because a filter that rejects but still lets the request through is worse than no filter.
 */
class BearerAuthenticationFilterTest {

    private static final String SECRET = "s3cr3t-s3cr3t-s3cr3t-s3cr3t-32bytes";
    private static final Instant NOW = Instant.now();

    private final JwtService jwt = new JwtService(SECRET);
    private final StubSessions sessions = new StubSessions();
    private final BearerAuthenticationFilter filter = new BearerAuthenticationFilter(jwt, sessions);

    @BeforeEach
    void installTraceId() {
        SecurityContextHolder.clearContext();
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void aRequestWithoutACredentialPassesThroughUntouched() throws Exception {
        Outcome outcome = call(filter, request(null), new MockFilterChain());

        assertTrue(outcome.chainRan);
        assertNull(SecurityContextHolder.getContext().getAuthentication());
    }

    @Test
    void aValidTokenForALiveSessionReachesTheChainWithAPrincipal() throws Exception {
        sessions.live.add("SESS-1");
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW.minusSeconds(2));

        // The principal exists only while the chain runs (the filter clears it afterwards),
        // so it is captured from inside the chain — the same place the application sees it.
        var seen = new java.util.concurrent.atomic.AtomicReference<Authentication>();
        Outcome outcome = callCapture(request("Bearer " + token), seen);

        assertTrue(outcome.chainRan);
        Authentication authentication = seen.get();
        assertNotNull(authentication, "the filter must establish the principal");
        JwtService.TokenPrincipal principal = assertInstanceOf(JwtService.TokenPrincipal.class,
                authentication.getPrincipal());
        assertEquals("CUST-1", principal.subject());
        assertEquals("SESS-1", principal.sessionId());
        assertTrue(authentication.getAuthorities().stream()
                .anyMatch(a -> a.getAuthority().equals("ROLE_CUSTOMER")));
        assertFalse(principal.isStepUpGrant());
        assertNull(SecurityContextHolder.getContext().getAuthentication(),
                "the context must be clean once the chain returns");
    }

    @Test
    void aRevokedSessionIsRefusedEvenThoughTheSignatureVerifies() throws Exception {
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW.minusSeconds(2));
        // deliberately NOT added to sessions.live

        MockHttpServletResponse response = new MockHttpServletResponse();
        Outcome outcome = call(filter, request("Bearer " + token), new MockFilterChain(), response);

        assertFalse(outcome.chainRan, "the request must not reach the application");
        assertEquals(401, response.getStatus());
        assertTrue(response.getContentType().startsWith("application/problem+json"), response.getContentType());
        assertTrue(response.getContentAsString().contains("\"code\":\"SESSION_INACTIVE\""),
                response.getContentAsString());
        assertNull(SecurityContextHolder.getContext().getAuthentication());
    }

    @Test
    void aGarbageTokenIsRefusedAsInvalid() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        Outcome outcome = call(filter, request("Bearer not.a.token"), new MockFilterChain(), response);

        assertFalse(outcome.chainRan);
        assertEquals(401, response.getStatus());
        assertTrue(response.getContentAsString().contains("\"code\":\"TOKEN_INVALID\""),
                response.getContentAsString());
    }

    @Test
    void anExpiredTokenIsRefused() throws Exception {
        sessions.live.add("SESS-1");
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER,
                NOW.minus(30, java.time.temporal.ChronoUnit.MINUTES));

        MockHttpServletResponse response = new MockHttpServletResponse();
        Outcome outcome = call(filter, request("Bearer " + token), new MockFilterChain(), response);

        assertFalse(outcome.chainRan);
        assertEquals(401, response.getStatus());
        assertTrue(response.getContentAsString().contains("\"code\":\"TOKEN_INVALID\""),
                response.getContentAsString());
    }

    @Test
    void aTokenSignedUnderAnotherKeyIsRefused() throws Exception {
        sessions.live.add("SESS-1");
        String token = new JwtService("some other 32-byte signing secret here!!")
                .signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW.minusSeconds(2));

        MockHttpServletResponse response = new MockHttpServletResponse();
        Outcome outcome = call(filter, request("Bearer " + token), new MockFilterChain(), response);

        assertFalse(outcome.chainRan);
        assertEquals(401, response.getStatus());
    }

    @Test
    void aNonBearerSchemeIsRefusedByName() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        Outcome outcome = call(filter, request("Basic dXNlcjpwYXNz"), new MockFilterChain(), response);

        assertFalse(outcome.chainRan);
        assertEquals(401, response.getStatus());
        assertTrue(response.getContentAsString().contains("\"code\":\"TOKEN_MALFORMED\""),
                response.getContentAsString());
    }

    @Test
    void anEmptyBearerTokenIsRefused() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        Outcome outcome = call(filter, request("Bearer    "), new MockFilterChain(), response);

        assertFalse(outcome.chainRan);
        assertEquals(401, response.getStatus());
        assertTrue(response.getContentAsString().contains("\"code\":\"TOKEN_MALFORMED\""),
                response.getContentAsString());
    }

    @Test
    void aBadTokenOnAPublicEndpointIsStillRefused() throws Exception {
        // A public path must not become a hole for presenting forged credentials.
        MockHttpServletRequest request = request("Bearer not.a.token");
        request.setRequestURI("/api/auth/can");
        MockHttpServletResponse response = new MockHttpServletResponse();

        Outcome outcome = call(filter, request, new MockFilterChain(), response);

        assertFalse(outcome.chainRan);
        assertEquals(401, response.getStatus());
    }

    @Test
    void aStepUpGrantIsAcceptedAsAPrincipalAndSaysWhatItIs() throws Exception {
        sessions.live.add("SESS-1");
        String token = jwt.signStepUpToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER,
                SessionRegistry.SensitiveAction.PASSWORD_CHANGE, NOW.minusSeconds(2));

        var seen = new java.util.concurrent.atomic.AtomicReference<Authentication>();
        Outcome outcome = callCapture(request("Bearer " + token), seen);

        assertTrue(outcome.chainRan);
        JwtService.TokenPrincipal principal = assertInstanceOf(JwtService.TokenPrincipal.class,
                seen.get().getPrincipal());
        assertTrue(principal.isStepUpGrant());
        assertEquals("PASSWORD_CHANGE", principal.stepUpAction());
    }

    @Test
    void thePrincipalNeverLeaksPastTheChain() throws Exception {
        sessions.live.add("SESS-1");
        String token = jwt.signAccessToken("CUST-1", "SESS-1", Rbac.Role.CUSTOMER, NOW.minusSeconds(2));
        FilterChain chain = (req, res) -> assertNotNull(SecurityContextHolder.getContext().getAuthentication());

        filter.doFilter(request("Bearer " + token), new MockHttpServletResponse(), chain);

        assertNull(SecurityContextHolder.getContext().getAuthentication(),
                "a pooled container thread must not inherit a principal");
    }

    // ----------------------------------------------------------------------- helpers

    private record Outcome(boolean chainRan) {
    }

    private Outcome call(jakarta.servlet.Filter filter, MockHttpServletRequest request) throws Exception {
        return call(filter, request, new MockFilterChain());
    }

    private Outcome call(jakarta.servlet.Filter filter, MockHttpServletRequest request,
                         MockFilterChain real) throws Exception {
        return call(filter, request, real, new MockHttpServletResponse());
    }

    private Outcome call(jakarta.servlet.Filter filter, MockHttpServletRequest request,
                         MockFilterChain real, MockHttpServletResponse response) throws Exception {
        if (request.getAttribute(TraceId.REQUEST_ATTRIBUTE) == null) {
            request.setAttribute(TraceId.REQUEST_ATTRIBUTE, "trace-test");
        }
        filter.doFilter(request, response, real);
        return new Outcome(real.getRequest() != null);
    }

    /** Runs the filter with a chain that snapshots the principal while it is live. */
    private Outcome callCapture(MockHttpServletRequest request,
                                java.util.concurrent.atomic.AtomicReference<Authentication> seen)
            throws Exception {
        request.setAttribute(TraceId.REQUEST_ATTRIBUTE, "trace-test");
        var ran = new java.util.concurrent.atomic.AtomicBoolean();
        FilterChain chain = (req, res) -> {
            seen.set(SecurityContextHolder.getContext().getAuthentication());
            ran.set(true);
        };
        filter.doFilter(request, new MockHttpServletResponse(), chain);
        return new Outcome(ran.get());
    }

    private static MockHttpServletRequest request(String authorization) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/auth/me");
        if (authorization != null) request.addHeader("Authorization", authorization);
        return request;
    }

    /** The filter's only dependency: is this session live? */
    private static final class StubSessions implements SessionRepository {
        private final Set<String> live = new java.util.HashSet<>();

        @Override
        public void insert(String sessionId, String principalType, String principalId,
                           String deviceLabel, Instant createdAt) {
            throw new UnsupportedOperationException();
        }

        @Override
        public java.util.Optional<SessionRecord> find(String sessionId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public boolean isActive(String sessionId) {
            return live.contains(sessionId);
        }

        @Override
        public void revoke(String sessionId, Instant revokedAt) {
            live.remove(sessionId);
        }

        @Override
        public void markReuseDetected(String sessionId, Instant at) {
            live.remove(sessionId);
        }

        @Override
        public int revokeOldestBeyondCap(String principalType, String principalId, int cap, Instant at) {
            throw new UnsupportedOperationException();
        }
    }
}
