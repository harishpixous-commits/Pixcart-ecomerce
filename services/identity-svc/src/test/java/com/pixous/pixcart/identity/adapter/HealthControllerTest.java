package com.pixous.pixcart.identity.adapter;

import com.pixous.pixcart.identity.repository.SchemaProbe;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * {@code GET /api/health} against a real {@link SchemaProbe} implementation and a
 * deliberately failing one.
 *
 * <p>The failing case is the point of this endpoint: {@code UP} is only ever emitted after a
 * database round trip succeeded, so a dead database must surface as 503 problem+json and
 * never as a green health check.
 */
class HealthControllerTest {

    private static MockMvc mvc(SchemaProbe probe) {
        return MockMvcBuilders.standaloneSetup(new HealthController(probe))
                .setControllerAdvice(new GlobalProblemAdvice())
                .build();
    }

    @Test
    void aHealthyDatabaseIsReportedUp() throws Exception {
        mvc(() -> { })
                .perform(get("/api/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.service").value("identity-svc"))
                .andExpect(jsonPath("$.status").value("UP"))
                .andExpect(jsonPath("$.database").value("UP"))
                .andExpect(jsonPath("$.timestamp").isNotEmpty());
    }

    @Test
    void aFailingDatabaseIs503ProblemJsonNotAGreenLight() throws Exception {
        mvc(() -> { throw new IllegalStateException("connection refused"); })
                .perform(get("/api/health"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.code").value("DEPENDENCY_UNAVAILABLE"))
                .andExpect(jsonPath("$.status").value(503))
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("SELECT 1")));
    }

    @Test
    void aSlowFailureIsStillARefusalNotAnUp() throws Exception {
        // A probe that fails with a non-RuntimeException error is also "not UP": the controller
        // catches RuntimeException, so an Error would propagate — but an SQLException-style
        // RuntimeException (what JdbcTemplate actually throws) must refuse.
        mvc(() -> { throw new RuntimeException(new java.sql.SQLException(" Communications link failure")); })
                .perform(get("/api/health"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("DEPENDENCY_UNAVAILABLE"));
    }
}
