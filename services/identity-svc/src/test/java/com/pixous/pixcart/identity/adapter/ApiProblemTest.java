package com.pixous.pixcart.identity.adapter;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The failure contract. The Node BFF and the mobile clients key off {@code code}, so the
 * rendered shape is asserted literally rather than through a round-trip parse.
 */
class ApiProblemTest {

    @Test
    void rendersExactlyTheDocumentedFieldsInOrder() {
        ApiProblem problem = ApiProblem.of(429, "THROTTLED", "Too many requests",
                "auth endpoints accept at most 20 requests per minute per IP", "T-123");

        assertEquals(
                "{\"type\":\"urn:pixcart:error:THROTTLED\","
                        + "\"title\":\"Too many requests\","
                        + "\"status\":429,"
                        + "\"detail\":\"auth endpoints accept at most 20 requests per minute per IP\","
                        + "\"code\":\"THROTTLED\","
                        + "\"traceId\":\"T-123\"}",
                ProblemWriter.render(problem));
    }

    @Test
    void aDetailContainingJsonMetacharactersIsEscapedNotInjected() {
        ApiProblem problem = ApiProblem.of(400, "MALFORMED_REQUEST", "Bad request",
                "email must be \"someone@example.com\" or nothing", "T-1");

        String rendered = ProblemWriter.render(problem);
        assertTrue(rendered.contains("\\\"someone@example.com\\\""), rendered);
        assertEquals(1, count(rendered, '{'), "the document must still be a single object");
    }

    @Test
    void theProblemMediaTypeIsFixed() {
        assertEquals("application/problem+json", ProblemWriter.PROBLEM_JSON_VALUE);
        assertEquals("application/problem+json", ProblemWriter.PROBLEM_JSON.toString());
    }

    @Test
    void aProblemCarriesTheTraceIdFromTheRequestAttribute() throws IOException {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setAttribute(TraceId.REQUEST_ATTRIBUTE, "trace-abc");

        ApiProblem problem = ProblemWriter.of(request, 401, "TOKEN_INVALID", "Unauthenticated", "nope");
        assertEquals("trace-abc", problem.traceId());

        MockHttpServletResponse response = new MockHttpServletResponse();
        ProblemWriter.write(response, problem);

        assertEquals(401, response.getStatus());
        assertTrue(response.getContentType().startsWith("application/problem+json"), response.getContentType());
        assertTrue(response.getContentAsString().contains("\"traceId\":\"trace-abc\""));
    }

    @Test
    void aMissingTraceIdStaysNullRatherThanBeingInvented() {
        ApiProblem problem = ProblemWriter.of(new MockHttpServletRequest(), 500, "INTERNAL_ERROR",
                "Internal error", "boom");
        assertEquals(null, problem.traceId());
    }

    @Test
    void theTypeUrnEncodesTheCodeSoTheTwoCannotDiverge() {
        ApiProblem problem = ApiProblem.of(403, "E-AUTH-003", "Forbidden", "locked", "t");
        assertEquals(ApiProblem.TYPE_PREFIX + "E-AUTH-003", problem.type());
        assertEquals("E-AUTH-003", problem.code());
    }

    @Test
    void aProblemWithoutACodeCannotBeBuilt() {
        assertThrows(IllegalArgumentException.class, () -> ApiProblem.of(500, null, "t", "d", "t"));
        assertThrows(IllegalArgumentException.class, () -> ApiProblem.of(500, "  ", "t", "d", "t"));
    }

    private static int count(String haystack, char needle) {
        int n = 0;
        for (char c : haystack.toCharArray()) if (c == needle) n++;
        return n;
    }
}
