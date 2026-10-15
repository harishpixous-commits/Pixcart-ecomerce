package com.pixous.pixcart.identity.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Runs a round trip against the database; any failure propagates and fails the health check. */
@Repository
public class JdbcSchemaProbe implements SchemaProbe {

    private final JdbcTemplate jdbc;

    public JdbcSchemaProbe(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void ping() {
        Integer one = jdbc.queryForObject("SELECT 1", Integer.class);
        if (one == null || one != 1) {
            throw new IllegalStateException("SELECT 1 returned " + one);
        }
    }
}
