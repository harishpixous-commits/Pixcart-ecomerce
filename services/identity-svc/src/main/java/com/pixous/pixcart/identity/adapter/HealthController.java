package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.repository.SchemaProbe;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

/**
 * Liveness that is allowed to be false.
 *
 * <p>{@code UP} is returned only after the database answered a real round trip. A health
 * endpoint that answers {@code UP} unconditionally is worse than none: it converts a database
 * outage into a green dashboard, which is exactly the fake success this codebase forbids.
 * When the probe fails the answer is 503 problem+json, so a load balancer takes the instance
 * out of rotation on evidence rather than on hope.
 */
@RestController
public class HealthController {

    public record HealthResponse(String service, String status, String database, String timestamp) {
    }

    private final SchemaProbe schemaProbe;

    public HealthController(SchemaProbe schemaProbe) {
        this.schemaProbe = schemaProbe;
    }

    @GetMapping("/api/health")
    public ResponseEntity<Object> health(HttpServletRequest request) {
        try {
            schemaProbe.ping();
        } catch (RuntimeException e) {
            ApiProblem problem = ProblemWriter.of(request, 503, ApiException.DEPENDENCY_UNAVAILABLE,
                    "Service unavailable", "the identity database did not answer SELECT 1");
            return ResponseEntity.status(503)
                    .contentType(ProblemWriter.PROBLEM_JSON)
                    .body(ProblemWriter.render(problem));
        }
        return ResponseEntity.ok(new HealthResponse("identity-svc", "UP", "UP", Instant.now().toString()));
    }
}
