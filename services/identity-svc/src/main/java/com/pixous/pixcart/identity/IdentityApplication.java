package com.pixous.pixcart.identity;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Identity & Access service (C4-L2). Hexagonal layout: the {@code domain} package is
 * framework-free and fully unit-tested; adapters (REST controllers per Vol. 7 §7.4
 * /auth/*, JDBC repositories over the V001/V002 schema, Argon2id encoder, JWKS issuer)
 * attach in the application layer, built and integration-tested in CI (Vol. 11 §11.4).
 */
@SpringBootApplication
public class IdentityApplication {
    public static void main(String[] args) {
        SpringApplication.run(IdentityApplication.class, args);
    }
}
