package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.repository.SessionRepository;
import com.pixous.pixcart.identity.security.JwtService;
import com.pixous.pixcart.identity.security.JwtVerificationException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

/**
 * Bearer boundary.
 *
 * <p>Two independent checks, both mandatory (FR-CUS-002):
 * <ol>
 *   <li>the JWT signature verifies under this service's key and its claims are complete and
 *       in-date — {@link JwtService#verify} refuses rather than defaults;</li>
 *   <li>the session the token names is still live — {@code id_session.revoked_at IS NULL},
 *       the persisted form of {@code SessionRegistry.isActive}.</li>
 * </ol>
 *
 * <p>Check 2 is why a 15-minute access token is not a 15-minute licence: logout, refresh-reuse
 * detection and session eviction all write {@code revoked_at}, and the next request carrying
 * that token is refused. A token presented on a public path is still checked — a bad token is
 * a bad token whether or not the endpoint needed it.
 *
 * <p>Instances are built inside {@code SecurityConfig} with {@code new} rather than declared
 * as beans, so Spring Boot does not also register this filter at the servlet container and
 * run it twice.
 */
public class BearerAuthenticationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(BearerAuthenticationFilter.class);
    private static final String BEARER = "Bearer ";

    private final JwtService jwtService;
    private final SessionRepository sessionRepository;

    public BearerAuthenticationFilter(JwtService jwtService, SessionRepository sessionRepository) {
        this.jwtService = jwtService;
        this.sessionRepository = sessionRepository;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || header.isBlank()) {
            chain.doFilter(request, response);
            return;
        }
        if (!header.startsWith(BEARER)) {
            reject(request, response, ApiException.TOKEN_MALFORMED,
                    "the Authorization header is not a Bearer token");
            return;
        }
        String token = header.substring(BEARER.length()).trim();
        if (token.isEmpty()) {
            reject(request, response, ApiException.TOKEN_MALFORMED, "the Bearer token is empty");
            return;
        }

        JwtService.TokenPrincipal principal;
        try {
            principal = jwtService.verify(token, Instant.now());
        } catch (JwtVerificationException e) {
            // e.getMessage() never identifies an account, so it cannot be used to probe.
            reject(request, response, ApiException.TOKEN_INVALID, "the access token was rejected: " + e.getMessage());
            return;
        }

        if (!sessionRepository.isActive(principal.sessionId())) {
            reject(request, response, ApiException.SESSION_INACTIVE,
                    "the session this token is bound to is no longer active");
            return;
        }

        var authentication = new UsernamePasswordAuthenticationToken(
                principal, null, List.of(new SimpleGrantedAuthority("ROLE_" + principal.role().name())));
        SecurityContextHolder.getContext().setAuthentication(authentication);
        try {
            chain.doFilter(request, response);
        } finally {
            // Never leak a principal into a pooled container thread.
            SecurityContextHolder.clearContext();
        }
    }

    private void reject(HttpServletRequest request, HttpServletResponse response,
                        String code, String detail) throws IOException {
        SecurityContextHolder.clearContext();
        log.debug("bearer rejected: {}", code);
        ProblemWriter.write(response, ProblemWriter.of(request, 401, code, "Unauthenticated", detail));
    }
}
