package com.pixous.pixcart.identity.security;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The storage rule of FR-CUS-001: Argon2id at m=64 MiB, t=3, p=2, per-user salt.
 *
 * <p>The parameters are asserted by parsing the encoded string rather than by trusting the
 * constants, because the whole point is that a library upgrade cannot quietly swap in
 * Spring's weaker defaults (m=19456, t=2, p=1).
 */
class PasswordHasherTest {

    private final PasswordHasher hasher = new PasswordHasher();

    @Test
    void encodesWithTheDocumentedArgon2idParameters() {
        String encoded = hasher.encode("Correct-Horse-9".toCharArray());

        assertTrue(encoded.startsWith("$argon2id$"), encoded);
        assertTrue(encoded.contains("m=65536,t=3,p=2"),
                "expected m=65536 KiB (64 MiB), t=3, p=2 but got: " + encoded);
    }

    @Test
    void theEncodedFormFitsTheVarchar128Column() {
        // id_customer.password_hash is VARBINARY(128); a hash that does not fit is a runtime
        // failure on the only write path that matters.
        String encoded = hasher.encode("Correct-Horse-9".toCharArray());
        assertTrue(encoded.getBytes(java.nio.charset.StandardCharsets.US_ASCII).length <= 128,
                "encoded length " + encoded.length());
    }

    @Test
    void aCorrectPasswordVerifiesAndAWrongOneDoesNot() {
        char[] right = "Correct-Horse-9".toCharArray();
        char[] wrong = "Correct-Horse-8".toCharArray();
        String encoded = hasher.encode(right);

        assertTrue(hasher.matches(right, encoded));
        assertFalse(hasher.matches(wrong, encoded));
    }

    @Test
    void everyHashUsesAFreshSalt() {
        char[] same = "Correct-Horse-9".toCharArray();
        assertNotEquals(hasher.encode(same), hasher.encode(same));
    }

    @Test
    void aMissingStoredHashIsNeverAKey() {
        // A customer row with a NULL password_hash is legal in V001 and must not authenticate.
        assertFalse(hasher.matches("anything".toCharArray(), null));
        assertFalse(hasher.matches("anything".toCharArray(), ""));
    }

    @Test
    void matchesRefusesInsteadOfDefaultingOnMalformedInput() {
        assertFalse(hasher.matches(null, "$argon2id$v=19$m=65536,t=3,p=2$aaaa$bbbb"));
        assertFalse(hasher.matches("pw".toCharArray(), null));
        assertThrows(IllegalArgumentException.class, () -> hasher.encode(null));
    }

    @Test
    void wipingTheCallerBufferRemovesThePlaintext() {
        char[] password = "Correct-Horse-9".toCharArray();
        String encoded = hasher.encode(password);
        PasswordHasher.wipe(password);

        assertEquals(0, password[0]);
        assertTrue(hasher.matches("Correct-Horse-9".toCharArray(), encoded));
    }
}
