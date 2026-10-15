package com.pixous.pixcart.identity.adapter;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;

import java.io.IOException;

/**
 * Renders an {@link ApiProblem} as {@code application/problem+json}.
 *
 * <p>One serialiser for every failure path — the filter, the security entry point and the
 * controller advice all route through here, so an unauthenticated request and a rejected
 * password produce byte-identical shapes apart from {@code code}/{@code detail}. There is
 * deliberately no "friendly" alternate rendering.
 */
public final class ProblemWriter {

    public static final MediaType PROBLEM_JSON = MediaType.parseMediaType("application/problem+json");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ProblemWriter() {
    }

    public static String render(ApiProblem problem) {
        try {
            return MAPPER.writeValueAsString(problem);
        } catch (JsonProcessingException e) {
            // A problem document that cannot be serialised is a programming error, not a
            // client error: fail loudly rather than emit a truncated or HTML body.
            throw new IllegalStateException("problem+json could not be serialised", e);
        }
    }

    /** Builds the problem with the trace id carried on the request by {@link TraceId}. */
    public static ApiProblem of(HttpServletRequest request, int status, String code, String title, String detail) {
        return ApiProblem.of(status, code, title, detail, traceIdOf(request));
    }

    public static String traceIdOf(HttpServletRequest request) {
        if (request == null) return null;
        Object attribute = request.getAttribute(TraceId.REQUEST_ATTRIBUTE);
        return (attribute instanceof String s) ? s : null;
    }

    public static void write(HttpServletResponse response, ApiProblem problem) throws IOException {
        response.setStatus(problem.status());
        response.setContentType(PROBLEM_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        response.getWriter().write(render(problem));
    }

    /** Kept as a String because {@code setContentType} must run before the writer is obtained. */
    static final String PROBLEM_JSON_VALUE = "application/problem+json";
}
