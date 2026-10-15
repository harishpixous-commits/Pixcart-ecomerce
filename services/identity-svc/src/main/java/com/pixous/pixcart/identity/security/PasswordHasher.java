package com.pixous.pixcart.identity.security;

import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;

import java.util.Arrays;

/**
 * Argon2id password hashing — FR-CUS-001 storage rule and Vol. 10 §10.3.
 *
 * <p>The parameters are the documented ones, not the library defaults: Spring's
 * {@code Argon2PasswordEncoder()} defaults to m=19456 KiB, t=2, p=1, which is a weaker
 * configuration than the platform mandates. Here they are pinned to m=65536 KiB (64 MiB),
 * t=3, p=2 and asserted by test, so a dependency upgrade cannot silently weaken them.
 *
 * <p>{@link #matches} fails closed: a missing or empty stored hash is a non-match rather
 * than an automatic success, so a customer row with a NULL {@code password_hash}
 * (schema-legal in V001) can never authenticate.
 */
public final class PasswordHasher {

    public static final int MEMORY_KIB = 64 * 1024;   // m = 64 MiB
    public static final int ITERATIONS = 3;           // t = 3
    public static final int PARALLELISM = 2;          // p = 2
    public static final int SALT_BYTES = 16;
    public static final int HASH_BYTES = 32;

    private final Argon2PasswordEncoder encoder;

    public PasswordHasher() {
        // Spring's ctor is (saltLength, hashLength, parallelism, memoryLength, iterations) —
        // NOT (memory, iterations, parallelism, salt, hash). Passing the documented numbers in
        // the wrong order once made hashLength=3, which Argon2 rejects; pinned by test.
        this(new Argon2PasswordEncoder(SALT_BYTES, HASH_BYTES, PARALLELISM, MEMORY_KIB, ITERATIONS));
    }

    /** Visible for tests that need the real encoder with substituted cost parameters. */
    PasswordHasher(Argon2PasswordEncoder encoder) {
        this.encoder = encoder;
    }

    public String encode(char[] password) {
        if (password == null) throw new IllegalArgumentException("password");
        return encoder.encode(asCharSequence(password));
    }

    public boolean matches(char[] password, String storedHash) {
        if (password == null) return false;
        if (storedHash == null || storedHash.isEmpty()) return false;
        return encoder.matches(asCharSequence(password), storedHash);
    }

    /**
     * Spring's {@code PasswordEncoder} takes {@link CharSequence}, so the caller's
     * {@code char[]} is offered as a zero-copy view rather than being converted to a
     * {@code String}: the caller can still {@link #wipe} its own buffer afterwards. (The
     * library copies internally; that copy is outside this class's control and is why the
     * buffer is wiped at the call site rather than here.)
     */
    private static CharSequence asCharSequence(char[] password) {
        return new CharSequence() {
            @Override
            public int length() {
                return password.length;
            }

            @Override
            public char charAt(int index) {
                return password[index];
            }

            @Override
            public CharSequence subSequence(int start, int end) {
                return new String(password, start, end - start);
            }

            @Override
            public String toString() {
                return new String(password);
            }
        };
    }

    /**
     * Overwrite a caller-owned password buffer. Adapters wrap the request password in a
     * char[] and zero it in a finally block so the plaintext does not linger on the heap.
     */
    public static void wipe(char[] password) {
        if (password != null) Arrays.fill(password, '\0');
    }
}
