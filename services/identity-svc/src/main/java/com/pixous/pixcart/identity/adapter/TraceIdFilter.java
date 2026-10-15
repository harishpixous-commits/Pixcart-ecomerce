package com.pixous.pixcart.identity.adapter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Runs before everything else, including the security chain, so that every later failure —
 * a rejected bearer token, a Spring Security 401, an unhandled exception — can carry the
 * same {@code traceId} and echo it back on {@code x-trace-id}.
 *
 * <p>Registered by Spring Boot as a servlet filter (not via {@code addFilterBefore}), which
 * is what keeps it outside the security chain and guarantees it runs exactly once.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String traceId = TraceId.resolve(request.getHeader(TraceId.HEADER));
        request.setAttribute(TraceId.REQUEST_ATTRIBUTE, traceId);
        response.setHeader(TraceId.HEADER, traceId);
        MDC.put("traceId", traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove("traceId");
        }
    }
}
