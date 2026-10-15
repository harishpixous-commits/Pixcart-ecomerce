package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.repository.SessionRepository;
import com.pixous.pixcart.identity.security.JwtService;
import com.pixous.pixcart.identity.security.MfaSecretCipher;
import com.pixous.pixcart.identity.security.PasswordHasher;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Stateless bearer security.
 *
 * <p>No CSRF: this API authenticates with a bearer header, never with a cookie, so a
 * cross-site form post cannot carry the credential. No session cookie either — the session
 * lives in {@code id_session} and is referenced by the JWT's {@code sid} claim, so the
 * servlet container holds nothing.
 *
 * <p>The protected set is only {@code /api/auth/me}, {@code /logout} and {@code /step-up}.
 * {@code introspect} and {@code can} are deliberately open: both answer questions about a
 * credential or a static matrix that the caller supplies, both fail closed, and the BFF
 * calls them without presenting a token of its own.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    /**
     * The signing key. The empty default exists only so the failure below is ours, with a
     * sentence that says what to set — Spring's own "not resolvable" message does not.
     * There is no fallback value: a default secret is a forgeable token.
     */
    @Bean
    public JwtService jwtService(@Value("${IDENTITY_JWT_SECRET:}") String secret) {
        return new JwtService(secret);
    }

    @Bean
    public MfaSecretCipher mfaSecretCipher(@Value("${IDENTITY_JWT_SECRET:}") String secret) {
        return new MfaSecretCipher(secret);
    }

    @Bean
    public PasswordHasher passwordHasher() {
        return new PasswordHasher();
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   JwtService jwtService,
                                                   SessionRepository sessionRepository) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(
                                "/error",
                                "/api/health",
                                "/api/auth/register",
                                "/api/auth/login",
                                "/api/auth/refresh",
                                "/api/auth/introspect",
                                "/api/auth/can")
                        .permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(exceptions -> exceptions
                        .authenticationEntryPoint(new ProblemAuthenticationEntryPoint()))
                .addFilterBefore(new BearerAuthenticationFilter(jwtService, sessionRepository),
                        UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }
}
