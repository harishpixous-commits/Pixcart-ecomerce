package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.security.JwtService;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * Reads the principal the bearer filter established.
 *
 * <p>{@link #require()} throws rather than returning null or a synthetic anonymous principal:
 * an endpoint that forgot to be protected must fail closed, not quietly serve a default
 * caller. In the deployed filter chain this path is unreachable (Spring Security answers
 * first); it exists so the refusal is still correct — and testable — when the controller is
 * invoked without the chain.
 */
final class Principals {

    private Principals() {
    }

    static JwtService.TokenPrincipal require() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof JwtService.TokenPrincipal principal)) {
            throw ApiException.unauthorised(ApiException.AUTH_REQUIRED,
                    "this endpoint requires a valid access token");
        }
        return principal;
    }
}
