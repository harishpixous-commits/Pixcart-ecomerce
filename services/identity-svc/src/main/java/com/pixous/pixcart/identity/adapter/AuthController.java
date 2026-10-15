package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.security.JwtService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

/**
 * The {@code /api/auth} surface (Vol. 7 §7.4).
 *
 * <p>Request bodies are plain records: no bean validation annotations, because the rules that
 * matter are the domain's (password policy, login policy) and duplicating them as annotations
 * would give the same requirement two homes. A missing field is refused by
 * {@code AuthService} with a detail that names it.
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    // ------------------------------------------------------------------ request DTOs

    public record RegisterRequest(String email, String password, String fullName, String deviceLabel) {
    }

    public record LoginRequest(String email, String password, String deviceLabel) {
    }

    public record RefreshRequest(String refreshToken) {
    }

    public record StepUpRequest(String action, String code) {
    }

    public record IntrospectRequest(String token) {
    }

    public record CanRequest(String role, String capability) {
    }

    public record LogoutResponse(boolean revoked, String sessionId) {
    }

    // ------------------------------------------------------------------- endpoints

    /** FR-CUS-001. 201: the customer now exists, and is signed in. */
    @PostMapping("/register")
    public ResponseEntity<AuthService.AuthResponse> register(@RequestBody(required = false) RegisterRequest request,
                                                             HttpServletRequest http) {
        var command = new AuthService.RegisterCommand(
                request == null ? null : request.email(),
                request == null ? null : request.password(),
                request == null ? null : request.fullName(),
                request == null ? null : request.deviceLabel());
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(authService.register(command, clientIp(http), Instant.now()));
    }

    /** FR-CUS-002. */
    @PostMapping("/login")
    public AuthService.AuthResponse login(@RequestBody(required = false) LoginRequest request,
                                          HttpServletRequest http) {
        var command = new AuthService.LoginCommand(
                request == null ? null : request.email(),
                request == null ? null : request.password(),
                request == null ? null : request.deviceLabel());
        return authService.login(command, clientIp(http), Instant.now());
    }

    /** FR-CUS-003. Requires a live session, so the bearer filter has already vouched for it. */
    @PostMapping("/step-up")
    public AuthService.StepUpResponse stepUp(@RequestBody(required = false) StepUpRequest request,
                                             HttpServletRequest http) {
        JwtService.TokenPrincipal principal = Principals.require();
        var command = new AuthService.StepUpCommand(
                request == null ? null : request.action(),
                request == null ? null : request.code());
        return authService.stepUp(principal, command, clientIp(http), Instant.now());
    }

    /** Rotates the refresh token; a replay revokes the family (Vol. 10 §10.3). */
    @PostMapping("/refresh")
    public AuthService.AuthResponse refresh(@RequestBody(required = false) RefreshRequest request) {
        return authService.refresh(request == null ? null : request.refreshToken(), Instant.now());
    }

    /** Revokes the caller's session. */
    @PostMapping("/logout")
    public LogoutResponse logout(HttpServletRequest http) {
        JwtService.TokenPrincipal principal = Principals.require();
        authService.logout(principal.sessionId(), Instant.now());
        return new LogoutResponse(true, principal.sessionId());
    }

    @GetMapping("/me")
    public AuthService.MeView me() {
        return authService.me(Principals.require());
    }

    /**
     * RFC 7662-shaped introspection. The Node BFF calls this with the raw bearer token on
     * every request and treats anything non-2xx as "anonymous", so an inactive token is a
     * 200 with {@code active:false}, not a 401.
     */
    @PostMapping("/introspect")
    public AuthService.IntrospectResponse introspect(@RequestBody(required = false) IntrospectRequest request) {
        return authService.introspect(request == null ? null : request.token(), Instant.now());
    }

    /** The permission matrix, delegated to {@code Rbac} — the single source of truth. */
    @PostMapping("/can")
    public AuthService.CanResponse can(@RequestBody(required = false) CanRequest request) {
        if (request == null) {
            throw ApiException.badRequest(ApiException.MALFORMED_REQUEST, "a JSON body is required");
        }
        return authService.can(request.role(), request.capability());
    }

    /**
     * The address the throttle is keyed by. The direct peer address, not a forwarded header:
     * honouring {@code X-Forwarded-For} without a trusted-proxy configuration lets a caller
     * mint unlimited throttle budgets by editing a header.
     */
    private static String clientIp(HttpServletRequest http) {
        return http == null ? null : http.getRemoteAddr();
    }
}
