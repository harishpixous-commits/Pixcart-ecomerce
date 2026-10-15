package com.pixous.pixcart.identity.security;

/** Raised when a presented bearer token is not acceptable. Never carries a "why" to the client. */
public class JwtVerificationException extends RuntimeException {

    public JwtVerificationException(String reason) {
        super(reason);
    }
}
