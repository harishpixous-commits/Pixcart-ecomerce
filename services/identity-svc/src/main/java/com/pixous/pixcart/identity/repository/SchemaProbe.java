package com.pixous.pixcart.identity.repository;

/**
 * A liveness probe for the identity database, used only by {@code GET /api/health}.
 *
 * <p>Kept as an interface so the health endpoint can be tested without a DataSource, and so
 * the endpoint cannot report {@code UP} without an affirmative round trip — a health check
 * that answers {@code UP} unconditionally is a fake success.
 */
public interface SchemaProbe {

    /** @throws RuntimeException if the database does not answer */
    void ping();
}
