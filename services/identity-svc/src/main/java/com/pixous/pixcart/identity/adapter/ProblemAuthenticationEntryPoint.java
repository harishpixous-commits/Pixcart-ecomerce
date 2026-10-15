package com.pixous.pixcart.identity.adapter;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;

import java.io.IOException;

/**
 * Renders Spring Security's "you needed to be authenticated" as the same problem+json the
 * bearer filter produces, so a missing token and an invalid token are one contract.
 */
public class ProblemAuthenticationEntryPoint implements AuthenticationEntryPoint {

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response,
                         AuthenticationException authException) throws IOException {
        ProblemWriter.write(response, ProblemWriter.of(request, 401, ApiException.AUTH_REQUIRED,
                "Unauthenticated", "this endpoint requires a valid access token"));
    }
}
