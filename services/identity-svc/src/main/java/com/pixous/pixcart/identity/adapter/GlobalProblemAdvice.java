package com.pixous.pixcart.identity.adapter;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Every unhandled failure leaves this service as RFC 7807 problem+json.
 *
 * <p>There is no branch that returns a bare message body or Spring's default error page:
 * an unparseable JSON body, an unrouted path and an unexpected exception each become a
 * problem document with a {@code traceId}, so a client never has to guess which of three
 * response shapes it is holding.
 */
@RestControllerAdvice
public class GlobalProblemAdvice {

    private static final Logger log = LoggerFactory.getLogger(GlobalProblemAdvice.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<String> refused(ApiException e, HttpServletRequest request) {
        return respond(request, e.status(), e.code(), e.title(), e.getMessage());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<String> unreadable(HttpMessageNotReadableException e, HttpServletRequest request) {
        return respond(request, 400, ApiException.MALFORMED_REQUEST, "Bad request",
                "the request body is not readable JSON");
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<String> unrouted(NoResourceFoundException e, HttpServletRequest request) {
        return respond(request, 404, ApiException.NOT_FOUND, "Not found",
                "no handler is mapped for this path");
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> unexpected(Exception e, HttpServletRequest request) {
        // The exception itself is logged, never echoed: a stack trace in a response body is
        // a disclosure, and a client cannot act on it anyway.
        log.error("unhandled failure while serving {} {}", request.getMethod(), request.getRequestURI(), e);
        return respond(request, 500, ApiException.INTERNAL_ERROR, "Internal error",
                "the request could not be completed");
    }

    private ResponseEntity<String> respond(HttpServletRequest request, int status,
                                           String code, String title, String detail) {
        ApiProblem problem = ProblemWriter.of(request, status, code, title, detail);
        return ResponseEntity.status(status)
                .contentType(ProblemWriter.PROBLEM_JSON)
                .body(ProblemWriter.render(problem));
    }
}
